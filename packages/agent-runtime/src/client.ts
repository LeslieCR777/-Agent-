import { config } from '@platform/config.js';
import { logger } from '@platform/logger.js';

/**
 * Worker/Lead 访问 API 的唯一通道（文档 6.1 依赖规则）：
 * Worker 禁止直连数据库，一律走 HTTP。本模块不 import 任何 db/ 文件。
 */

export class ApiClientError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  agentId?: string | null;
  retries?: number;
  serviceAuth?: boolean;
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, agentId = null, retries = 2, serviceAuth = false } = opts;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${serviceAuth ? config.serviceApiKey : config.apiKey}`,
    'Content-Type': 'application/json',
  };
  if (agentId) headers['X-Agent-ID'] = agentId;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${config.apiBaseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        // 客户端超时：防止 API 假死拖住 Worker
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      const data = text ? JSON.parse(text) : {};
      if (!res.ok) {
        const msg = (data as { message?: string; error?: string }).message
          ?? (data as { error?: string }).error
          ?? `HTTP ${res.status}`;
        throw new ApiClientError(res.status, msg);
      }
      return data as T;
    } catch (err) {
      lastErr = err;
      // 4xx 不重试（请求本身错了）；网络错/5xx 重试
      if (err instanceof ApiClientError && err.status < 500) throw err;
      if (attempt < retries) {
        const delay = 500 * 2 ** attempt;
        logger.warn('client', `request ${method} ${path} failed, retry ${attempt + 1}/${retries} after ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

/** 便捷：带 X-Agent-ID 的调用 */
export function apiAsAgent<T>(agentId: string, path: string, opts: Omit<RequestOptions, 'agentId'> = {}): Promise<T> {
  return api<T>(path, { ...opts, agentId, serviceAuth: true });
}
