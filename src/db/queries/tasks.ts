import { getDb, withTransaction, newId, nowIso } from '../index.js';
import type { Task, TaskStatus, TaskSource } from '../../shared/types.js';
import { TRANSITIONS, TERMINAL_STATUSES } from '../../shared/constants.js';
import { insertEvent } from './events.js';

/**
 * 任务全部 SQL 封装。认领/重派等涉及状态竞争的操作一律包在
 * withTransaction（BEGIN IMMEDIATE）里，用 UPDATE ... WHERE status 的影响行数判胜。
 */

const COLS = `id, title, prompt, parent_id, status, priority, agent_id,
  assign_count, result, error, source, tags, attachments, created_at, claimed_at, started_at, finished_at`;

export interface CreateTaskInput {
  title: string;
  prompt: string;
  parent_id?: string | null;
  priority?: number;
  source?: TaskSource;
  tags?: string[];
  attachments?: string[];
}

let lastCreatedMs = 0;
let createdSeq = 0;

/** 单调递增的时间戳字符串：同毫秒内追加序号，保证 created_at 严格递增（FIFO 确定性） */
function monotonicIso(): string {
  const now = Date.now();
  if (now === lastCreatedMs) createdSeq++;
  else {
    lastCreatedMs = now;
    createdSeq = 0;
  }
  const iso = new Date(now).toISOString();
  return createdSeq === 0 ? iso : `${iso.slice(0, 19)}.${String(createdSeq).padStart(6, '0')}Z`;
}

