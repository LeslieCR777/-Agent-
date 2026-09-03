
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '@platform/config.js';
import { logger } from '@platform/logger.js';
import { getAgent } from '@api/db/queries/agents.js';
import { verifyServiceToken } from '@api/db/queries/analysis.js';
import { randomUUID } from 'node:crypto';
import { verifySessionToken } from '@api/auth/index.js';

/**
 * 中间件：API Key 认证、X-Agent-ID 解析、JSON body 读取、统一错误处理。
 */

export interface ApiRequest extends IncomingMessage {
  body?: unknown;
  agentId?: string | null;
  params?: Record<string, string>;
  query?: URLSearchParams;
  actor?: string;
  traceId?: string;
  userRole?: string;
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
  const session = verifySessionToken(token);
  if (session) {
    req.actor = `user:${session.username}`;
    req.userRole = session.role;
    return true;
  }
  if (config.allowLegacyApiKey && token === config.apiKey) {
    req.actor = 'user:api';
    req.userRole = 'admin';
    return true;
  }
  // 允许内网直连（无 Key）仅限 health
  sendJson(res, 401, {
    code: 'UNAUTHORIZED', error: 'UNAUTHORIZED', message: 'invalid user session',
    details: null, trace_id: req.traceId ?? null,
  });
  return false;
}

/** Worker 只能使用独立服务身份；service_tokens 支持细粒度 scope。 */
export async function requireServiceScope(
  req: ApiRequest,
  res: ServerResponse,
  scope: string
): Promise<boolean> {
  const auth = req.headers.authorization ?? '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  const ok = token === config.serviceApiKey || (token.length >= 20 && await verifyServiceToken(token, scope));
  if (!ok) {
    sendJson(res, 403, {
      code: 'SERVICE_SCOPE_DENIED', error: 'SERVICE_SCOPE_DENIED',
      message: `service token requires scope: ${scope}`, details: null,
      trace_id: req.traceId ?? null,
    });
    return false;
  }
  req.actor = `service:${req.headers['x-agent-id'] ?? 'worker'}`;
  return true;
}

/** 解析 X-Agent-ID；Worker 专属接口要求 agent 必须注册过且存活 */
export async function resolveAgent(req: ApiRequest, res: ServerResponse, required: boolean): Promise<boolean> {
  const agentId = req.headers['x-agent-id'];
  req.agentId = typeof agentId === 'string' && agentId.length > 0 ? agentId : null;
  if (!required) return true;
  if (!req.agentId) {
    sendJson(res, 400, { error: 'MISSING_AGENT_ID', message: 'X-Agent-ID header required' });
    return false;
  }
  const agent = await getAgent(req.agentId);
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
    if (size > 10 * 1024 * 1024) throw new HttpError(413, 'body too large');
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
export function handleError(res: ServerResponse, err: unknown, scope: string, requestTraceId?: string): void {
  const traceId = requestTraceId ?? randomUUID();
  if (err instanceof HttpError) {
    const code = /^[A-Z_]+$/.test(err.message) ? err.message : 'REQUEST_ERROR';
    sendJson(res, err.status, { code, error: code, message: err.message, details: null, trace_id: traceId });
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
    sendJson(res, statusMap[msg] ?? 400, { code: msg, error: msg, message: msg, details: null, trace_id: traceId });
    return;
  }
  logger.error(scope, `unhandled error: ${msg}`);
  sendJson(res, 500, { code: 'INTERNAL_ERROR', error: 'INTERNAL_ERROR', message: 'internal error', details: null, trace_id: traceId });
}
