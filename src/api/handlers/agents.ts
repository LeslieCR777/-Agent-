import type { ServerResponse } from 'node:http';
import type { ApiRequest } from '../middleware.js';
import { sendJson, HttpError } from '../middleware.js';
import { registerAgent, heartbeat, listAgents, getAgent, setAgentIdle } from '../../db/queries/agents.js';
import type { AgentRole } from '../../shared/types.js';

export const agentsHandlers = {
  /** POST /api/agents/register Worker 启动时注册 */
  async register(req: ApiRequest, res: ServerResponse): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : null;
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : id;
    const role = (typeof body.role === 'string' && ['lead', 'worker'].includes(body.role) ? body.role : 'worker') as AgentRole;
    if (!id) throw new HttpError(400, 'id is required');
    const agent = await registerAgent({ id, name: name ?? id, role });
    sendJson(res, 201, { agent });
  },

  /** POST /api/agents/:id/heartbeat 心跳上报（Agent 独立调用，允许非注册 agent 注册式心跳） */
  async heartbeat(req: ApiRequest, res: ServerResponse): Promise<void> {
    const id = req.params!.id;
    // 未注册则自动注册（便于 Agent 端零配置）
    const existing = await getAgent(id);
    const agent = existing ? await heartbeat(id) : await registerAgent({ id, name: id, role: 'worker' });
    if (!agent) throw new HttpError(410, 'AGENT_OFFLINE: agent marked offline, re-register');
    sendJson(res, 200, { agent });
  },

  /** GET /api/agents Worker 状态列表 */
  async list(_req: ApiRequest, res: ServerResponse): Promise<void> {
    sendJson(res, 200, { agents: await listAgents() });
  },

  /** GET /api/agents/:id Worker 详情 */
  async detail(req: ApiRequest, res: ServerResponse): Promise<void> {
    const agent = await getAgent(req.params!.id);
    if (!agent) throw new HttpError(404, 'NOT_FOUND');
    sendJson(res, 200, { agent });
  },

  /** POST /api/agents/:id/release 释放当前任务（Worker 空闲时调用） */
  async release(req: ApiRequest, res: ServerResponse): Promise<void> {
    await setAgentIdle(req.params!.id);
    sendJson(res, 200, { ok: true });
  },
};
