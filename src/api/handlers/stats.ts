import type { ServerResponse } from 'node:http';
import type { ApiRequest } from '../middleware.js';
import { sendJson } from '../middleware.js';
import { getStats } from '../../db/queries/stats.js';

export const statsHandlers = {
  /** GET /api/stats 仪表盘统计 */
  get(_req: ApiRequest, res: ServerResponse): void {
    sendJson(res, 200, getStats());
  },

  /** GET /api/health 健康检查（无鉴权） */
  health(_req: ApiRequest, res: ServerResponse): void {
    sendJson(res, 200, { status: 'ok', uptime: Math.floor(process.uptime()), now: new Date().toISOString() });
  },
};
