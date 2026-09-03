import { exec, newId, nowIso, query, withTransaction } from '../index.js';
import { parseJson } from '@domain/analysis.js';
import type { ImportRow, ProductSide, ProjectRole } from '@domain/phase-two.js';
import { writeAudit } from './analysis.js';

const json = (value: unknown) => JSON.stringify(value ?? null);

function projectRow(row: Record<string, unknown>) {
  return {
    ...row,
    channels: parseJson(row.channels, []),
    topics: parseJson(row.topics, []),
    source_policy: parseJson(row.source_policy, {}),
    alert_policy: parseJson(row.alert_policy, null),
  };
}

export async function createProject(input: {
  name: string; objective: string; business_context?: string; market: string;
  channels: string[]; topics: string[]; source_policy?: Record<string, unknown>;
  report_template?: string; alert_policy?: Record<string, unknown>; actor: string;
}) {
  const now = nowIso();
  const row = {
    id: newId(), name: input.name, objective: input.objective,
    business_context: input.business_context ?? null, market: input.market,
    channels: input.channels, topics: input.topics, source_policy: input.source_policy ?? {},
    report_template: input.report_template ?? 'standard', alert_policy: input.alert_policy ?? null,
    status: 'active', created_by: input.actor, created_at: now, updated_at: now,
  };
  await withTransaction(async () => {
    await exec(
      `INSERT INTO research_projects
       (id,name,objective,business_context,market,channels,topics,source_policy,report_template,alert_policy,status,created_by,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [row.id, row.name, row.objective, row.business_context, row.market, json(row.channels), json(row.topics),
        json(row.source_policy), row.report_template, json(row.alert_policy), row.status, row.created_by, now, now]
    );
    await exec('INSERT INTO project_members (project_id,user_id,role,created_at) VALUES (?,?,?,?)', [row.id, input.actor, 'owner', now]);
    await writeAudit(input.actor, 'project.create', 'research_project', row.id, null, row);
  });
  return row;
}

export async function listProjects(actor: string, isAdmin = false) {
  const rows = await query<Record<string, unknown>>(
    isAdmin
      ? 'SELECT * FROM research_projects ORDER BY updated_at DESC'
      : `SELECT p.* FROM research_projects p JOIN project_members m ON m.project_id=p.id
         WHERE m.user_id=? ORDER BY p.updated_at DESC`,
    isAdmin ? [] : [actor]
  );
  return rows.map(projectRow);
}

export async function canAccessProject(projectId: string, actor: string, isAdmin = false) {
  if (isAdmin) return true;
  const rows = await query<{ allowed: number }>(
    'SELECT 1 allowed FROM project_members WHERE project_id=? AND user_id=?', [projectId, actor]
  );
  return Boolean(rows[0]);
}

export async function getProject(id: string) {
  const rows = await query<Record<string, unknown>>('SELECT * FROM research_projects WHERE id=?', [id]);
  if (!rows[0]) return null;
  const [members, products] = await Promise.all([
    query('SELECT user_id,role,created_at FROM project_members WHERE project_id=? ORDER BY created_at', [id]),
    query(
      `SELECT s.id,s.code,s.name,s.status,ps.side,se.name series,b.name brand,c.name company
       FROM project_skus ps JOIN skus s ON s.id=ps.sku_id JOIN product_series se ON se.id=s.series_id
       JOIN brands b ON b.id=se.brand_id JOIN companies c ON c.id=b.company_id
       WHERE ps.project_id=? ORDER BY ps.side,c.name,b.name,se.name,s.name`, [id]
    ),
  ]);
  return { ...projectRow(rows[0]), members, products };
}

export async function addProjectMember(projectId: string, userId: string, role: ProjectRole, actor: string) {
  await exec(
    `INSERT INTO project_members (project_id,user_id,role,created_at) VALUES (?,?,?,?)
     ON DUPLICATE KEY UPDATE role=VALUES(role)`, [projectId, userId, role, nowIso()]
  );
  await writeAudit(actor, 'project.member.upsert', 'research_project', projectId, null, { user_id: userId, role });
}

export async function projectDashboard(projectId: string) {
  const [counts, prices, evidence, reports, recent] = await Promise.all([
    query<{ sku_count: number; ours_count: number }>(
      `SELECT COUNT(*) sku_count,COALESCE(SUM(side='ours'),0) ours_count FROM project_skus WHERE project_id=?`, [projectId]
    ),
    query<{ snapshot_count: number; latest_price_at: string | null }>(
      `SELECT COUNT(*) snapshot_count,MAX(p.captured_at) latest_price_at FROM price_snapshots p
       JOIN project_skus ps ON ps.sku_id=p.sku_id WHERE ps.project_id=?`, [projectId]
    ),
    query<{ pending: number; invalid: number }>(
      `SELECT COALESCE(SUM(e.status='pending'),0) pending,
              COALESCE(SUM(e.status IN ('rejected','expired')),0) invalid
       FROM evidence e JOIN project_runs pr ON pr.run_id=e.run_id WHERE pr.project_id=?`, [projectId]
    ),
    query<{ pending: number }>(
      `SELECT COALESCE(SUM(r.status IN ('draft','reviewing')),0) pending
       FROM reports r JOIN project_runs pr ON pr.run_id=r.run_id WHERE pr.project_id=?`, [projectId]
    ),
    query<{ price_changes: number; parameter_changes: number; covered_skus: number }>(
      `SELECT
        (SELECT COUNT(*) FROM price_snapshots p JOIN project_skus x ON x.sku_id=p.sku_id
         WHERE x.project_id=? AND p.captured_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)) price_changes,
        (SELECT COUNT(*) FROM product_snapshots p JOIN project_skus x ON x.sku_id=p.sku_id
         WHERE x.project_id=? AND p.captured_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)) parameter_changes,
        (SELECT COUNT(DISTINCT p.sku_id) FROM price_snapshots p JOIN project_skus x ON x.sku_id=p.sku_id
         WHERE x.project_id=?) covered_skus`, [projectId, projectId, projectId]
    ),
  ]);
  return {
    sku_count: Number(counts[0]?.sku_count ?? 0),
    our_sku_count: Number(counts[0]?.ours_count ?? 0),
    competitor_sku_count: Number(counts[0]?.sku_count ?? 0) - Number(counts[0]?.ours_count ?? 0),
    price_snapshot_count: Number(prices[0]?.snapshot_count ?? 0),
    latest_price_at: prices[0]?.latest_price_at ?? null,
    fresh_coverage: Number(counts[0]?.sku_count ?? 0)
      ? Number(recent[0]?.covered_skus ?? 0) / Number(counts[0].sku_count) : 0,
    new_evidence: Number(evidence[0]?.pending ?? 0),
    invalid_evidence: Number(evidence[0]?.invalid ?? 0),
    weekly_price_changes: Number(recent[0]?.price_changes ?? 0),
    weekly_parameter_changes: Number(recent[0]?.parameter_changes ?? 0),
    pending_reports: Number(reports[0]?.pending ?? 0),
    overdue_actions: 0,
  };
}

async function findOrCreate(table: 'companies' | 'brands' | 'product_series', parent: { key?: string; id?: string }, name: string) {
  const parentClause = parent.key ? ` AND ${parent.key}=?` : '';
  const params = parent.key ? [name, parent.id] : [name];
  const rows = await query<{ id: string }>(`SELECT id FROM ${table} WHERE name=?${parentClause}`, params);
  if (rows[0]) return rows[0].id;
  const id = newId();
  const columns = parent.key ? `id,${parent.key},name,created_at` : 'id,name,created_at';
  const values = parent.key ? [id, parent.id, name, nowIso()] : [id, name, nowIso()];
  await exec(`INSERT INTO ${table} (${columns}) VALUES (${values.map(() => '?').join(',')})`, values);
  return id;
}

export async function createCatalogItem(input: {
  type: 'company' | 'brand' | 'series' | 'sku'; name: string; parent_id?: string; code?: string;
}) {
  if (input.type === 'company') return { id: await findOrCreate('companies', {}, input.name) };
  if (!input.parent_id) throw new Error('PARENT_ID_REQUIRED');
  if (input.type === 'brand') return { id: await findOrCreate('brands', { key: 'company_id', id: input.parent_id }, input.name) };
  if (input.type === 'series') return { id: await findOrCreate('product_series', { key: 'brand_id', id: input.parent_id }, input.name) };
  if (!input.code) throw new Error('SKU_CODE_REQUIRED');
  const existing = await query<{ id: string }>('SELECT id FROM skus WHERE series_id=? AND code=?', [input.parent_id, input.code]);
  if (existing[0]) return existing[0];
  const now = nowIso();
  const id = newId();
  await exec('INSERT INTO skus (id,series_id,code,name,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    [id, input.parent_id, input.code, input.name, 'active', now, now]);
  return { id };
}

export async function listCatalog() {
  return query(
    `SELECT c.id company_id,c.name company,b.id brand_id,b.name brand,se.id series_id,se.name series,
            s.id sku_id,s.code sku_code,s.name sku_name,s.status
     FROM companies c LEFT JOIN brands b ON b.company_id=c.id LEFT JOIN product_series se ON se.brand_id=b.id
     LEFT JOIN skus s ON s.series_id=se.id ORDER BY c.name,b.name,se.name,s.name`
  );
}

export async function attachProjectSku(projectId: string, skuId: string, side: ProductSide) {
  await exec(
    `INSERT INTO project_skus (project_id,sku_id,side,created_at) VALUES (?,?,?,?)
     ON DUPLICATE KEY UPDATE side=VALUES(side)`, [projectId, skuId, side, nowIso()]
  );
}

export async function linkProjectRun(projectId: string, runId: string) {
  await exec('INSERT IGNORE INTO project_runs (project_id,run_id,created_at) VALUES (?,?,?)', [projectId, runId, nowIso()]);
}

export async function listProjectRuns(projectId: string) {
  const rows = await query<Record<string, unknown>>(
    `SELECT r.* FROM project_runs pr JOIN ci_runs r ON r.id=pr.run_id
     WHERE pr.project_id=? ORDER BY r.created_at DESC`, [projectId]
  );
  return rows.map((row) => ({ ...row, snapshot: parseJson(row.snapshot, {}) }));
}

export async function createProductSnapshot(input: {
  sku_id: string; market: string; channel: string; parameters: Record<string, unknown>;
  source_url?: string; evidence_id?: string; captured_at?: string;
}) {
  const row = { id: newId(), ...input, captured_at: input.captured_at ?? nowIso(), created_at: nowIso() };
  await exec(
    `INSERT INTO product_snapshots (id,sku_id,market,channel,parameters,source_url,evidence_id,captured_at,created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [row.id,row.sku_id,row.market,row.channel,json(row.parameters),row.source_url ?? null,row.evidence_id ?? null,row.captured_at,row.created_at]
  );
  return row;
}

export async function createPriceSnapshot(input: {
  sku_id: string; market: string; channel: string; list_price?: number; sale_price?: number;
  currency: string; in_stock?: boolean; source_url?: string; evidence_id?: string; captured_at?: string;
}) {
  const row = { id: newId(), ...input, captured_at: input.captured_at ?? nowIso(), created_at: nowIso() };
  await exec(
    `INSERT INTO price_snapshots (id,sku_id,market,channel,list_price,sale_price,currency,in_stock,source_url,evidence_id,captured_at,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [row.id,row.sku_id,row.market,row.channel,row.list_price ?? null,row.sale_price ?? null,row.currency,
      row.in_stock === undefined ? null : Number(row.in_stock),row.source_url ?? null,row.evidence_id ?? null,row.captured_at,row.created_at]
  );
  return row;
}

export async function productTimeline(skuId: string, market?: string, channel?: string) {
  const filters = ['sku_id=?'];
  const params: unknown[] = [skuId];
  if (market) { filters.push('market=?'); params.push(market); }
  if (channel) { filters.push('channel=?'); params.push(channel); }
  const where = filters.join(' AND ');
  const [products, prices] = await Promise.all([
    query<Record<string, unknown>>(`SELECT * FROM product_snapshots WHERE ${where} ORDER BY captured_at DESC`, params),
    query<Record<string, unknown>>(`SELECT * FROM price_snapshots WHERE ${where} ORDER BY captured_at DESC`, params),
  ]);
  return { products: products.map((row) => ({ ...row, parameters: parseJson(row.parameters, {}) })), prices };
}

export async function previewCatalogImport(input: {
  project_id?: string; filename: string; mapping: Record<string, string>; rows: ImportRow[]; actor: string;
}) {
  const codes = [...new Set(input.rows.map((row) => row.sku_code))];
  const duplicates = codes.length
    ? await query<{ code: string }>(`SELECT DISTINCT code FROM skus WHERE code IN (${codes.map(() => '?').join(',')})`, codes)
    : [];
  const duplicateCodes = new Set(duplicates.map((row) => row.code));
  const row = {
    id: newId(), project_id: input.project_id ?? null, filename: input.filename, status: 'preview',
    mapping: input.mapping, preview: input.rows.map((item) => ({ ...item, duplicate: duplicateCodes.has(item.sku_code) })),
    row_count: input.rows.length, duplicate_count: input.rows.filter((item) => duplicateCodes.has(item.sku_code)).length,
    created_by: input.actor, created_at: nowIso(),
  };
  await exec(
    `INSERT INTO catalog_imports (id,project_id,filename,status,mapping,preview,row_count,duplicate_count,created_by,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [row.id,row.project_id,row.filename,row.status,json(row.mapping),json(row.preview),row.row_count,row.duplicate_count,row.created_by,row.created_at]
  );
  return row;
}

export async function confirmCatalogImport(id: string, actor?: string, isAdmin = false) {
  const imports = await query<Record<string, unknown>>('SELECT * FROM catalog_imports WHERE id=?', [id]);
  const item = imports[0];
  if (!item) throw new Error('NOT_FOUND');
  if (actor && !isAdmin && item.created_by !== actor) throw new Error('PROJECT_ACCESS_DENIED');
  if (item.status !== 'preview') throw new Error('IMPORT_ALREADY_CONFIRMED');
  const rows = parseJson<ImportRow[]>(item.preview, []);
  return withTransaction(async () => {
    for (const row of rows) {
      const companyId = await findOrCreate('companies', {}, row.company);
      const brandId = await findOrCreate('brands', { key: 'company_id', id: companyId }, row.brand);
      const seriesId = await findOrCreate('product_series', { key: 'brand_id', id: brandId }, row.series);
      const sku = await createCatalogItem({ type: 'sku', parent_id: seriesId, code: row.sku_code, name: row.sku_name });
      if (item.project_id) await attachProjectSku(String(item.project_id), sku.id, 'competitor');
    }
    await exec("UPDATE catalog_imports SET status='confirmed' WHERE id=?", [id]);
    return { id, imported: rows.length, duplicates: Number(item.duplicate_count) };
  });
}
