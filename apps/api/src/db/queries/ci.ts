import { createHash } from 'node:crypto';
import { withTransaction, newId, nowIso, query, exec } from '../index.js';
import { insertEvent } from './events.js';
import type {
  AlertRecord,
  Battlecard,
  BattlecardRow,
  CompetitorChange,
  CompetitorChangeRow,
  ComparisonMatrix,
  ComparisonMatrixRow,
  QualityResult,
  ResearchInsight,
  ResearchInsightRow,
  Severity,
} from '@contracts/types.js';

/**
 * CI 产物读写（MySQL 异步版）。
 * 中间产物必须落库供下个 stage 读取；Reflexion 用 round 区分多轮历史。
 */

// ── 三级检测前级：页面哈希 ─────────────────────────────

/**
 * upsert 页面 SHA-256，返回该 URL 自上次以来是否变化。
 * MySQL ON DUPLICATE KEY UPDATE 原子实现（避免 read-then-write 竞态）。
 */
export async function upsertPageHash(input: { competitor_id: string; url: string; sha256: string; title?: string | null }): Promise<{ changed: boolean }> {
  return withTransaction(async () => {
    const existingRows = await query<{ sha256: string }>(
      `SELECT sha256 FROM competitor_pages WHERE competitor_id = ? AND url = ?`,
      [input.competitor_id, input.url]
    );
    const existing = existingRows[0];
    const changed = !existing || existing.sha256 !== input.sha256;
    const now = nowIso();
    await exec(
      `INSERT INTO competitor_pages (id, competitor_id, url, sha256, title, last_fetched_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE sha256 = VALUES(sha256), title = VALUES(title), last_fetched_at = VALUES(last_fetched_at)`,
      [newId(), input.competitor_id, input.url, input.sha256, input.title ?? null, now, now]
    );
    return { changed };
  });
}

export async function getPageHash(competitorId: string, url: string): Promise<string | null> {
  const rows = await query<{ sha256: string }>(
    `SELECT sha256 FROM competitor_pages WHERE competitor_id = ? AND url = ?`,
    [competitorId, url]
  );
  return rows[0]?.sha256 ?? null;
}

// ── 竞品变化 ───────────────────────────────────────────

/**
 * 批量插入变化。UNIQUE(competitor_id, content_hash) 去重：
 * 同页同变化重复监控只记一次。MySQL INSERT IGNORE 实现（影响行数=0 表示重复）。
 */
