import { newId, nowIso, query, exec } from '../index.js';
import type { EvalCase, EvalResult, EvalRun, EvalRunStatus, EvalStage, EvalTrace } from '@contracts/types.js';

/** 评测（Golden Dataset / Evaluation）查询层。 */

// ── eval_cases ────────────────────────────────────────

export interface CreateEvalCaseInput {
  scenario: string;
  stage: EvalStage;
  prompt: string;
  ground_truth: string;
  category?: string;
}

export async function createEvalCase(input: CreateEvalCaseInput): Promise<EvalCase> {
  const row: EvalCase = {
    id: newId(),
    scenario: input.scenario,
    stage: input.stage,
    prompt: input.prompt,
    ground_truth: input.ground_truth,
    category: input.category ?? null,
    enabled: 1,
    created_at: nowIso(),
  };
  await exec(
    `INSERT INTO eval_cases (id, scenario, stage, prompt, ground_truth, category, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.scenario, row.stage, row.prompt, row.ground_truth, row.category, row.enabled, row.created_at]
  );
  return row;
}

export interface EvalCaseFilter {
  enabled?: boolean;
  stage?: EvalStage;
  category?: string;
}

export async function listEvalCases(filter: EvalCaseFilter = {}): Promise<EvalCase[]> {
  const conds: string[] = [];
  const params: (string | number)[] = [];
  if (filter.enabled !== undefined) { conds.push('enabled = ?'); params.push(filter.enabled ? 1 : 0); }
  if (filter.stage) { conds.push('stage = ?'); params.push(filter.stage); }
  if (filter.category) { conds.push('category = ?'); params.push(filter.category); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  return query<EvalCase>(`SELECT * FROM eval_cases ${where} ORDER BY created_at ASC`, params);
}

export interface EvalCasePatch {
  enabled?: boolean;
  category?: string;
  ground_truth?: string;
}

export async function updateEvalCase(id: string, patch: EvalCasePatch): Promise<EvalCase | null> {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (patch.enabled !== undefined) { sets.push('enabled = ?'); params.push(patch.enabled ? 1 : 0); }
  if (patch.category !== undefined) { sets.push('category = ?'); params.push(patch.category); }
  if (patch.ground_truth !== undefined) { sets.push('ground_truth = ?'); params.push(patch.ground_truth); }
  if (sets.length === 0) return getEvalCase(id);
  params.push(id);
  await exec(`UPDATE eval_cases SET ${sets.join(', ')} WHERE id = ?`, params);
  return getEvalCase(id);
}

export async function getEvalCase(id: string): Promise<EvalCase | null> {
  const rows = await query<EvalCase>(`SELECT * FROM eval_cases WHERE id = ?`, [id]);
  return rows[0] ?? null;
}

export async function deleteEvalCase(id: string): Promise<boolean> {
  const affected = await exec(`DELETE FROM eval_cases WHERE id = ?`, [id]);
  return affected === 1;
}

// ── eval_runs ─────────────────────────────────────────

export async function createEvalRun(name: string): Promise<EvalRun> {
  const row: EvalRun = {
    id: newId(),
    name,
    status: 'running',
    cases_total: 0,
    cases_passed: 0,
    avg_score: null,
    avg_latency_ms: null,
    started_at: nowIso(),
    finished_at: null,
  };
  await exec(
    `INSERT INTO eval_runs (id, name, status, cases_total, cases_passed, avg_score, avg_latency_ms, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.name, row.status, 0, 0, null, null, row.started_at, null]
  );
  return row;
}

export async function finishEvalRun(id: string, agg: { cases_total: number; cases_passed: number; avg_score: number | null; avg_latency_ms: number | null }): Promise<void> {
  await exec(
    `UPDATE eval_runs SET status = 'completed', cases_total = ?, cases_passed = ?, avg_score = ?, avg_latency_ms = ?, finished_at = ? WHERE id = ?`,
    [agg.cases_total, agg.cases_passed, agg.avg_score, agg.avg_latency_ms, nowIso(), id]
  );
}

