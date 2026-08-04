import { newId, nowIso, getPool} from '../index.js';
import type { AppEvent, EventType } from '../../shared/types.js';

/**
 * 事件表读写（看板 / 审计，MySQL 异步版）。
 * 所有落库事件同时通过 ws/broadcast 推给前端——调用处确保两边都做，
 * 保持 DB 与实时流一致。
 * 回调允许返回 Promise：insertEvent 内 await（WS 同步广播、CI orchestrator 接力）。
 */

export type EventHook = (event: AppEvent) => void | Promise<void>;
let onInsert: EventHook[] = [];

/** server.ts 注册：事件落库后立即触发回调（WS 广播 / CI 流水线接力） */
export function registerEventHook(cb: EventHook): void {
  onInsert.push(cb);
}

export interface InsertEventInput {
  task_id?: string | null;
  agent_id?: string | null;
  type: EventType;
  payload?: unknown;
}

export async function insertEvent(input: InsertEventInput): Promise<AppEvent> {
  const row: AppEvent = {
    id: newId(),
    task_id: input.task_id ?? null,
    agent_id: input.agent_id ?? null,
    type: input.type,
    payload: input.payload === undefined ? null : JSON.stringify(input.payload),
    created_at: nowIso(),
  };
  await getPool().execute(
    `INSERT INTO events (id, task_id, agent_id, type, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [row.id, row.task_id, row.agent_id, row.type, row.payload, row.created_at]
  );
  for (const cb of onInsert) {
    try {
      await cb(row);
    } catch {
      // 回调失败不影响事件落库主流程
    }
  }
  return row;
}

/** 增量拉取：since 之后的事件（看板断线重放用） */
export async function listEventsSince(since: string | undefined, limit = 500): Promise<AppEvent[]> {
  if (!since) {
    const [rows] = await getPool().execute(`SELECT * FROM events ORDER BY created_at DESC LIMIT ?`, [limit]);
    return rows;
  }
  const [rows] = await getPool().execute(
    `SELECT * FROM events WHERE created_at > ? ORDER BY created_at ASC LIMIT ?`,
    [since, limit]
  );
  return rows;
}

/** 某任务的状态流转历史 */
export async function taskEvents(taskId: string): Promise<AppEvent[]> {
  const [rows] = await getPool().execute(
    `SELECT * FROM events WHERE task_id = ? ORDER BY created_at ASC`,
    [taskId]
  );
  return rows;
}