export function createTask(input: CreateTaskInput): Task {
  return withTransaction(() => {
    const row: Task = {
      id: newId(),
      title: input.title,
      prompt: input.prompt,
      parent_id: input.parent_id ?? null,
      status: 'unassigned',
      priority: input.priority ?? 5,
      agent_id: null,
      assign_count: 0,
      result: null,
      error: null,
      source: input.source ?? 'api',
      tags: input.tags ? JSON.stringify(input.tags) : null,
      attachments: input.attachments && input.attachments.length > 0 ? JSON.stringify(input.attachments) : null,
      created_at: monotonicIso(),
      claimed_at: null,
      started_at: null,
      finished_at: null,
    };
    getDb()
      .prepare(
        `INSERT INTO tasks (${COLS}) VALUES (
          ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        row.id, row.title, row.prompt, row.parent_id, row.status, row.priority,
        row.agent_id, row.assign_count, row.result, row.error, row.source,
        row.tags, row.attachments, row.created_at, row.claimed_at, row.started_at, row.finished_at
      );
    insertEvent({ task_id: row.id, type: 'task_created', payload: { title: row.title, source: row.source } });
    return row;
  });
}

export function getTask(id: string): Task | null {
  const row = getDb().prepare(`SELECT ${COLS} FROM tasks WHERE id = ?`).get(id);
  return (row as unknown as Task | undefined) ?? null;
}

export interface TaskFilter {
  status?: TaskStatus;
  priority?: number;
  parent_id?: string | null;
  source?: TaskSource;
  page?: number;
  size?: number;
}

export function listTasks(filter: TaskFilter): { tasks: Task[]; total: number } {
  const d = getDb();
  const conds: string[] = [];
  const params: (string | number | null)[] = [];
  if (filter.status) { conds.push('status = ?'); params.push(filter.status); }
  if (filter.priority !== undefined) { conds.push('priority = ?'); params.push(filter.priority); }
  if (filter.source) { conds.push('source = ?'); params.push(filter.source); }
  if (filter.parent_id === null) conds.push('parent_id IS NULL');
  else if (filter.parent_id !== undefined) { conds.push('parent_id = ?'); params.push(filter.parent_id); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const page = filter.page ?? 1;
  const size = Math.min(filter.size ?? 50, 200);
  const offset = (page - 1) * size;

  const total = (d.prepare(`SELECT COUNT(*) AS n FROM tasks ${where}`).get(...params) as unknown as { n: number }).n;
  const rows = d
    .prepare(`SELECT ${COLS} FROM tasks ${where} ORDER BY status = 'unassigned' DESC, priority ASC, created_at ASC LIMIT ? OFFSET ?`)
    .all(...params, size, offset) as unknown as Task[];
  return { tasks: rows, total };
}

/** 原子领取下一个可执行任务（文档 5.5 伪代码落地） */
export function claimNextTask(agentId: string): Task | null {
  return withTransaction(() => {
    // 1. 事务内先选一个候选（id 作次级排序保证同毫秒创建时顺序确定）
    const candidate = getDb()
      .prepare(
        `SELECT id FROM tasks
         WHERE status = 'unassigned'
         ORDER BY priority ASC, created_at ASC, id ASC
         LIMIT 1`
      )
      .get() as unknown as { id: string } | undefined;
    if (!candidate) return null;

    // 2. 条件更新：影响行数=1 表示抢到；=0 表示已被并发抢走，重试
    for (;;) {
      const res = getDb()
        .prepare(
          `UPDATE tasks SET status = 'claimed', agent_id = ?, claimed_at = ?, assign_count = assign_count + 1
           WHERE id = ? AND status = 'unassigned'`
        )
        .run(agentId, nowIso(), candidate.id);
      if (res.changes === 1) break;
      // 被抢走：重新选（同一事务内）
      const next = getDb()
        .prepare(
          `SELECT id FROM tasks WHERE status = 'unassigned' ORDER BY priority ASC, created_at ASC, id ASC LIMIT 1`
        )
        .get() as unknown as { id: string } | undefined;
      if (!next) return null;
      // 更新 candidate，继续循环
      Object.assign(candidate, next);
    }

    const task = getTask(candidate.id)!;
    insertEvent({ task_id: task.id, agent_id: agentId, type: 'task_claimed', payload: { title: task.title } });
    return task;
  });
}

/** 手动认领指定任务（PATCH 前的辅助） */
export function claimTask(taskId: string, agentId: string): Task {
  return withTransaction(() => {
    const res = getDb()
      .prepare(
        `UPDATE tasks SET status = 'claimed', agent_id = ?, claimed_at = ?, assign_count = assign_count + 1
         WHERE id = ? AND status = 'unassigned'`
      )
      .run(agentId, nowIso(), taskId);
    if (res.changes !== 1) throw new Error('TASK_NOT_CLAIMABLE');
    const task = getTask(taskId)!;
    insertEvent({ task_id: taskId, agent_id: agentId, type: 'task_claimed', payload: { title: task.title } });
    return task;
  });
}

/**
 * 状态迁移（Worker 上报/清扫器/Lead 调用）。
 * 状态机合法性在 db 层强制（深层防御），handler 层保留友好 HTTP 校验。
 */
export function updateTaskStatus(input: {
  taskId: string;
  status: TaskStatus;
  result?: string | null;
  error?: string | null;
  agentId?: string | null;
  supersededBy?: string;
}): Task {
  return withTransaction(() => {
    const task = getTask(input.taskId);
    if (!task) throw new Error('NOT_FOUND');

    // 状态机守门：非法迁移 / 终态再改 / 非当前 agent 上报，一律拒绝
    if (TERMINAL_STATUSES.includes(task.status)) throw new Error('ALREADY_TERMINAL');
    if (!TRANSITIONS[task.status].includes(input.status)) {
      throw new Error(`INVALID_TRANSITION: ${task.status} -> ${input.status}`);
    }
    if (
      (task.status === 'claimed' || task.status === 'in_progress') &&
      input.agentId !== undefined &&
      input.agentId !== task.agent_id
    ) {
      throw new Error('NOT_OWNER');
    }

    const d = getDb();
    const sets: string[] = ['status = ?'];
    const params: (string | null)[] = [input.status];

    if (input.result !== undefined) { sets.push('result = ?'); params.push(input.result); }
    if (input.error !== undefined) { sets.push('error = ?'); params.push(input.error); }
    if (input.agentId !== undefined) { sets.push('agent_id = ?'); params.push(input.agentId); }

    if (input.status === 'in_progress' && !task.started_at) {
      sets.push('started_at = ?');
      params.push(nowIso());
    }
    if (['completed', 'failed', 'superseded'].includes(input.status)) {
      sets.push('finished_at = ?');
      params.push(nowIso());
    }
    if (input.status === 'completed') sets.push('error = NULL');
    if (input.status === 'failed') sets.push('result = NULL');

    params.push(input.taskId);
    d.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);

    const updated = getTask(input.taskId)!;
    const type = eventTypeFor(input.status);
    if (type) {
      insertEvent({
        task_id: input.taskId,
        agent_id: input.agentId ?? task.agent_id,
        type,
        payload: {
          status: input.status,
          ...(input.result ? { result_len: input.result.length } : {}),
          ...(input.error ? { error: input.error.slice(0, 200) } : {}),
          ...(input.supersededBy ? { supersededBy: input.supersededBy } : {}),
        },
      });
    }
    return updated;
  });
}

function eventTypeFor(status: TaskStatus): 'task_started' | 'task_completed' | 'task_failed' | 'task_superseded' | null {
  switch (status) {
    case 'in_progress': return 'task_started';
    case 'completed': return 'task_completed';
    case 'failed': return 'task_failed';
    case 'superseded': return 'task_superseded';
    default: return null;
  }
}

/** 父任务有更新时：同名同类子任务作废（superseded）。用于 Lead 重复拆解。 */
export function supersedeChildrenOf(parentId: string): number {
  return withTransaction(() => {
    const d = getDb();
    const res = d
      .prepare(
        `UPDATE tasks SET status = 'superseded', finished_at = ?
         WHERE parent_id = ? AND status IN ('unassigned','claimed','in_progress')`
      )
      .run(nowIso(), parentId);
    const n = Number(res.changes);
    if (n > 0) insertEvent({ task_id: parentId, type: 'task_superseded', payload: { count: n } });
    return n;
  });
}