export async function failEvalRun(id: string, error: string): Promise<void> {
  await exec(
    `UPDATE eval_runs SET status = 'failed', finished_at = ? WHERE id = ?`,
    [nowIso(), id]
  );
}

export async function getEvalRun(id: string): Promise<EvalRun | null> {
  const rows = await query<EvalRun>(`SELECT * FROM eval_runs WHERE id = ?`, [id]);
  return rows[0] ?? null;
}

export async function listEvalRuns(limit = 20): Promise<EvalRun[]> {
  return query<EvalRun>(`SELECT * FROM eval_runs ORDER BY started_at DESC LIMIT ?`, [limit]);
}

// ── eval_results ──────────────────────────────────────

export async function insertEvalResult(input: { run_id: string; case_id: string }): Promise<EvalResult> {
  const row: EvalResult = {
    id: newId(),
    run_id: input.run_id,
    case_id: input.case_id,
    status: 'running',
    passed: null,
    score: null,
    latency_ms: null,
    agent_output: null,
    judge_feedback: null,
    error: null,
    created_at: nowIso(),
  };
  await exec(
    `INSERT INTO eval_results (id, run_id, case_id, status, passed, score, latency_ms, agent_output, judge_feedback, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.run_id, row.case_id, row.status, null, null, null, null, null, null, row.created_at]
  );
  return row;
}

export interface EvalResultPatch {
  status?: EvalResult['status'];
  passed?: number | null;
  score?: number | null;
  latency_ms?: number | null;
  agent_output?: string | null;
  judge_feedback?: string | null;
  error?: string | null;
}

export async function updateEvalResult(id: string, patch: EvalResultPatch): Promise<void> {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status); }
  if (patch.passed !== undefined) { sets.push('passed = ?'); params.push(patch.passed); }
  if (patch.score !== undefined) { sets.push('score = ?'); params.push(patch.score); }
  if (patch.latency_ms !== undefined) { sets.push('latency_ms = ?'); params.push(patch.latency_ms); }
  if (patch.agent_output !== undefined) { sets.push('agent_output = ?'); params.push(patch.agent_output); }
  if (patch.judge_feedback !== undefined) { sets.push('judge_feedback = ?'); params.push(patch.judge_feedback); }
  if (patch.error !== undefined) { sets.push('error = ?'); params.push(patch.error); }
  if (sets.length === 0) return;
  params.push(id);
  await exec(`UPDATE eval_results SET ${sets.join(', ')} WHERE id = ?`, params);
}

export async function listEvalResults(runId: string): Promise<EvalResult[]> {
  return query<EvalResult>(`SELECT * FROM eval_results WHERE run_id = ? ORDER BY created_at ASC`, [runId]);
}

// ── eval_traces ───────────────────────────────────────

export interface InsertEvalTraceInput {
  run_id: string;
  case_id: string;
  stage: string;
  prompt?: string | null;
  output?: string | null;
  exit_code?: number | null;
  timed_out?: number | null;
  duration_ms?: number | null;
  model?: string | null;
}

export async function insertEvalTrace(input: InsertEvalTraceInput): Promise<void> {
  await exec(
    `INSERT INTO eval_traces (id, run_id, case_id, stage, prompt, output, exit_code, timed_out, duration_ms, model, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [newId(), input.run_id, input.case_id, input.stage,
      input.prompt ?? null, input.output ?? null,
      input.exit_code ?? null, input.timed_out ?? null,
      input.duration_ms ?? null, input.model ?? null, nowIso()]
  );
}

export async function listEvalTraces(runId: string): Promise<EvalTrace[]> {
  return query<EvalTrace>(`SELECT * FROM eval_traces WHERE run_id = ? ORDER BY created_at ASC`, [runId]);
}
