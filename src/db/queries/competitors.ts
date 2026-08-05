import { newId, nowIso, query, exec } from '../index.js';
import type { Competitor } from '../../shared/types.js';

/** 竞品注册表读写（CI 模块，MySQL 异步版）。 */

const COLS = `id, name, website, monitor_urls, notes, enabled, status,
  created_at, last_checked_at, last_error`;

export interface CreateCompetitorInput {
  name: string;
  website?: string;
  monitor_urls?: string[];
  notes?: string;
  enabled?: boolean;
}

export async function createCompetitor(input: CreateCompetitorInput): Promise<Competitor> {
  const row: Competitor = {
    id: newId(),
    name: input.name,
    website: input.website || null,
    monitor_urls: input.monitor_urls && input.monitor_urls.length > 0 ? JSON.stringify(input.monitor_urls) : null,
    notes: input.notes || null,
    enabled: input.enabled === false ? 0 : 1,
    status: 'idle',
    created_at: nowIso(),
    last_checked_at: null,
    last_error: null,
  };
  await exec(
    `INSERT INTO competitors (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.name, row.website, row.monitor_urls, row.notes, row.enabled,
      row.status, row.created_at, row.last_checked_at, row.last_error]
  );
  return row;
}

export async function getCompetitor(id: string): Promise<Competitor | null> {
  const rows = await query<Competitor>(`SELECT ${COLS} FROM competitors WHERE id = ?`, [id]);
  return rows[0] ?? null;
}

export interface CompetitorListOptions {
  enabled?: boolean;
}

export async function listCompetitors(opts: CompetitorListOptions = {}): Promise<Competitor[]> {
  if (opts.enabled === true) {
    return query<Competitor>(`SELECT ${COLS} FROM competitors WHERE enabled = 1 ORDER BY created_at ASC`);
  }
  return query<Competitor>(`SELECT ${COLS} FROM competitors ORDER BY created_at ASC`);
}

export async function listEnabledCompetitors(): Promise<Competitor[]> {
  return listCompetitors({ enabled: true });
}

export interface CompetitorPatch {
  name?: string;
  website?: string | null;
  monitor_urls?: string[];
  notes?: string | null;
  enabled?: boolean;
}

export async function updateCompetitor(id: string, patch: CompetitorPatch): Promise<Competitor | null> {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (patch.name !== undefined) { sets.push('name = ?'); params.push(patch.name); }
  if (patch.website !== undefined) { sets.push('website = ?'); params.push(patch.website); }
  if (patch.monitor_urls !== undefined) {
    sets.push('monitor_urls = ?');
    params.push(patch.monitor_urls.length > 0 ? JSON.stringify(patch.monitor_urls) : null);
  }
  if (patch.notes !== undefined) { sets.push('notes = ?'); params.push(patch.notes); }
  if (patch.enabled !== undefined) { sets.push('enabled = ?'); params.push(patch.enabled ? 1 : 0); }
  if (sets.length === 0) return getCompetitor(id);
  params.push(id);
  await exec(`UPDATE competitors SET ${sets.join(', ')} WHERE id = ?`, params);
  return getCompetitor(id);
}

export async function deleteCompetitor(id: string): Promise<boolean> {
  const affected = await exec(`DELETE FROM competitors WHERE id = ?`, [id]);
  return affected === 1;
}

/** 更新竞品监控状态/时间（orchestrator / pages/check 调用） */
export async function touchCompetitor(
  id: string,
  patch: { status?: string; last_checked_at?: string; last_error?: string | null }
): Promise<void> {
  const sets: string[] = [];
  const params: (string | null)[] = [];
  if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status); }
  if (patch.last_checked_at !== undefined) { sets.push('last_checked_at = ?'); params.push(patch.last_checked_at); }
  if (patch.last_error !== undefined) { sets.push('last_error = ?'); params.push(patch.last_error); }
  if (sets.length === 0) return;
  params.push(id);
  await exec(`UPDATE competitors SET ${sets.join(', ')} WHERE id = ?`, params);
}
