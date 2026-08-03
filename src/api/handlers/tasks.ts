import type { ServerResponse } from 'node:http';
import type { ApiRequest } from '../middleware.js';
import { sendJson, sendNoContent, HttpError } from '../middleware.js';
import {
  createTask,
  getTask,
  listTasks,
  claimNextTask,
  claimTask,
  updateTaskStatus,
} from '../../db/queries/tasks.js';
import { latestSessionForTask, startSession, appendSessionOutput, finishSession } from '../../db/queries/sessions.js';
import { taskEvents } from '../../db/queries/events.js';
import { setAgentBusy } from '../../db/queries/agents.js';
import { TRANSITIONS, TERMINAL_STATUSES, PRIORITY_MIN, PRIORITY_MAX, DEFAULT_PRIORITY } from '../../shared/constants.js';
import type { Task, TaskStatus, TaskSource } from '../../shared/types.js';
import { enrichPromptWithMemories } from '../../memory/enrich.js';
import { distillTaskExperience } from '../../memory/distill.js';
import { logger } from '../../shared/logger.js';

/** 记忆富化是异步的：不阻塞创建响应 */
async function fireEnrich(task: Task): Promise<void> {
  try {
    const enriched = await enrichPromptWithMemories(task);
    if (enriched !== task.prompt) updateTaskPrompt(task.id, enriched);
  } catch (err) {
    // 记忆服务失败不影响主流程（文档 4.7 记忆沉淀独立写）
  }
}

import { getDb } from '../../db/index.js';
function updateTaskPrompt(taskId: string, prompt: string): void {
  getDb().prepare(`UPDATE tasks SET prompt = ? WHERE id = ?`).run(prompt, taskId);
}

function parsePriority(v: unknown): number {
  if (v === undefined) return DEFAULT_PRIORITY;
  const n = Number(v);
  if (!Number.isInteger(n) || n < PRIORITY_MIN || n > PRIORITY_MAX) {
    throw new HttpError(400, `priority must be integer in [${PRIORITY_MIN}, ${PRIORITY_MAX}]`);
  }
  return n;
}

function parseSource(v: unknown): TaskSource {
  if (v === undefined) return 'api';
  const s = String(v);
  if (!['api', 'slack', 'github', 'schedule'].includes(s)) throw new HttpError(400, 'invalid source');
  return s as TaskSource;
}

export const tasksHandlers = {
  /** POST /api/tasks 创建任务 */
  async create(req: ApiRequest, res: ServerResponse): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : null;
    const prompt = typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt.trim() : null;
    if (!title) throw new HttpError(400, 'title is required');
    if (!prompt) throw new HttpError(400, 'prompt is required');
    const tags = Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === 'string') : undefined;

    const task = createTask({
      title,
      prompt,
      priority: parsePriority(body.priority),
      source: parseSource(body.source),
      tags,
    });
    fireEnrich(task);
    sendJson(res, 201, task);
  },

  /** GET /api/tasks 任务列表 */
  list(req: ApiRequest, res: ServerResponse): void {
    const q = req.query!;
    const filter = {
      status: (q.get('status') as TaskStatus) || undefined,
      priority: q.get('priority') !== null ? Number(q.get('priority')) : undefined,
      source: (q.get('source') as TaskSource) || undefined,
      parent_id: q.get('parent_id'),
      page: q.get('page') ? Number(q.get('page')) : undefined,
      size: q.get('size') ? Number(q.get('size')) : undefined,
    };
    if (filter.status && !['unassigned','claimed','in_progress','completed','failed','superseded','stale'].includes(filter.status)) {
      throw new HttpError(400, 'invalid status');
    }
    sendJson(res, 200, listTasks(filter));
  },

  /** GET /api/tasks/:id 任务详情（含流转历史 + 最近 session） */
  detail(req: ApiRequest, res: ServerResponse): void {
    const task = getTask(req.params!.id);
    if (!task) throw new HttpError(404, 'NOT_FOUND');
    const history = taskEvents(task.id);
    const session = latestSessionForTask(task.id);
    sendJson(res, 200, { task, history, session });
  },

  /** POST /api/tasks/next Worker 原子领取 */
  async claimNext(req: ApiRequest, res: ServerResponse): Promise<void> {
    const agentId = req.agentId!;
    const task = claimNextTask(agentId);
    if (!task) return sendNoContent(res);
    setAgentBusy(agentId, task.id);
    sendJson(res, 200, { task });
  },

  /** POST /api/tasks/:id/claim 手动认领指定任务 */
  claim(req: ApiRequest, res: ServerResponse): void {
    const agentId = req.agentId!;
    const task = claimTask(req.params!.id, agentId);
    setAgentBusy(agentId, task.id);
    sendJson(res, 200, { task });
  },

  /** PATCH /api/tasks/:id/status 状态迁移 + 上报结果 */
  updateStatus(req: ApiRequest, res: ServerResponse): void {
    const taskId = req.params!.id;
    const task = getTask(taskId);
    if (!task) throw new HttpError(404, 'NOT_FOUND');

    const body = (req.body ?? {}) as Record<string, unknown>;
    const to = body.status as TaskStatus;
    if (!to || !(to in TRANSITIONS)) throw new HttpError(400, 'invalid status');

    // 终态不可再改
    if (TERMINAL_STATUSES.includes(task.status)) throw new HttpError(409, 'ALREADY_TERMINAL');

    // 合法迁移校验
    if (!TRANSITIONS[task.status].includes(to)) {
      throw new HttpError(409, `INVALID_TRANSITION: ${task.status} -> ${to}`);
    }

    // 归属校验：claimed/in_progress 只允许当前认领 agent 上报
    if ((task.status === 'claimed' || task.status === 'in_progress') && req.agentId !== task.agent_id) {
      throw new HttpError(403, 'NOT_OWNER');
    }

    if (to === 'completed' && typeof body.result !== 'string') {
      throw new HttpError(400, 'result is required for completed');
    }
    if (to === 'failed' && typeof body.error !== 'string') {
      throw new HttpError(400, 'error is required for failed');
    }

    // in_progress：先推进状态机（claimed→in_progress），再建 session，
    // 日志增量追加到 session 输出（Worker 流式上报）
    if (to === 'in_progress' && req.agentId) {
      if (task.status !== 'in_progress') {
        updateTaskStatus({ taskId, status: 'in_progress', agentId: req.agentId });
      }
      let session = latestSessionForTask(taskId);
      if (!session) {
        session = startSession({ task_id: taskId, agent_id: req.agentId });
      }
      if (typeof body.log === 'string' && body.log) {
        appendSessionOutput(session.id, body.log);
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    const updated = updateTaskStatus({
      taskId,
      status: to,
      result: to === 'completed' ? (body.result as string) : undefined,
      error: to === 'failed' ? (body.error as string) : undefined,
    });

    // 终态时收尾 session + 异步沉淀记忆
    if (to === 'completed' || to === 'failed') {
      const session = latestSessionForTask(taskId);
      if (session && !session.finished_at) {
        finishSession(session.id, to === 'completed' ? 0 : 1);
      }
      if (to === 'completed' && updated.result) {
        const sessionOut = session?.output ?? '';
        // 独立写，失败不影响主流程
        void distillTaskExperience({
          taskId,
          taskTitle: updated.title,
          taskPrompt: updated.prompt,
          output: sessionOut,
          result: updated.result,
        }).catch(() => {});
      }
    }
    sendJson(res, 200, { task: updated });
  },
};
