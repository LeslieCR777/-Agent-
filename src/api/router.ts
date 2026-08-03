import type { ServerResponse } from 'node:http';
import { HttpError, sendJson } from './middleware.js';
import type { ApiRequest } from './middleware.js';

/**
 * 迷你路由表：把 (method, path) 解析成 handler。
 * 支持 :id 路径参数；handler 形如 (req, res) => Promise<void>。
 */

export type Handler = (req: ApiRequest, res: ServerResponse) => Promise<void> | void;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: Handler): void {
    this.routes.push({
      method: method.toUpperCase(),
      segments: path.split('/').filter(Boolean),
      handler,
    });
  }

  get(path: string, h: Handler): void { this.add('GET', path, h); }
  post(path: string, h: Handler): void { this.add('POST', path, h); }
  patch(path: string, h: Handler): void { this.add('PATCH', path, h); }
  del(path: string, h: Handler): void { this.add('DELETE', path, h); }

  /** 尝试匹配；不匹配返回 null */
  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
    const segs = pathname.split('/').filter(Boolean);
    const m = method.toUpperCase();
    for (const route of this.routes) {
      if (route.method !== m || route.segments.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i++) {
        const rs = route.segments[i];
        if (rs.startsWith(':')) params[rs.slice(1)] = decodeURIComponent(segs[i]);
        else if (rs !== segs[i]) { ok = false; break; }
      }
      if (ok) return { handler: route.handler, params };
    }
    return null;
  }
}

/** 404 兜底 */
export function notFound(res: ServerResponse): void {
  sendJson(res, 404, { error: 'NOT_FOUND' });
}

export { HttpError };
