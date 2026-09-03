import type { ServerResponse } from 'node:http';
import type { ApiRequest } from '../middleware.js';
import { HttpError, sendJson } from '../middleware.js';
import { parseCsv, requiredText, stringList, type ProductSide, type ProjectRole } from '@domain/phase-two.js';
import {
  addProjectMember, attachProjectSku, canAccessProject, confirmCatalogImport, createCatalogItem, createPriceSnapshot,
  createProductSnapshot, createProject, getProject, listCatalog, listProjects, previewCatalogImport,
  productTimeline, projectDashboard, listProjectRuns,
} from '@api/db/queries/projects.js';

const bodyOf = (req: ApiRequest) => (req.body ?? {}) as Record<string, unknown>;
const actorOf = (req: ApiRequest) => req.actor ?? 'user:api';
const optionalText = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const optionalNumber = (value: unknown, field: string) => {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new HttpError(400, `${field} must be a non-negative number`);
  return number;
};

async function requireProjectAccess(req: ApiRequest, id = req.params!.id) {
  if (!await canAccessProject(id, actorOf(req), req.userRole === 'admin')) throw new HttpError(403, 'PROJECT_ACCESS_DENIED');
}

export const projectsHandlers = {
  async create(req: ApiRequest, res: ServerResponse) {
    const body = bodyOf(req);
    const project = await createProject({
      name: requiredText(body.name, 'name', 300), objective: requiredText(body.objective, 'objective', 5000),
      business_context: optionalText(body.business_context), market: requiredText(body.market, 'market', 100),
      channels: stringList(body.channels, 'channels'), topics: stringList(body.topics, 'topics'),
      source_policy: typeof body.source_policy === 'object' && body.source_policy ? body.source_policy as Record<string, unknown> : {},
      report_template: optionalText(body.report_template),
      alert_policy: typeof body.alert_policy === 'object' && body.alert_policy ? body.alert_policy as Record<string, unknown> : undefined,
      actor: actorOf(req),
    });
    sendJson(res, 201, { project });
  },

  async list(req: ApiRequest, res: ServerResponse) {
    sendJson(res, 200, { projects: await listProjects(actorOf(req), req.userRole === 'admin') });
  },

  async detail(req: ApiRequest, res: ServerResponse) {
    await requireProjectAccess(req);
    const project = await getProject(req.params!.id);
    if (!project) throw new HttpError(404, 'NOT_FOUND');
    sendJson(res, 200, { project });
  },

  async dashboard(req: ApiRequest, res: ServerResponse) {
    await requireProjectAccess(req);
    if (!(await getProject(req.params!.id))) throw new HttpError(404, 'NOT_FOUND');
    sendJson(res, 200, { dashboard: await projectDashboard(req.params!.id) });
  },

  async runs(req: ApiRequest, res: ServerResponse) {
    await requireProjectAccess(req);
    sendJson(res, 200, { runs: await listProjectRuns(req.params!.id) });
  },

  async addMember(req: ApiRequest, res: ServerResponse) {
    await requireProjectAccess(req);
    const body = bodyOf(req);
    const role = requiredText(body.role, 'role') as ProjectRole;
    if (!['owner', 'analyst', 'product', 'sales', 'viewer'].includes(role)) throw new HttpError(400, 'invalid role');
    await addProjectMember(req.params!.id, requiredText(body.user_id, 'user_id'), role, actorOf(req));
    sendJson(res, 200, { ok: true });
  },

  async createCatalogItem(req: ApiRequest, res: ServerResponse) {
    const body = bodyOf(req);
    const type = req.params!.type as 'company' | 'brand' | 'series' | 'sku';
    if (!['company', 'brand', 'series', 'sku'].includes(type)) throw new HttpError(400, 'invalid catalog type');
    const item = await createCatalogItem({
      type, name: requiredText(body.name, 'name'), parent_id: optionalText(body.parent_id), code: optionalText(body.code),
    });
    sendJson(res, 201, { item });
  },

  async catalog(_req: ApiRequest, res: ServerResponse) {
    sendJson(res, 200, { catalog: await listCatalog() });
  },

  async attachSku(req: ApiRequest, res: ServerResponse) {
    await requireProjectAccess(req);
    const body = bodyOf(req);
    const side = requiredText(body.side ?? 'competitor', 'side') as ProductSide;
    if (!['ours', 'competitor'].includes(side)) throw new HttpError(400, 'invalid side');
    await attachProjectSku(req.params!.id, requiredText(body.sku_id, 'sku_id'), side);
    sendJson(res, 200, { ok: true });
  },

  async productSnapshot(req: ApiRequest, res: ServerResponse) {
    const body = bodyOf(req);
    const parameters = body.parameters;
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new HttpError(400, 'parameters must be an object');
    const snapshot = await createProductSnapshot({
      sku_id: req.params!.id, market: requiredText(body.market, 'market'), channel: requiredText(body.channel, 'channel'),
      parameters: parameters as Record<string, unknown>, source_url: optionalText(body.source_url),
      evidence_id: optionalText(body.evidence_id), captured_at: optionalText(body.captured_at),
    });
    sendJson(res, 201, { snapshot });
  },

  async priceSnapshot(req: ApiRequest, res: ServerResponse) {
    const body = bodyOf(req);
    const snapshot = await createPriceSnapshot({
      sku_id: req.params!.id, market: requiredText(body.market, 'market'), channel: requiredText(body.channel, 'channel'),
      list_price: optionalNumber(body.list_price, 'list_price'), sale_price: optionalNumber(body.sale_price, 'sale_price'),
      currency: requiredText(body.currency, 'currency', 10).toUpperCase(),
      in_stock: typeof body.in_stock === 'boolean' ? body.in_stock : undefined,
      source_url: optionalText(body.source_url), evidence_id: optionalText(body.evidence_id), captured_at: optionalText(body.captured_at),
    });
    sendJson(res, 201, { snapshot });
  },

  async timeline(req: ApiRequest, res: ServerResponse) {
    sendJson(res, 200, { timeline: await productTimeline(
      req.params!.id, req.query!.get('market') ?? undefined, req.query!.get('channel') ?? undefined
    ) });
  },

  async importPreview(req: ApiRequest, res: ServerResponse) {
    const body = bodyOf(req);
    const csv = requiredText(body.csv, 'csv', 10 * 1024 * 1024);
    if (body.project_id) await requireProjectAccess(req, requiredText(body.project_id, 'project_id'));
    const mapping = typeof body.mapping === 'object' && body.mapping ? body.mapping as Record<string, string> : {};
    const item = await previewCatalogImport({
      project_id: optionalText(body.project_id), filename: requiredText(body.filename, 'filename'),
      mapping, rows: parseCsv(csv, mapping), actor: actorOf(req),
    });
    sendJson(res, 201, { import: item });
  },

  async importConfirm(req: ApiRequest, res: ServerResponse) {
    sendJson(res, 200, { import: await confirmCatalogImport(req.params!.id, actorOf(req), req.userRole === 'admin') });
  },
};
