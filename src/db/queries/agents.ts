import { getDb, nowIso } from '../index.js';
import type { Agent, AgentRole } from '../../shared/types.js';
import { insertEvent } from './events.js';

/** Worker/Lead 启动时注册（upsert） */
export function registerAgent(input: {
  id: string;
  name: string;
  role: AgentRole;
}): Agent {
  const d = getDb();
  const now = nowIso();
  const existing = d.prepare(`SELECT * FROM agents WHERE id = ?`).get(input.id) as unknown as Agent | undefined;
  if (existing) {
    // 重连：恢复 online 状态，保留记录
    d.prepare(
      `UPDATE agents SET status = 'idle', last_heartbeat_at = ? WHERE id = ?`
    ).run(now, input.id);
    const row = d.prepare(`SELECT * FROM agents WHERE id = ?`).get(input.id) as unknown as Agent;
    insertEvent({ agent_id: input.id, type: 'agent_registered', payload: { name: row.name, role: row.role } });
    return row;
  }
  const row: Agent = {
    id: input.id,
    name: input.name,
    role: input.role,
    status: 'idle',
    current_task_id: null,
    last_heartbeat_at: now,
    created_at: now,
  };
  d.prepare(
    `INSERT INTO agents (id, name, role, status, current_task_id, last_heartbeat_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(row.id, row.name, row.role, row.status, row.current_task_id, row.last_heartbeat_at, row.created_at);
  insertEvent({ agent_id: input.id, type: 'agent_registered', payload: { name: input.name, role: input.role } });
  return row;
}

/** 心跳上报：upsert last_heartbeat_at。Agent 状态由任务迁移/清扫器联动。 */
export function heartbeat(agentId: string): Agent | null {
  const d = getDb();
  const now = nowIso();
  const res = d
    .prepare(`UPDATE agents SET last_heartbeat_at = ?, status = 'idle' WHERE id = ? AND status <> 'offline'`)
    .run(now, agentId);
  // offline 的 agent 不允许通过心跳复活（防止幽灵进程干扰）——但注册时会重置
  if (res.changes === 1) {
    return d.prepare(`SELECT * FROM agents WHERE id = ?`).get(agentId) as unknown as Agent;
  }
  return null;
}

export function setAgentBusy(agentId: string, taskId: string): void {
  getDb()
    .prepare(`UPDATE agents SET status = 'busy', current_task_id = ? WHERE id = ?`)
    .run(taskId, agentId);
}

export function setAgentIdle(agentId: string): void {
  getDb()
    .prepare(`UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ?`)
    .run(agentId);
}

export function setAgentOffline(agentId: string): void {
  const d = getDb();
  const res = d
    .prepare(`UPDATE agents SET status = 'offline' WHERE id = ?`)
    .run(agentId);
  if (res.changes === 1) insertEvent({ agent_id: agentId, type: 'agent_offline' });
}

export function getAgent(id: string): Agent | null {
  const row = getDb().prepare(`SELECT * FROM agents WHERE id = ?`).get(id);
  return (row as unknown as Agent | undefined) ?? null;
}

export function listAgents(): Agent[] {
  return getDb().prepare(`SELECT * FROM agents ORDER BY created_at ASC`).all() as unknown as Agent[];
}

/** 找到超时未心跳的 agent 列表（清扫器用） */
export function findStaleAgents(timeoutMs: number, now: string): Agent[] {
  const cutoff = new Date(new Date(now).getTime() - timeoutMs).toISOString();
  const rows = getDb()
    .prepare(
      `SELECT * FROM agents
       WHERE last_heartbeat_at < ? AND status != 'offline'`
    )
    .all(cutoff) as unknown as Agent[];
  return rows;
}

