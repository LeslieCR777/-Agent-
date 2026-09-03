import { createHash, timingSafeEqual } from 'node:crypto';
import { exec, newId, nowIso, query, withTransaction } from '../index.js';
import {
  REPORT_TRANSITIONS,
  RUN_STAGE_PROGRESS,
  RUN_TRANSITIONS,
  assertTransition,
  parseJson,
  type ReportStatus,
  type ReviewStatus,
  type RunStatus,
  type StageStatus,
} from '@domain/analysis.js';
import type { CiStage } from '@contracts/types.js';

type Json = Record<string, unknown>;

export interface AnalysisBrief {
  id: string;
  our_product_id: string | null;
  competitor_ids: string[];
  purpose: string;
  market: string;
  time_range_start: string | null;
  time_range_end: string | null;
  included_sources: string[];
  excluded_sources: string[];
  max_runtime_seconds: number;
  cost_budget: number;
  allow_unverified: number;
  created_by: string;
  created_at: string;
}

export interface AnalysisRun {
  id: string;
  brief_id: string;
  status: RunStatus;
  current_stage: string | null;
  progress: number;
  snapshot: Json;
  model_version: string | null;
  prompt_version: string | null;
  token_count: number;
  search_count: number;
  estimated_cost: number;
  error_code: string | null;
  error_message: string | null;
  created_by: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  cancelled_at: string | null;
}

export interface RunStage {
  id: string;
  run_id: string;
  stage: Exclude<CiStage, 'daily_monitor'>;
  round: number;
  status: StageStatus;
  attempt: number;
  task_id: string | null;
  input_ref: Json | null;
  output_ref: Json | null;
  model: string | null;
  prompt_version: string | null;
  tools: string[];
  token_count: number;
  estimated_cost: number;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

function mapBrief(row: Record<string, unknown>): AnalysisBrief {
  return {
    ...(row as unknown as AnalysisBrief),
    competitor_ids: parseJson(row.competitor_ids, []),
    included_sources: parseJson(row.included_sources, []),
    excluded_sources: parseJson(row.excluded_sources, []),
    max_runtime_seconds: Number(row.max_runtime_seconds),
    cost_budget: Number(row.cost_budget),
    allow_unverified: Number(row.allow_unverified),
  };
}

function mapRun(row: Record<string, unknown>): AnalysisRun {
  return {
    ...(row as unknown as AnalysisRun),
    snapshot: parseJson(row.snapshot, {}),
    progress: Number(row.progress),
    token_count: Number(row.token_count),
    search_count: Number(row.search_count),
    estimated_cost: Number(row.estimated_cost),
  };
}

function mapStage(row: Record<string, unknown>): RunStage {
  return {
    ...(row as unknown as RunStage),
    round: Number(row.round),
    attempt: Number(row.attempt),
    input_ref: row.input_ref ? parseJson(row.input_ref, {}) : null,
    output_ref: row.output_ref ? parseJson(row.output_ref, {}) : null,
    tools: parseJson(row.tools, []),
    token_count: Number(row.token_count),
    estimated_cost: Number(row.estimated_cost),
  };
}

export async function createAnalysisBrief(input: Omit<AnalysisBrief, 'id' | 'created_at' | 'allow_unverified'> & { allow_unverified: boolean }): Promise<AnalysisBrief> {
  const row = {
    ...input,
    id: newId(),
    allow_unverified: input.allow_unverified ? 1 : 0,
    created_at: nowIso(),
  };
  await exec(
    `INSERT INTO analysis_briefs
      (id, our_product_id, competitor_ids, purpose, market, time_range_start, time_range_end,
       included_sources, excluded_sources, max_runtime_seconds, cost_budget, allow_unverified, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.our_product_id, JSON.stringify(row.competitor_ids), row.purpose, row.market,
      row.time_range_start, row.time_range_end, JSON.stringify(row.included_sources),
      JSON.stringify(row.excluded_sources), row.max_runtime_seconds, row.cost_budget,
      row.allow_unverified, row.created_by, row.created_at]
  );
  await writeAudit(input.created_by, 'brief.create', 'analysis_brief', row.id, null, row);
  return row;
}

export async function getAnalysisBrief(id: string): Promise<AnalysisBrief | null> {
  const rows = await query<Record<string, unknown>>('SELECT * FROM analysis_briefs WHERE id = ?', [id]);
  return rows[0] ? mapBrief(rows[0]) : null;
}

export async function createRun(input: {
  brief: AnalysisBrief;
  snapshot: Json;
  actor: string;
  modelVersion?: string;
  promptVersion?: string;
}): Promise<AnalysisRun> {
  return withTransaction(async () => {
    const now = nowIso();
    const row: AnalysisRun = {
      id: newId(), brief_id: input.brief.id, status: 'queued', current_stage: 'monitor',
      progress: 0, snapshot: input.snapshot, model_version: input.modelVersion ?? null,
      prompt_version: input.promptVersion ?? 'p1-v1', token_count: 0, search_count: 0,
      estimated_cost: 0, error_code: null, error_message: null, created_by: input.actor,
      created_at: now, started_at: null, finished_at: null, cancelled_at: null,
    };
    await exec(
      `INSERT INTO ci_runs
       (id, brief_id, status, current_stage, progress, snapshot, model_version, prompt_version,
        token_count, search_count, estimated_cost, error_code, error_message, created_by, created_at,
        started_at, finished_at, cancelled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.brief_id, row.status, row.current_stage, row.progress, JSON.stringify(row.snapshot),
        row.model_version, row.prompt_version, 0, 0, 0, null, null, row.created_by, now, null, null, null]
    );
    await enqueueOutbox('ci_run', row.id, 'run.queued', { run_id: row.id, brief_id: row.brief_id });
    await writeAudit(input.actor, 'run.create', 'ci_run', row.id, null, row);
    return row;
  });
}

