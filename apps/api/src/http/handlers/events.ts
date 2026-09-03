import type { ServerResponse } from 'node:http';
import type { ApiRequest } from '../middleware.js';
import { sendJson } from '../middleware.js';
import { listEventsSince } from '@api/db/queries/events.js';

export const eventsHandlers = {
  /** GET /api/events?since= 事件流（增量拉取，看板断线重放） */
  async list(req: ApiRequest, res: ServerResponse): Promise<void> {
    const since = req.query!.get('since') ?? undefined;
    const limit = Math.min(Number(req.query!.get('limit') ?? 500) || 500, 2000);
    const events = await listEventsSince(since, limit);
    // 无 since 时按新到旧返回，前端自己倒序展示
    sendJson(res, 200, { events });
  },
};
