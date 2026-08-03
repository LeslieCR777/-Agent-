import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { getAgent } from '../db/queries/agents.js';

/**
 * 中间件：API Key 认证、X-Agent-ID 解析、JSON body 读取、统一错误处理。
 */

export interface ApiRequest extends IncomingMessage {
  body?: unknown;
  agentId?: string | null;
  params?: Record<string, string>;
  query?: URLSearchParams;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function sendNoContent(res: ServerResponse): void {
  res.writeHead(204);
  res.end();
}

/** 认证：Authorization: Bearer <API_KEY>（文档 5.0）。白名单接口除外。 */
export function requireApiKey(req: ApiRequest, res: ServerResponse): boolean {
  const auth = req.headers['authorization'] ?? '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (token === config.apiKey) return true;
  // 允许内网直连（无 Key）仅限 health
  sendJson(res, 401, { error: 'UNAUTHORIZED', message: 'invalid API key' });
  return false;
}

/** 解析 X-Agent-ID；Worker 专属接口要求 agent 必须注册过且存活 */
export function resolveAgent(req: ApiRequest, res: ServerResponse, required: boolean): boolean {
  const agentId = req.headers['x-agent-id'];
  req.agentId = typeof agentId === 'string' && agentId.length > 0 ? agentId : null;
  if (!required) return true;
  if (!req.agentId) {
    sendJson(res, 400, { error: 'MISSING_AGENT_ID', message: 'X-Agent-ID header required' });
    return false;
  }
  const agent = getAgent(req.agentId);
  if (!agent) {
    sendJson(res, 401, { error: 'AGENT_NOT_REGISTERED', message: 'register this agent first' });
    return false;
  }
  return true;
}

/** 读取 JSON body（限制大小防滥用） */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 1_000_000) throw new HttpError(413, 'body too large');
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

/** 统一错误响应 + 日志 */
export function handleError(res: ServerResponse, err: unknown, scope: string): void {
  if (err instanceof HttpError) {
    sendJson(res, err.status, { error: err.name, message: err.message });
    return;
  }
  const msg = err instanceof Error ? err.message : String(err);
  // 领域错误码：NOT_FOUND / TASK_NOT_CLAIMABLE / INVALID_TRANSITION 等
  if (typeof msg === 'string' && /^[A-Z_]+$/.test(msg)) {
    const statusMap: Record<string, number> = {
      NOT_FOUND: 404,
      TASK_NOT_CLAIMABLE: 409,
      INVALID_TRANSITION: 409,
      ALREADY_TERMINAL: 409,
      NOT_OWNER: 403,
    };
    sendJson(res, statusMap[msg] ?? 400, { error: msg });
    return;
  }
  logger.error(scope, `unhandled error: ${msg}`);
  sendJson(res, 500, { error: 'INTERNAL_ERROR' });
}
