import { getDb, newId, nowIso } from '../index.js';
import type { Session } from '../../shared/types.js';

/** 执行会话：记录子进程完整 stdout + exit_code（需求文档 4.3） */

export interface StartSessionInput {
  task_id: string;
  agent_id: string;
}

export function startSession(input: StartSessionInput): Session {
  const row: Session = {
    id: newId(),
    task_id: input.task_id,
    agent_id: input.agent_id,
    output: '',
    exit_code: null,
    started_at: nowIso(),
    finished_at: null,
  };
  getDb()
    .prepare(
      `INSERT INTO sessions (id, task_id, agent_id, output, exit_code, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(row.id, row.task_id, row.agent_id, row.output, row.exit_code, row.started_at, row.finished_at);
  return row;
}

export function appendSessionOutput(sessionId: string, chunk: string): void {
  getDb()
    .prepare(`UPDATE sessions SET output = output || ? WHERE id = ?`)
    .run(chunk, sessionId);
}

export function finishSession(sessionId: string, exitCode: number): Session {
  getDb()
    .prepare(`UPDATE sessions SET exit_code = ?, finished_at = ? WHERE id = ?`)
    .run(exitCode, nowIso(), sessionId);
  return getDb().prepare(`SELECT * FROM sessions WHERE id = ?`).get(sessionId) as unknown as Session;
}

export function getSession(id: string): Session | null {
  const row = getDb().prepare(`SELECT * FROM sessions WHERE id = ?`).get(id);
  return (row as unknown as Session | undefined) ?? null;
}

export function latestSessionForTask(taskId: string): Session | null {
  const row = getDb()
    .prepare(`SELECT * FROM sessions WHERE task_id = ? ORDER BY started_at DESC LIMIT 1`)
    .get(taskId);
  return (row as unknown as Session | undefined) ?? null;
}
