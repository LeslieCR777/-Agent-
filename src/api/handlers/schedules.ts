import type { ServerResponse } from 'node:http';
import type { ApiRequest } from '../middleware.js';
import { sendJson, HttpError } from '../middleware.js';
import {
  createSchedule,
  listSchedules,
  getSchedule,
  deleteSchedule,
  toggleSchedule,
} from '../../db/queries/schedules.js';
import { CronExpressionParser } from 'cron-parser';

function assertValidCron(cron: string): void {
  try {
    CronExpressionParser.parse(cron);
  } catch {
    throw new HttpError(400, `invalid cron expression: ${cron}`);
  }
}

export const schedulesHandlers = {
  /** POST /api/schedules 创建定时任务 */
  async create(req: ApiRequest, res: ServerResponse): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null;
    const cron = typeof body.cron === 'string' && body.cron.trim() ? body.cron.trim() : null;
    const template = typeof body.task_template === 'string' && body.task_template.trim() ? body.task_template.trim() : null;
    if (!name) throw new HttpError(400, 'name is required');
    if (!cron) throw new HttpError(400, 'cron is required');
    if (!template) throw new HttpError(400, 'task_template is required');
    assertValidCron(cron);
    const schedule = await createSchedule({ name, cron, task_template: template, enabled: body.enabled !== false });
    sendJson(res, 201, { schedule });
  },

  /** GET /api/schedules */
  async list(_req: ApiRequest, res: ServerResponse): Promise<void> {
    sendJson(res, 200, { schedules: await listSchedules() });
  },

  /** GET /api/schedules/:id */
  async detail(req: ApiRequest, res: ServerResponse): Promise<void> {
    const schedule = await getSchedule(req.params!.id);
    if (!schedule) throw new HttpError(404, 'NOT_FOUND');
    sendJson(res, 200, { schedule });
  },

  /** PATCH /api/schedules/:id 启用/停用 */
  async patch(req: ApiRequest, res: ServerResponse): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled is required');
    const schedule = await toggleSchedule(req.params!.id, body.enabled);
    if (!schedule) throw new HttpError(404, 'NOT_FOUND');
    sendJson(res, 200, { schedule });
  },

  /** DELETE /api/schedules/:id */
  async del(req: ApiRequest, res: ServerResponse): Promise<void> {
    const ok = await deleteSchedule(req.params!.id);
    if (!ok) throw new HttpError(404, 'NOT_FOUND');
    sendJson(res, 200, { ok: true });
  },
};
