import type { ServerResponse } from 'node:http';
import type { ApiRequest } from '../middleware.js';
import { sendJson, HttpError } from '../middleware.js';
import {
  createCompetitor,
  getCompetitor,
  listCompetitors,
  updateCompetitor,
  deleteCompetitor,
} from '../../db/queries/competitors.js';
import { kickoffPipeline } from '../../ci/orchestrator.js';

function parseMonitorUrls(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((u) => typeof u === 'string' && u.trim())) {
    throw new HttpError(400, 'monitor_urls must be an array of strings');
  }
  return v as string[];
}

export const competitorsHandlers = {
  /** POST /api/competitors 注册竞品 */
  async create(req: ApiRequest, res: ServerResponse): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null;
    if (!name) throw new HttpError(400, 'name is required');
    const competitor = await createCompetitor({
      name,
      website: typeof body.website === 'string' ? body.website.trim() || undefined : undefined,
      monitor_urls: parseMonitorUrls(body.monitor_urls),
      notes: typeof body.notes === 'string' ? body.notes.trim() || undefined : undefined,
      enabled: body.enabled === false ? false : true,
    });
    sendJson(res, 201, { competitor });
  },

  /** GET /api/competitors 竞品列表 */
  async list(req: ApiRequest, res: ServerResponse): Promise<void> {
    const q = req.query!;
    const enabled = q.get('enabled');
    sendJson(res, 200, {
      competitors: await listCompetitors({ enabled: enabled === 'true' }),
    });
  },

  /** GET /api/competitors/:id */
  async detail(req: ApiRequest, res: ServerResponse): Promise<void> {
    const competitor = await getCompetitor(req.params!.id);
    if (!competitor) throw new HttpError(404, 'NOT_FOUND');
    sendJson(res, 200, { competitor });
  },

  /** PATCH /api/competitors/:id 更新（enabled/notes/monitor_urls/website/name） */
  async patch(req: ApiRequest, res: ServerResponse): Promise<void> {
    const id = req.params!.id;
    if (!(await getCompetitor(id))) throw new HttpError(404, 'NOT_FOUND');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim()) throw new HttpError(400, 'name invalid');
      patch.name = body.name.trim();
    }
    if (body.website !== undefined) patch.website = body.website === null ? null : String(body.website);
    if (body.monitor_urls !== undefined) patch.monitor_urls = parseMonitorUrls(body.monitor_urls);
    if (body.notes !== undefined) patch.notes = body.notes === null ? null : String(body.notes);
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled must be boolean');
      patch.enabled = body.enabled;
    }
    const competitor = await updateCompetitor(id, patch);
    sendJson(res, 200, { competitor });
  },

  /** DELETE /api/competitors/:id */
  async del(req: ApiRequest, res: ServerResponse): Promise<void> {
    const ok = await deleteCompetitor(req.params!.id);
    if (!ok) throw new HttpError(404, 'NOT_FOUND');
    sendJson(res, 200, { ok: true });
  },

  /** POST /api/competitors/:id/analyze 触发全流水线（monitor→research→compare→battlecard→quality） */
  async analyze(req: ApiRequest, res: ServerResponse): Promise<void> {
    const competitor = await getCompetitor(req.params!.id);
    if (!competitor) throw new HttpError(404, 'NOT_FOUND');
    const task = await kickoffPipeline(competitor.id, 'full');
    sendJson(res, 202, { task });
  },

  /** POST /api/competitors/:id/monitor 仅触发监控 stage */
  async monitor(req: ApiRequest, res: ServerResponse): Promise<void> {
    const competitor = await getCompetitor(req.params!.id);
    if (!competitor) throw new HttpError(404, 'NOT_FOUND');
    const task = await kickoffPipeline(competitor.id, 'monitor');
    sendJson(res, 202, { task });
  },
};
