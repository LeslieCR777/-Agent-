import { newId, nowIso, getPool} from '../index.js';
import type { Session } from '../../shared/types.js';

/** 执行会话：记录子进程完整 stdout + exit_code（需求文档 4.3，MySQL 异步版） */

export interface StartSessionInput {
  task_id: string;
  agent_id: string;
}

export async function startSession(input: StartSessionInput): Promise<Session> {
  const row: Session = {
    id: newId(),
    task_id: input.task_id,
    agent_id: input.agent_id,
    output: '',
    exit_code: null,
    started_at: nowIso(),
    finished_at: null,
  };
  await getPool().execute(
    `INSERT INTO sessions (id, task_id, agent_id, output, exit_code, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.task_id, row.agent_id, row.output, row.exit_code, row.started_at, row.finished_at]
  );
  return row;
}

export async function appendSessionOutput(sessionId: string, chunk: string): Promise<void> {
  // SQLite `||` → MySQL `CONCAT`
  await getPool().execute(
    `UPDATE sessions SET output = CONCAT(IFNULL(output, ''), ?) WHERE id = ?`,
    [chunk, sessionId]
  );
}

export async function finishSession(sessionId: string, exitCode: number): Promise<Session> {
  await getPool().execute(
    `UPDATE sessions SET exit_code = ?, finished_at = ? WHERE id = ?`,
    [exitCode, nowIso(), sessionId]
  );
  const session = await getSession(sessionId);
  if (!session) throw new Error('NOT_FOUND');
  return session;
}

export async function getSession(id: string): Promise<Session | null> {
  const [rows] = await getPool().execute(`SELECT * FROM sessions WHERE id = ?`, [id]);
  return rows[0] ?? null;
}

export async function latestSessionForTask(taskId: string): Promise<Session | null> {
  const [rows] = await getPool().execute(
    `SELECT * FROM sessions WHERE task_id = ? ORDER BY started_at DESC LIMIT 1`,
    [taskId]
  );
  return rows[0] ?? null;
}
