import { withTransaction, newId, nowIso, query, exec } from '../index.js';
import type { Task, TaskStatus, TaskSource } from '../../shared/types.js';
import { TRANSITIONS, TERMINAL_STATUSES } from '../../shared/constants.js';
import { insertEvent } from './events.js';

/**
 * 任务全部 SQL 封装（MySQL 异步版）。
 * 认领/重派等涉及状态竞争的操作一律包在 withTransaction（START TRANSACTION）里，
 * 用 SELECT ... FOR UPDATE SKIP LOCKED 原子选行 + 条件 UPDATE 影响行数判胜。
 * 连接池隔离级别 READ COMMITTED（见 db/index.ts），避免快照读陈旧。
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

type Row = Record<string, unknown>;
function mapTask(r: Row): Task {
  return {
    id: r.id as string,
    title: r.title as string,
    prompt: r.prompt as string,
    parent_id: (r.parent_id as string | null) ?? null,
    status: r.status as TaskStatus,
    priority: Number(r.priority),
    agent_id: (r.agent_id as string | null) ?? null,
    assign_count: Number(r.assign_count),
    result: (r.result as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    source: r.source as TaskSource,
    tags: (r.tags as string | null) ?? null,
    attachments: (r.attachments as string | null) ?? null,
    created_at: r.created_at as string,
    claimed_at: (r.claimed_at as string | null) ?? null,
    started_at: (r.started_at as string | null) ?? null,
    finished_at: (r.finished_at as string | null) ?? null,
  };
}

export async function createTask(input: CreateTaskInput): Promise<Task> {
  return withTransaction(async () => {
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
    await exec(
      `INSERT INTO tasks (${COLS}) VALUES (
        ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        row.id, row.title, row.prompt, row.parent_id, row.status, row.priority,
        row.agent_id, row.assign_count, row.result, row.error, row.source,
        row.tags, row.attachments, row.created_at, row.claimed_at, row.started_at, row.finished_at,
      ]
    );
    await insertEvent({ task_id: row.id, type: 'task_created', payload: { title: row.title, source: row.source } });
    return row;
  });
}

export async function getTask(id: string): Promise<Task | null> {
  const rows = await query<Row>(`SELECT ${COLS} FROM tasks WHERE id = ?`, [id]);
  return rows[0] ? mapTask(rows[0]) : null;
}

export interface TaskFilter {
  status?: TaskStatus;
  priority?: number;
  parent_id?: string | null;
  source?: TaskSource;
  tag?: string;
  page?: number;
  size?: number;
}

export async function listTasks(filter: TaskFilter): Promise<{ tasks: Task[]; total: number }> {
  const conds: string[] = [];
  const params: (string | number | null)[] = [];
  if (filter.status) { conds.push('status = ?'); params.push(filter.status); }
  if (filter.priority !== undefined) { conds.push('priority = ?'); params.push(filter.priority); }
  if (filter.source) { conds.push('source = ?'); params.push(filter.source); }
  if (filter.parent_id === null) conds.push('parent_id IS NULL');
  else if (filter.parent_id !== undefined) { conds.push('parent_id = ?'); params.push(filter.parent_id); }
  if (filter.tag) { conds.push(`tags IS NOT NULL AND tags LIKE ?`); params.push(`%"${filter.tag}"%`); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const page = filter.page ?? 1;
  const size = Math.min(filter.size ?? 50, 200);
  const offset = (page - 1) * size;

  const countRows = await query<Row>(`SELECT COUNT(*) AS n FROM tasks ${where}`, params);
  const total = Number(countRows[0]?.n ?? 0);
  const rows = await query<Row>(
    `SELECT ${COLS} FROM tasks ${where} ORDER BY status = 'unassigned' DESC, priority ASC, created_at ASC LIMIT ? OFFSET ?`,
    [...params, size, offset]
  );
  return { tasks: rows.map(mapTask), total };
}

/**
 * 原子领取下一个可执行任务。
 * MySQL 实现：事务内 SELECT ... FOR UPDATE SKIP LOCKED 原子锁定一行（跳过被并发锁定的行），
 * 再条件 UPDATE 确认（status='unassigned' 保护，防止并发下重复认领）。
 * READ COMMITTED + 行锁保证：两个 Worker 并发领取不会领到同一任务。
 */
export async function claimNextTask(agentId: string): Promise<Task | null> {
  return withTransaction(async () => {
    // 1. 原子选行：FOR UPDATE SKIP LOCKED 跳过并发事务已锁的行（MySQL 8.0+）
    const cand = await query<{ id: string }>(
      `SELECT id FROM tasks
       WHERE status = 'unassigned'
       ORDER BY priority ASC, created_at ASC, id ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`
    );
    const candidate = cand[0];
    if (!candidate) return null;

    // 2. 条件 UPDATE：影响行数=1 表示抢到
    const affected = await exec(
      `UPDATE tasks SET status = 'claimed', agent_id = ?, claimed_at = ?, assign_count = assign_count + 1
       WHERE id = ? AND status = 'unassigned'`,
      [agentId, nowIso(), candidate.id]
    );
    if (affected !== 1) return null; // 极端并发下被抢走

    const task = await getTask(candidate.id);
    if (!task) return null;
    await insertEvent({ task_id: task.id, agent_id: agentId, type: 'task_claimed', payload: { title: task.title } });
    return task;
  });
}

/** 手动认领指定任务（PATCH 前的辅助） */
export async function claimTask(taskId: string, agentId: string): Promise<Task> {
  return withTransaction(async () => {
    const affected = await exec(
      `UPDATE tasks SET status = 'claimed', agent_id = ?, claimed_at = ?, assign_count = assign_count + 1
       WHERE id = ? AND status = 'unassigned'`,
      [agentId, nowIso(), taskId]
    );
    if (affected !== 1) throw new Error('TASK_NOT_CLAIMABLE');
    const task = await getTask(taskId);
    if (!task) throw new Error('NOT_FOUND');
    await insertEvent({ task_id: taskId, agent_id: agentId, type: 'task_claimed', payload: { title: task.title } });
    return task;
  });
}

/**
 * 状态迁移（Worker 上报/清扫器/Lead 调用）。
 * 状态机合法性在 db 层强制（深层防御），handler 层保留友好 HTTP 校验。
 */
export async function updateTaskStatus(input: {
  taskId: string;
  status: TaskStatus;
  result?: string | null;
  error?: string | null;
  agentId?: string | null;
  supersededBy?: string;
}): Promise<Task> {
  return withTransaction(async () => {
    const task = await getTask(input.taskId);
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
    await exec(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, params);

    const updated = await getTask(input.taskId);
    if (!updated) throw new Error('NOT_FOUND');
    const type = eventTypeFor(input.status);
    if (type) {
      await insertEvent({
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
export async function supersedeChildrenOf(parentId: string): Promise<number> {
  return withTransaction(async () => {
    const n = await exec(
      `UPDATE tasks SET status = 'superseded', finished_at = ?
       WHERE parent_id = ? AND status IN ('unassigned','claimed','in_progress')`,
      [nowIso(), parentId]
    );
    if (n > 0) await insertEvent({ task_id: parentId, type: 'task_superseded', payload: { count: n } });
    return n;
  });
}
