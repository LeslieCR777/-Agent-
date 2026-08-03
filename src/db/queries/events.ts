import { getDb, newId, nowIso } from '../index.js';
import type { AppEvent, EventType } from '../../shared/types.js';

/**
 * 事件表读写（看板 / 审计）。
 * 所有落库事件同时通过 ws/broadcast 推给前端——调用处确保两边都做，
 * 保持 DB 与实时流一致。
 */

let onInsert: ((event: AppEvent) => void) | null = null;

/** server.ts 注册：事件落库后立即广播到 WS */
export function registerEventHook(cb: (event: AppEvent) => void): void {
  onInsert = cb;
}

export interface InsertEventInput {
  task_id?: string | null;
  agent_id?: string | null;
  type: EventType;
  payload?: unknown;
}

export function insertEvent(input: InsertEventInput): AppEvent {
  const d = getDb();
  const row: AppEvent = {
    id: newId(),
    task_id: input.task_id ?? null,
    agent_id: input.agent_id ?? null,
    type: input.type,
    payload: input.payload === undefined ? null : JSON.stringify(input.payload),
    created_at: nowIso(),
  };
  d.prepare(
    `INSERT INTO events (id, task_id, agent_id, type, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(row.id, row.task_id, row.agent_id, row.type, row.payload, row.created_at);
  onInsert?.(row);
  return row;
}

/** 增量拉取：since 之后的事件（看板断线重放用） */
export function listEventsSince(since: string | undefined, limit = 500): AppEvent[] {
  const d = getDb();
  if (!since) {
    return d
      .prepare(`SELECT * FROM events ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as unknown as AppEvent[];
  }
  return d
    .prepare(`SELECT * FROM events WHERE created_at > ? ORDER BY created_at ASC LIMIT ?`)
    .all(since, limit) as unknown as AppEvent[];
}

/** 某任务的状态流转历史 */
export function taskEvents(taskId: string): AppEvent[] {
  const d = getDb();
  return d
    .prepare(`SELECT * FROM events WHERE task_id = ? ORDER BY created_at ASC`)
    .all(taskId) as unknown as AppEvent[];
}