export async function insertChanges(
  competitorId: string,
  changes: CompetitorChange[],
  taskId: string
): Promise<{ inserted: number }> {
  return withTransaction(async () => {
    let inserted = 0;
    for (const c of changes) {
      const hash = c.raw_data ? sha256(JSON.stringify(c.raw_data)) : `${c.url}|${c.change_type}`;
      const affected = await exec(
        `INSERT IGNORE INTO competitor_changes
           (id, competitor_id, change_type, title, summary, url, severity, content_hash, raw_data, task_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId(), competitorId, c.change_type, c.title, c.summary, c.url,
          c.severity, hash, JSON.stringify(c.raw_data ?? null), taskId, nowIso()]
      );
      if (affected === 1) inserted++;
    }
    if (inserted > 0) {
      await insertEvent({
        task_id: taskId,
        type: 'ci_change_detected',
        payload: { competitor_id: competitorId, inserted },
      });
    }
    return { inserted };
  });
}

export interface ListChangesOptions {
  severity?: Severity;
  limit?: number;
}

export async function listChanges(competitorId: string, opts: ListChangesOptions = {}): Promise<CompetitorChangeRow[]> {
  const conds = ['competitor_id = ?'];
  const params: (string | number)[] = [competitorId];
  if (opts.severity) { conds.push('severity = ?'); params.push(opts.severity); }
  const limit = Math.min(opts.limit ?? 50, 200);
  return query<CompetitorChangeRow>(
    `SELECT * FROM competitor_changes WHERE ${conds.join(' AND ')}
     ORDER BY created_at DESC LIMIT ?`,
    [...params, limit]
  );
}

/** 该竞品所有 high/critical 变化（含已告警的——供 alert 去重） */
export async function listHighCriticalChanges(competitorId: string, limit = 100): Promise<CompetitorChangeRow[]> {
  return query<CompetitorChangeRow>(
    `SELECT * FROM competitor_changes
     WHERE competitor_id = ? AND severity IN ('high','critical')
     ORDER BY created_at DESC LIMIT ?`,
    [competitorId, limit]
  );
}

/** 尚未被告警覆盖的 high/critical 变化（alerts 已记录过 change_id 的排除） */
export async function pendingHighCriticalChanges(competitorId: string): Promise<CompetitorChangeRow[]> {
  return query<CompetitorChangeRow>(
    `SELECT c.* FROM competitor_changes c
     LEFT JOIN alerts a ON a.change_id = c.id
     WHERE c.competitor_id = ? AND c.severity IN ('high','critical') AND a.id IS NULL
     ORDER BY c.created_at ASC`,
    [competitorId]
  );
}

// ── 调研洞察 ───────────────────────────────────────────

export async function insertInsight(
  competitorId: string,
  insight: ResearchInsight,
  round: number,
  feedback: string | null,
  taskId: string
): Promise<ResearchInsightRow> {
  const row: ResearchInsightRow = {
    id: newId(),
    competitor_id: competitorId,
    topic: insight.topic,
    summary: insight.summary,
    key_findings: insight.key_findings,
    sources: insight.sources,
    confidence: insight.confidence,
    round,
    feedback,
    task_id: taskId,
    created_at: nowIso(),
  };
  await exec(
    `INSERT INTO research_insights
       (id, competitor_id, topic, summary, key_findings, sources, confidence, round, feedback, task_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.competitor_id, row.topic, row.summary,
      JSON.stringify(row.key_findings), JSON.stringify(row.sources),
      row.confidence, row.round, row.feedback, row.task_id, row.created_at]
  );
  await insertEvent({
    task_id: taskId,
    type: 'ci_insight_created',
    payload: { competitor_id: competitorId, topic: row.topic, round },
  });
  return row;
}

export async function latestInsights(competitorId: string, round?: number): Promise<ResearchInsightRow[]> {
  const conds = ['competitor_id = ?'];
  const params: (string | number)[] = [competitorId];
  if (round !== undefined) { conds.push('round = ?'); params.push(round); }
  return query<ResearchInsightRow>(
    `SELECT * FROM research_insights WHERE ${conds.join(' AND ')}
     ORDER BY created_at DESC LIMIT 20`,
    params
  );
}

// ── 对比矩阵 ───────────────────────────────────────────

export async function insertMatrix(
  competitorId: string,
  m: ComparisonMatrix,
  round: number,
  taskId: string
): Promise<ComparisonMatrixRow> {
  const row: ComparisonMatrixRow = {
    id: newId(),
    competitor_id: competitorId,
    dimensions: m.dimensions,
    overall_assessment: m.overall_assessment,
    round,
    task_id: taskId,
    created_at: nowIso(),
  };
  await exec(
    `INSERT INTO comparison_matrices (id, competitor_id, dimensions, overall_assessment, round, task_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.competitor_id, JSON.stringify(row.dimensions), row.overall_assessment, row.round, row.task_id, row.created_at]
  );
  await insertEvent({
    task_id: taskId,
    type: 'ci_matrix_created',
    payload: { competitor_id: competitorId, dimensions: row.dimensions.length, round },
  });
  return row;
}

export async function latestMatrix(competitorId: string, round?: number): Promise<ComparisonMatrixRow | null> {
  const conds = ['competitor_id = ?'];
  const params: (string | number)[] = [competitorId];
  if (round !== undefined) { conds.push('round = ?'); params.push(round); }
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM comparison_matrices WHERE ${conds.join(' AND ')} ORDER BY created_at DESC LIMIT 1`,
    params
  );
  return rows[0] ? mapMatrixRow(rows[0]) : null;
}

function mapMatrixRow(r: Record<string, unknown>): ComparisonMatrixRow {
  let dimensions: ComparisonMatrix['dimensions'] = [];
  try { dimensions = JSON.parse(r.dimensions as string) as ComparisonMatrix['dimensions']; } catch { /* ignore */ }
  return {
    id: r.id as string, competitor_id: r.competitor_id as string,
    dimensions, overall_assessment: r.overall_assessment as string,
    round: Number(r.round), task_id: (r.task_id as string | null) ?? null, created_at: r.created_at as string,
  };
}

// ── 战卡 ───────────────────────────────────────────────

export async function insertBattlecard(
  competitorId: string,
  b: Battlecard,
  round: number,
  taskId: string
): Promise<BattlecardRow> {
  const row: BattlecardRow = {
    id: newId(),
    competitor_id: competitorId,
    content: b,
    quality_score: null,
    quality_detail: null,
    round,
    task_id: taskId,
    created_at: nowIso(),
  };
  await exec(
    `INSERT INTO battlecards (id, competitor_id, content, quality_score, quality_detail, round, task_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.competitor_id, JSON.stringify(row.content), null, null, row.round, row.task_id, row.created_at]
  );
  await insertEvent({
    task_id: taskId,
    type: 'ci_battlecard_created',
    payload: { competitor_id: competitorId, round },
  });
  return row;
}

export async function latestBattlecard(competitorId: string): Promise<BattlecardRow | null> {
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM battlecards WHERE competitor_id = ? ORDER BY created_at DESC LIMIT 1`,
    [competitorId]
  );
  return rows[0] ? mapBattlecardRow(rows[0]) : null;
}

function mapBattlecardRow(r: Record<string, unknown>): BattlecardRow {
  let content: Battlecard = {
    our_strengths: [], our_weaknesses: [], competitor_strengths: [],
    competitor_weaknesses: [], key_differentiators: [],
    objection_handling: {}, elevator_pitch: '',
  };
  try { content = JSON.parse(r.content as string) as Battlecard; } catch { /* ignore */ }
  return {
    id: r.id as string, competitor_id: r.competitor_id as string,
    content,
    quality_score: r.quality_score === null || r.quality_score === undefined ? null : Number(r.quality_score),
    quality_detail: (r.quality_detail as string | null) ?? null,
    round: Number(r.round), task_id: (r.task_id as string | null) ?? null, created_at: r.created_at as string,
  };
}

export async function listBattlecards(competitorId: string, limit = 10): Promise<BattlecardRow[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM battlecards WHERE competitor_id = ? ORDER BY created_at DESC LIMIT ?`,
    [competitorId, limit]
  );
  return rows.map(mapBattlecardRow);
}

/** quality 阶段回填战卡质检结果 */
export async function setBattlecardQuality(battlecardId: string, q: QualityResult): Promise<void> {
  await exec(
    `UPDATE battlecards SET quality_score = ?, quality_detail = ? WHERE id = ?`,
    [q.score, q.feedback, battlecardId]
  );
}

// ── 告警 ───────────────────────────────────────────────

export interface InsertAlertInput {
  competitor_id: string | null;
  change_id?: string | null;
  channel?: string;
  recipient?: string;
  payload?: string;
}

export async function insertAlert(input: InsertAlertInput): Promise<AlertRecord> {
  const row: AlertRecord = {
    id: newId(),
    competitor_id: input.competitor_id,
    change_id: input.change_id ?? null,
    channel: input.channel ?? 'email',
    status: 'pending',
    recipient: input.recipient ?? null,
    payload: input.payload ?? null,
    error: null,
    created_at: nowIso(),
    sent_at: null,
  };
  await exec(
    `INSERT INTO alerts (id, competitor_id, change_id, channel, status, recipient, payload, error, created_at, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.competitor_id, row.change_id, row.channel, row.status,
      row.recipient, row.payload, row.error, row.created_at, row.sent_at]
  );
  return row;
}

export async function updateAlertStatus(id: string, status: string, error?: string | null): Promise<void> {
  const sets: string[] = ['status = ?'];
  const params: (string | null)[] = [status];
  if (status === 'sent') { sets.push('sent_at = ?'); params.push(nowIso()); }
  if (error !== undefined) { sets.push('error = ?'); params.push(error); }
  params.push(id);
  await exec(`UPDATE alerts SET ${sets.join(', ')} WHERE id = ?`, params);
}

export async function listAlerts(filter: { status?: string; limit?: number } = {}): Promise<AlertRecord[]> {
  const conds: string[] = [];
  const params: (string | number)[] = [];
  if (filter.status) { conds.push('status = ?'); params.push(filter.status); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const limit = Math.min(filter.limit ?? 50, 200);
  return query<AlertRecord>(
    `SELECT * FROM alerts ${where} ORDER BY created_at DESC LIMIT ?`,
    [...params, limit]
  );
}

// ── 工具 ───────────────────────────────────────────────

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
