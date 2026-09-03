import { nowIso, query, exec } from '../index.js';
import type { Agent, AgentRole } from '@contracts/types.js';
import { insertEvent } from './events.js';

/** Worker/Lead 启动时注册（upsert，MySQL ON DUPLICATE KEY UPDATE 保证并发安全） */
export async function registerAgent(input: {
  id: string;
  name: string;
  role: AgentRole;
}): Promise<Agent> {
  const now = nowIso();
  await exec(
    `INSERT INTO agents (id, name, role, status, current_task_id, last_heartbeat_at, created_at)
     VALUES (?, ?, ?, 'idle', NULL, ?, ?)
     ON DUPLICATE KEY UPDATE status='idle', last_heartbeat_at=VALUES(last_heartbeat_at)`,
    [input.id, input.name, input.role, now, now]
  );
  const rows = await query<Agent>(`SELECT * FROM agents WHERE id = ?`, [input.id]);
  const row = rows[0];
  await insertEvent({ agent_id: input.id, type: 'agent_registered', payload: { name: row.name, role: row.role } });
  return row;
}

/** 心跳上报：upsert last_heartbeat_at。Agent 状态由任务迁移/清扫器联动。 */
export async function heartbeat(agentId: string): Promise<Agent | null> {
  const now = nowIso();
  const affected = await exec(
    `UPDATE agents SET last_heartbeat_at = ?, status = 'idle' WHERE id = ? AND status <> 'offline'`,
    [now, agentId]
  );
  // offline 的 agent 不允许通过心跳复活（防止幽灵进程干扰）——但注册时会重置
  if (affected === 1) {
    return getAgent(agentId);
  }
  return null;
}

export async function setAgentBusy(agentId: string, taskId: string): Promise<void> {
  await exec(
    `UPDATE agents SET status = 'busy', current_task_id = ? WHERE id = ?`,
    [taskId, agentId]
  );
}

export async function setAgentIdle(agentId: string): Promise<void> {
  await exec(
    `UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ?`,
    [agentId]
  );
}

export async function setAgentOffline(agentId: string): Promise<void> {
  const affected = await exec(
    `UPDATE agents SET status = 'offline' WHERE id = ?`,
    [agentId]
  );
  if (affected === 1) {
    await insertEvent({ agent_id: agentId, type: 'agent_offline' });
  }
}

export async function getAgent(id: string): Promise<Agent | null> {
  const rows = await query<Agent>(`SELECT * FROM agents WHERE id = ?`, [id]);
  return rows[0] ?? null;
}

export async function listAgents(): Promise<Agent[]> {
  const rows = await query<Agent>(`SELECT * FROM agents ORDER BY created_at ASC`);
  return rows;
}

/** 找到超时未心跳的 agent 列表（清扫器用） */
export async function findStaleAgents(timeoutMs: number, now: string): Promise<Agent[]> {
  const cutoff = new Date(new Date(now).getTime() - timeoutMs).toISOString();
  const rows = await query<Agent>(
    `SELECT * FROM agents
     WHERE last_heartbeat_at < ? AND status != 'offline'`,
    [cutoff]
  );
  return rows;
}