export async function getRun(id: string): Promise<AnalysisRun | null> {
  const rows = await query<Record<string, unknown>>('SELECT * FROM ci_runs WHERE id = ?', [id]);
  return rows[0] ? mapRun(rows[0]) : null;
}

export async function listRuns(filter: {
  status?: RunStatus; competitorId?: string; briefId?: string; productId?: string; purpose?: string;
  from?: string; to?: string; page?: number; size?: number;
}): Promise<{ runs: AnalysisRun[]; total: number; page: number; size: number }> {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (filter.status) { conds.push('r.status = ?'); params.push(filter.status); }
  if (filter.briefId) { conds.push('r.brief_id = ?'); params.push(filter.briefId); }
  if (filter.competitorId) { conds.push('b.competitor_ids LIKE ?'); params.push(`%${filter.competitorId}%`); }
  if (filter.productId) { conds.push('b.our_product_id = ?'); params.push(filter.productId); }
  if (filter.purpose) { conds.push('b.purpose = ?'); params.push(filter.purpose); }
  if (filter.from) { conds.push('r.created_at >= ?'); params.push(filter.from); }
  if (filter.to) { conds.push('r.created_at <= ?'); params.push(filter.to); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const page = Math.max(1, filter.page ?? 1);
  const size = Math.min(100, Math.max(1, filter.size ?? 20));
  const totals = await query<{ n: number }>(
    `SELECT COUNT(*) n FROM ci_runs r JOIN analysis_briefs b ON b.id = r.brief_id ${where}`, params
  );
  const rows = await query<Record<string, unknown>>(
    `SELECT r.* FROM ci_runs r JOIN analysis_briefs b ON b.id = r.brief_id
     ${where} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`, [...params, size, (page - 1) * size]
  );
  return { runs: rows.map(mapRun), total: Number(totals[0]?.n ?? 0), page, size };
}

export async function listRunStages(runId: string): Promise<RunStage[]> {
  const rows = await query<Record<string, unknown>>(
    'SELECT * FROM ci_run_stages WHERE run_id = ? ORDER BY round, created_at', [runId]
  );
  return rows.map(mapStage);
}

export async function reserveRunStage(input: {
  runId: string; stage: Exclude<CiStage, 'daily_monitor'>; round: number; input?: Json;
  model?: string; promptVersion?: string; tools?: string[];
}): Promise<{ stage: RunStage; created: boolean }> {
  return withTransaction(async () => {
    const existing = await query<Record<string, unknown>>(
      'SELECT * FROM ci_run_stages WHERE run_id = ? AND stage = ? AND round = ? FOR UPDATE',
      [input.runId, input.stage, input.round]
    );
    if (existing[0]) return { stage: mapStage(existing[0]), created: false };
    const now = nowIso();
    const id = newId();
    await exec(
      `INSERT INTO ci_run_stages
       (id, run_id, stage, round, status, attempt, task_id, input_ref, output_ref, model,
        prompt_version, tools, token_count, estimated_cost, error_message, started_at, finished_at, created_at)
       VALUES (?, ?, ?, ?, 'queued', 0, NULL, ?, NULL, ?, ?, ?, 0, 0, NULL, NULL, NULL, ?)`,
      [id, input.runId, input.stage, input.round, JSON.stringify(input.input ?? {}),
        input.model ?? null, input.promptVersion ?? null, JSON.stringify(input.tools ?? []), now]
    );
    await enqueueOutbox('ci_run', input.runId, 'stage.queued', { stage_id: id, stage: input.stage, round: input.round });
    const created = await query<Record<string, unknown>>('SELECT * FROM ci_run_stages WHERE id = ?', [id]);
    return { stage: mapStage(created[0]), created: true };
  });
}

export async function attachStageTask(stageId: string, taskId: string): Promise<void> {
  await exec('UPDATE ci_run_stages SET task_id = ? WHERE id = ? AND task_id IS NULL', [taskId, stageId]);
}

export async function getStageByTask(taskId: string): Promise<RunStage | null> {
  const rows = await query<Record<string, unknown>>('SELECT * FROM ci_run_stages WHERE task_id = ?', [taskId]);
  return rows[0] ? mapStage(rows[0]) : null;
}

export async function markStageRunning(taskId: string): Promise<void> {
  await withTransaction(async () => {
    const stage = await getStageByTask(taskId);
    if (!stage || stage.status === 'completed' || stage.status === 'cancelled') return;
    const now = nowIso();
    await exec(
      `UPDATE ci_run_stages SET status = 'running', attempt = attempt + 1,
       started_at = COALESCE(started_at, ?), error_message = NULL WHERE id = ?`, [now, stage.id]
    );
    await exec(
      `UPDATE ci_runs SET status = 'running', current_stage = ?, started_at = COALESCE(started_at, ?),
       error_code = NULL, error_message = NULL WHERE id = ? AND status IN ('queued','running','waiting_review','failed')`,
      [stage.stage, now, stage.run_id]
    );
  });
}

export async function markStageCompleted(taskId: string, outputRef: Json = {}): Promise<void> {
  await withTransaction(async () => {
    const stage = await getStageByTask(taskId);
    if (!stage || stage.status === 'completed') return;
    const run = await getRun(stage.run_id);
    const purpose = (run?.snapshot.brief as { purpose?: string } | undefined)?.purpose;
    const completedProgress = purpose === 'competitor_only' && stage.stage === 'compare' ? 100 : RUN_STAGE_PROGRESS[stage.stage];
    const now = nowIso();
    await exec(
      `UPDATE ci_run_stages SET status = 'completed', output_ref = ?, finished_at = ?, error_message = NULL WHERE id = ?`,
      [JSON.stringify(outputRef), now, stage.id]
    );
    await exec(
      'UPDATE ci_runs SET progress = GREATEST(progress, ?), current_stage = ? WHERE id = ?',
      [completedProgress, stage.stage, stage.run_id]
    );
    await enqueueOutbox('ci_run', stage.run_id, 'stage.completed', {
      stage_id: stage.id, stage: stage.stage, round: stage.round, output: outputRef,
    });
  });
}

export async function markStageFailed(taskId: string, error: string): Promise<void> {
  await withTransaction(async () => {
    const stage = await getStageByTask(taskId);
    if (!stage || stage.status === 'completed' || stage.status === 'cancelled') return;
    const now = nowIso();
    await exec('UPDATE ci_run_stages SET status = \'failed\', error_message = ?, finished_at = ? WHERE id = ?', [error, now, stage.id]);
    await exec(
      `UPDATE ci_runs SET status = 'failed', error_code = 'STAGE_FAILED', error_message = ?,
       current_stage = ?, finished_at = ? WHERE id = ?`, [error, stage.stage, now, stage.run_id]
    );
    await enqueueOutbox('ci_run', stage.run_id, 'stage.failed', { stage_id: stage.id, error });
  });
}

export async function transitionRun(runId: string, to: RunStatus, actor: string, error?: string): Promise<AnalysisRun> {
  return withTransaction(async () => {
    const before = await getRun(runId);
    if (!before) throw new Error('NOT_FOUND');
    assertTransition(RUN_TRANSITIONS, before.status, to);
    const sets = ['status = ?'];
    const params: unknown[] = [to];
    if (to === 'cancelled') { sets.push('cancelled_at = ?', 'finished_at = ?'); params.push(nowIso(), nowIso()); }
    if (to === 'published') { sets.push('finished_at = ?', 'progress = 100'); params.push(nowIso()); }
    if (error) { sets.push('error_message = ?'); params.push(error); }
    params.push(runId);
    await exec(`UPDATE ci_runs SET ${sets.join(', ')} WHERE id = ?`, params);
    if (to === 'cancelled') {
      await exec(`UPDATE ci_run_stages SET status = 'cancelled', finished_at = ?
        WHERE run_id = ? AND status IN ('queued','running','failed')`, [nowIso(), runId]);
      await exec(`UPDATE tasks t JOIN ci_run_stages s ON s.task_id = t.id
        SET t.status = 'superseded', t.finished_at = ?
        WHERE s.run_id = ? AND t.status IN ('unassigned','claimed','in_progress')`, [nowIso(), runId]);
    }
    const after = (await getRun(runId))!;
    await enqueueOutbox('ci_run', runId, `run.${to}`, { run_id: runId });
    await writeAudit(actor, `run.${to}`, 'ci_run', runId, before, after);
    return after;
  });
}

export async function retryFailedStage(runId: string, actor: string): Promise<RunStage> {
  return withTransaction(async () => {
    const run = await getRun(runId);
    if (!run) throw new Error('NOT_FOUND');
    if (run.status !== 'failed') throw new Error('RUN_NOT_FAILED');
    const rows = await query<Record<string, unknown>>(
      `SELECT * FROM ci_run_stages WHERE run_id = ? AND status = 'failed'
       ORDER BY finished_at DESC LIMIT 1 FOR UPDATE`, [runId]
    );
    if (!rows[0]) throw new Error('NO_FAILED_STAGE');
    const stage = mapStage(rows[0]);
    await exec(
      `UPDATE ci_run_stages SET status = 'queued', task_id = NULL, error_message = NULL,
       started_at = NULL, finished_at = NULL WHERE id = ?`, [stage.id]
    );
    await exec(`UPDATE ci_runs SET status = 'queued', error_code = NULL, error_message = NULL,
      started_at = NULL, finished_at = NULL WHERE id = ?`, [runId]);
    await enqueueOutbox('ci_run', runId, 'stage.retry_requested', { stage_id: stage.id, actor });
    return { ...stage, status: 'queued', task_id: null, error_message: null, started_at: null, finished_at: null };
  });
}

export async function evidenceGate(runId: string): Promise<{
  allowed: boolean; allow_unverified: boolean; total: number; verified: number; rejected: number;
}> {
  const run = await getRun(runId);
  if (!run) throw new Error('NOT_FOUND');
  const policy = (run.snapshot.source_policy ?? {}) as { allow_unverified?: boolean };
  const rows = await query<{ total: number; verified: number; rejected: number }>(
    `SELECT COUNT(*) total,
      SUM(CASE WHEN status = 'verified' THEN 1 ELSE 0 END) verified,
      SUM(CASE WHEN status IN ('rejected','expired') THEN 1 ELSE 0 END) rejected
     FROM claims WHERE run_id = ?`, [runId]
  );
  const total = Number(rows[0]?.total ?? 0);
  const verified = Number(rows[0]?.verified ?? 0);
  const rejected = Number(rows[0]?.rejected ?? 0);
  const allowUnverified = Boolean(policy.allow_unverified);
  return {
    allowed: rejected === 0 && total > 0 && (allowUnverified || verified === total),
    allow_unverified: allowUnverified, total, verified, rejected,
  };
}

export async function enqueueOutbox(aggregateType: string, aggregateId: string, eventType: string, payload: unknown): Promise<void> {
  const now = nowIso();
  await exec(
    `INSERT INTO outbox_events
     (id, aggregate_type, aggregate_id, event_type, payload, status, attempts, available_at, processed_at, last_error, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, ?)`,
    [newId(), aggregateType, aggregateId, eventType, JSON.stringify(payload), now, now]
  );
}

export async function requestRunResume(runId: string, actor: string): Promise<AnalysisRun> {
  return withTransaction(async () => {
    const run = await getRun(runId);
    if (!run) throw new Error('NOT_FOUND');
    if (run.status !== 'waiting_review') throw new Error('RUN_NOT_WAITING_REVIEW');
    const gate = await evidenceGate(runId);
    if (!gate.allowed) throw new Error('EVIDENCE_GATE_FAILED');
    await exec(`UPDATE ci_runs SET status = 'queued', error_code = NULL, error_message = NULL WHERE id = ?`, [runId]);
    await enqueueOutbox('ci_run', runId, 'run.resume_requested', { run_id: runId, actor });
    const after = (await getRun(runId))!;
    await writeAudit(actor, 'run.resume_requested', 'ci_run', runId, run, after);
    return after;
  });
}

export async function requestLegacyPipeline(competitorId: string, mode: 'full' | 'monitor', actor: string): Promise<string> {
  const requestId = newId();
  await enqueueOutbox('competitor', competitorId, 'legacy.pipeline_requested', {
    request_id: requestId, competitor_id: competitorId, mode, actor,
  });
  return requestId;
}

export interface OutboxEvent {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Json;
  attempts: number;
}

export async function claimOutboxEvent(): Promise<OutboxEvent | null> {
  return withTransaction(async () => {
    const rows = await query<Record<string, unknown>>(
      `SELECT * FROM outbox_events
       WHERE status = 'pending' AND available_at <= ?
       ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`, [nowIso()]
    );
    if (!rows[0]) return null;
    const row = rows[0];
    const changed = await exec(
      `UPDATE outbox_events SET status = 'processing', attempts = attempts + 1
       WHERE id = ? AND status = 'pending'`, [row.id]
    );
    if (changed !== 1) return null;
    return {
      id: String(row.id), aggregate_type: String(row.aggregate_type),
      aggregate_id: String(row.aggregate_id), event_type: String(row.event_type),
      payload: parseJson(row.payload, {}), attempts: Number(row.attempts) + 1,
    };
  });
}

export async function completeOutboxEvent(id: string): Promise<void> {
  await exec(
    `UPDATE outbox_events SET status = 'processed', processed_at = ?, last_error = NULL WHERE id = ?`,
    [nowIso(), id]
  );
}

export async function retryOutboxEvent(id: string, attempts: number, error: string): Promise<void> {
  const delaySeconds = Math.min(300, 2 ** Math.min(attempts, 8));
  const available = new Date(Date.now() + delaySeconds * 1000).toISOString();
  await exec(
    `UPDATE outbox_events SET status = 'pending', available_at = ?, last_error = ? WHERE id = ?`,
    [available, error.slice(0, 2000), id]
  );
}

export async function writeAudit(
  actor: string, action: string, resourceType: string, resourceId: string,
  before: unknown, after: unknown, traceId = newId()
): Promise<void> {
  await exec(
    `INSERT INTO audit_logs
     (id, actor, action, resource_type, resource_id, before_data, after_data, trace_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [newId(), actor, action, resourceType, resourceId,
      before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after), traceId, nowIso()]
  );
}

export interface EvidenceInput {
  run_id: string; competitor_id?: string | null; request_url: string; final_url?: string;
  title?: string | null; http_status?: number | null; content_type?: string | null;
  body_hash: string; snapshot_uri?: string | null; raw_content?: string | null;
  source_type?: string; market?: string | null; language?: string | null; published_at?: string | null;
}

export async function insertEvidence(input: EvidenceInput): Promise<Record<string, unknown>> {
  const existing = await query<Record<string, unknown>>(
    'SELECT * FROM evidence WHERE run_id = ? AND body_hash = ? AND request_url = ?',
    [input.run_id, input.body_hash, input.request_url]
  );
  if (existing[0]) return existing[0];
  const id = newId();
  const captured = nowIso();
  await exec(
    `INSERT INTO evidence
     (id, run_id, competitor_id, request_url, final_url, title, http_status, content_type,
      body_hash, snapshot_uri, raw_content, source_type, market, language, published_at,
      captured_at, status, reviewed_by, reviewed_at, review_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL)`,
    [id, input.run_id, input.competitor_id ?? null, input.request_url, input.final_url ?? input.request_url,
      input.title ?? null, input.http_status ?? null, input.content_type ?? null, input.body_hash,
      input.snapshot_uri ?? null, input.raw_content ?? null, input.source_type ?? 'website',
      input.market ?? null, input.language ?? null, input.published_at ?? null, captured]
  );
  return (await query<Record<string, unknown>>('SELECT * FROM evidence WHERE id = ?', [id]))[0];
}

export async function listEvidence(filter: {
  runId?: string; competitorId?: string; status?: ReviewStatus; sourceType?: string;
  market?: string; from?: string; to?: string; page?: number; size?: number;
}): Promise<{ evidence: Record<string, unknown>[]; total: number; page: number; size: number }> {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (filter.runId) { conds.push('run_id = ?'); params.push(filter.runId); }
  if (filter.competitorId) { conds.push('competitor_id = ?'); params.push(filter.competitorId); }
  if (filter.status) { conds.push('status = ?'); params.push(filter.status); }
  if (filter.sourceType) { conds.push('source_type = ?'); params.push(filter.sourceType); }
  if (filter.market) { conds.push('market = ?'); params.push(filter.market); }
  if (filter.from) { conds.push('captured_at >= ?'); params.push(filter.from); }
  if (filter.to) { conds.push('captured_at <= ?'); params.push(filter.to); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const page = Math.max(1, filter.page ?? 1);
  const size = Math.min(100, Math.max(1, filter.size ?? 20));
  const count = await query<{ n: number }>(`SELECT COUNT(*) n FROM evidence ${where}`, params);
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM evidence ${where} ORDER BY captured_at DESC LIMIT ? OFFSET ?`,
    [...params, size, (page - 1) * size]
  );
  return { evidence: rows, total: Number(count[0]?.n ?? 0), page, size };
}

export async function reviewEvidence(id: string, status: ReviewStatus, actor: string, reason: string): Promise<Record<string, unknown>> {
  return withTransaction(async () => {
    const rows = await query<Record<string, unknown>>('SELECT * FROM evidence WHERE id = ? FOR UPDATE', [id]);
    const before = rows[0];
    if (!before) throw new Error('NOT_FOUND');
    const now = nowIso();
    await exec(
      'UPDATE evidence SET status = ?, reviewed_by = ?, reviewed_at = ?, review_reason = ? WHERE id = ?',
      [status, actor, now, reason, id]
    );
    if (status === 'rejected' || status === 'expired') {
      await exec(
        `UPDATE claims c JOIN claim_evidence ce ON ce.claim_id = c.id
         SET c.status = 'rejected', c.invalidated_at = ?
         WHERE ce.evidence_id = ? AND c.status <> 'rejected'`, [now, id]
      );
      await exec(
        `UPDATE artifact_claims ac JOIN claim_evidence ce ON ce.claim_id = ac.claim_id
         SET ac.validity = 'invalid' WHERE ce.evidence_id = ?`, [id]
      );
      await exec(
        `UPDATE reports r JOIN artifact_claims ac ON ac.artifact_type = 'report' AND ac.artifact_id = r.id
         JOIN claim_evidence ce ON ce.claim_id = ac.claim_id
         SET r.invalidated = 1, r.invalid_reason = '依赖的证据已驳回或过期'
         WHERE ce.evidence_id = ? AND r.status IN ('approved','published')`, [id]
      );
    }
    const after = (await query<Record<string, unknown>>('SELECT * FROM evidence WHERE id = ?', [id]))[0];
    await writeAudit(actor, `evidence.${status}`, 'evidence', id, before, after);
    return after;
  });
}

export async function createClaim(input: {
  run_id: string; statement: string; subject: string; claim_type?: string; market?: string | null;
  valid_at?: string | null; confidence: number; evidence_ids: string[];
}): Promise<Record<string, unknown>> {
  return withTransaction(async () => {
    const evidence = input.evidence_ids.length
      ? await query<{ id: string; run_id: string }>(
          `SELECT id, run_id FROM evidence WHERE id IN (${input.evidence_ids.map(() => '?').join(',')})`,
          input.evidence_ids
        )
      : [];
    if (evidence.length !== input.evidence_ids.length || evidence.some((e) => e.run_id !== input.run_id)) {
      throw new Error('INVALID_EVIDENCE_REFERENCE');
    }
    const id = newId();
    await exec(
      `INSERT INTO claims
       (id, run_id, statement, subject, claim_type, market, valid_at, confidence, status,
        invalidated_at, reviewed_by, reviewed_at, review_reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, ?)`,
      [id, input.run_id, input.statement, input.subject, input.claim_type ?? 'general',
        input.market ?? null, input.valid_at ?? null, input.confidence, nowIso()]
    );
    for (const evidenceId of input.evidence_ids) {
      await exec('INSERT INTO claim_evidence (claim_id, evidence_id, relation) VALUES (?, ?, \'supports\')', [id, evidenceId]);
    }
    return (await query<Record<string, unknown>>('SELECT * FROM claims WHERE id = ?', [id]))[0];
  });
}

export async function reviewClaim(id: string, status: ReviewStatus, actor: string, reason: string): Promise<Record<string, unknown>> {
  return withTransaction(async () => {
    const rows = await query<Record<string, unknown>>('SELECT * FROM claims WHERE id = ? FOR UPDATE', [id]);
    const before = rows[0];
    if (!before) throw new Error('NOT_FOUND');
    if (status === 'verified') {
      const sources = await query<{ status: string }>(
        `SELECT e.status FROM evidence e JOIN claim_evidence ce ON ce.evidence_id = e.id WHERE ce.claim_id = ?`, [id]
      );
      if (!sources.length || sources.some((e) => e.status !== 'verified')) {
        throw new Error('EVIDENCE_GATE_FAILED');
      }
      const type = String(before.claim_type);
      if (['market_share', 'sales'].includes(type) && sources.filter((e) => e.status === 'verified').length < 2) {
        throw new Error('TWO_SOURCES_REQUIRED');
      }
    }
    await exec(
      `UPDATE claims SET status = ?, reviewed_by = ?, reviewed_at = ?, review_reason = ?,
       invalidated_at = CASE
         WHEN ? IN ('rejected','expired') THEN ?
         WHEN ? = 'verified' THEN NULL
         ELSE invalidated_at END WHERE id = ?`,
      [status, actor, nowIso(), reason, status, nowIso(), status, id]
    );
    const after = (await query<Record<string, unknown>>('SELECT * FROM claims WHERE id = ?', [id]))[0];
    await writeAudit(actor, `claim.${status}`, 'claim', id, before, after);
    return after;
  });
}

export async function listClaims(filter: {
  runId?: string; status?: ReviewStatus; page?: number; size?: number;
}): Promise<{ claims: Record<string, unknown>[]; total: number; page: number; size: number }> {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (filter.runId) { conds.push('c.run_id = ?'); params.push(filter.runId); }
  if (filter.status) { conds.push('c.status = ?'); params.push(filter.status); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const page = Math.max(1, filter.page ?? 1);
  const size = Math.min(100, Math.max(1, filter.size ?? 20));
  const totals = await query<{ n: number }>(`SELECT COUNT(*) n FROM claims c ${where}`, params);
  const rows = await query<Record<string, unknown>>(
    `SELECT c.*, GROUP_CONCAT(ce.evidence_id) evidence_ids
     FROM claims c LEFT JOIN claim_evidence ce ON ce.claim_id = c.id
     ${where} GROUP BY c.id ORDER BY c.created_at DESC LIMIT ? OFFSET ?`,
    [...params, size, (page - 1) * size]
  );
  return {
    claims: rows.map((row) => ({
      ...row,
      evidence_ids: typeof row.evidence_ids === 'string' && row.evidence_ids ? row.evidence_ids.split(',') : [],
    })),
    total: Number(totals[0]?.n ?? 0), page, size,
  };
}

export async function reviewEvidenceBatch(
  ids: string[], status: ReviewStatus, actor: string, reason: string
): Promise<Record<string, unknown>[]> {
  if (ids.length > 100) throw new Error('BATCH_TOO_LARGE');
  const result: Record<string, unknown>[] = [];
  for (const id of ids) result.push(await reviewEvidence(id, status, actor, reason));
  return result;
}

export async function createReport(runId: string, content: Json, claimIds: string[], actor: string): Promise<Record<string, unknown>> {
  return withTransaction(async () => {
    if (!claimIds.length) throw new Error('CLAIMS_REQUIRED');
    const run = await getRun(runId);
    if (!run) throw new Error('NOT_FOUND');
    const verified = claimIds.length
      ? await query<{ id: string; status: string }>(
          `SELECT id, status FROM claims WHERE run_id = ? AND id IN (${claimIds.map(() => '?').join(',')})`,
          [runId, ...claimIds]
        )
      : [];
    if (verified.length !== claimIds.length || verified.some((c) => c.status !== 'verified')) {
      throw new Error('EVIDENCE_GATE_FAILED');
    }
    const versions = await query<{ n: number }>('SELECT COALESCE(MAX(version), 0) + 1 n FROM reports WHERE run_id = ?', [runId]);
    const id = newId();
    const version = Number(versions[0]?.n ?? 1);
    await exec(
      `INSERT INTO reports
       (id, run_id, version, status, content, invalidated, invalid_reason, approved_by,
        approved_at, published_at, created_by, created_at)
       VALUES (?, ?, ?, 'draft', ?, 0, NULL, NULL, NULL, NULL, ?, ?)`,
      [id, runId, version, JSON.stringify(content), actor, nowIso()]
    );
    for (const claimId of claimIds) {
      await exec(
        `INSERT INTO artifact_claims (artifact_type, artifact_id, claim_id, validity)
         VALUES ('report', ?, ?, 'valid')`, [id, claimId]
      );
    }
    return (await query<Record<string, unknown>>('SELECT * FROM reports WHERE id = ?', [id]))[0];
  });
}

export async function getReport(id: string): Promise<Record<string, unknown> | null> {
  const rows = await query<Record<string, unknown>>('SELECT * FROM reports WHERE id = ?', [id]);
  if (!rows[0]) return null;
  return { ...rows[0], content: parseJson(rows[0].content, {}) };
}

export async function getRunArtifacts(runId: string) {
  const [insights, matrices, battlecards, reports] = await Promise.all([
    query<Record<string, unknown>>(
      `SELECT i.* FROM research_insights i JOIN ci_run_stages s ON s.task_id=i.task_id
       WHERE s.run_id=? ORDER BY i.created_at DESC`, [runId]
    ),
    query<Record<string, unknown>>(
      `SELECT m.* FROM comparison_matrices m JOIN ci_run_stages s ON s.task_id=m.task_id
       WHERE s.run_id=? ORDER BY m.created_at DESC`, [runId]
    ),
    query<Record<string, unknown>>(
      `SELECT b.* FROM battlecards b JOIN ci_run_stages s ON s.task_id=b.task_id
       WHERE s.run_id=? ORDER BY b.created_at DESC`, [runId]
    ),
    query<Record<string, unknown>>('SELECT * FROM reports WHERE run_id=? ORDER BY version DESC', [runId]),
  ]);
  return {
    insights: insights.map((row) => ({ ...row, key_findings: parseJson(row.key_findings, []), sources: parseJson(row.sources, []) })),
    matrices: matrices.map((row) => ({ ...row, dimensions: parseJson(row.dimensions, []) })),
    battlecards: battlecards.map((row) => ({ ...row, content: parseJson(row.content, {}) })),
    reports: reports.map((row) => ({ ...row, content: parseJson(row.content, {}) })),
  };
}

export async function transitionReport(id: string, to: ReportStatus, actor: string): Promise<Record<string, unknown>> {
  return withTransaction(async () => {
    const before = await getReport(id);
    if (!before) throw new Error('NOT_FOUND');
    const from = before.status as ReportStatus;
    assertTransition(REPORT_TRANSITIONS, from, to);
    if (to === 'approved' || to === 'published') await assertReportGate(id);
    const sets = ['status = ?'];
    const params: unknown[] = [to];
    if (to === 'approved') { sets.push('approved_by = ?', 'approved_at = ?'); params.push(actor, nowIso()); }
    if (to === 'published') { sets.push('published_at = ?'); params.push(nowIso()); }
    params.push(id);
    await exec(`UPDATE reports SET ${sets.join(', ')} WHERE id = ?`, params);
    const after = (await getReport(id))!;
    await writeAudit(actor, `report.${to}`, 'report', id, before, after);
    if (to === 'published') {
      const run = await getRun(String(after.run_id));
      if (run?.status === 'waiting_review') await transitionRun(run.id, 'published', actor);
    }
    return after;
  });
}

async function assertReportGate(reportId: string): Promise<void> {
  const report = await getReport(reportId);
  if (!report || Number(report.invalidated)) throw new Error('REPORT_INVALIDATED');
  const bad = await query<{ n: number }>(
    `SELECT COUNT(*) n FROM artifact_claims ac JOIN claims c ON c.id = ac.claim_id
     WHERE ac.artifact_type = 'report' AND ac.artifact_id = ?
       AND (ac.validity <> 'valid' OR c.status <> 'verified')`, [reportId]
  );
  if (Number(bad[0]?.n ?? 0) > 0) throw new Error('EVIDENCE_GATE_FAILED');
}

export async function verifyServiceToken(token: string, requiredScope: string): Promise<boolean> {
  const hash = createHash('sha256').update(token).digest('hex');
  const rows = await query<{ token_hash: string; scopes: string; expires_at: string | null; revoked_at: string | null }>(
    'SELECT token_hash, scopes, expires_at, revoked_at FROM service_tokens WHERE token_hash = ?', [hash]
  );
  const row = rows[0];
  if (!row || row.revoked_at || (row.expires_at && Date.parse(row.expires_at) <= Date.now())) return false;
  const a = Buffer.from(hash);
  const b = Buffer.from(row.token_hash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const scopes = parseJson<string[]>(row.scopes, []);
  return scopes.includes(requiredScope) || scopes.includes('*');
}

/** 正式产物自动关联本次运行的全部有效 Claim，确保可反向失效。 */
export async function linkArtifactToRunClaims(
  taskId: string,
  artifactType: 'matrix' | 'battlecard',
  artifactId: string
): Promise<number> {
  const stage = await getStageByTask(taskId);
  if (!stage) return 0;
  return exec(
    `INSERT IGNORE INTO artifact_claims (artifact_type, artifact_id, claim_id, validity)
     SELECT ?, ?, id, 'valid' FROM claims
     WHERE run_id = ? AND status NOT IN ('rejected','expired')`,
    [artifactType, artifactId, stage.run_id]
  );
}

export async function getIdempotentResponse(
  actor: string, key: string, requestHash: string
): Promise<{ statusCode: number; body: unknown } | null> {
  const rows = await query<{ request_hash: string; status_code: number; response_body: string }>(
    'SELECT request_hash, status_code, response_body FROM idempotency_keys WHERE actor = ? AND idempotency_key = ?',
    [actor, key]
  );
  if (!rows[0]) return null;
  if (rows[0].request_hash !== requestHash) throw new Error('IDEMPOTENCY_KEY_REUSED');
  return { statusCode: Number(rows[0].status_code), body: parseJson(rows[0].response_body, {}) };
}

export async function saveIdempotentResponse(input: {
  actor: string; key: string; method: string; path: string; requestHash: string;
  statusCode: number; body: unknown;
}): Promise<void> {
  await exec(
    `INSERT IGNORE INTO idempotency_keys
     (actor, idempotency_key, method, path, request_hash, status_code, response_body, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [input.actor, input.key, input.method, input.path, input.requestHash,
      input.statusCode, JSON.stringify(input.body), nowIso()]
  );
}
