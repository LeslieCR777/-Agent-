import { config } from '@platform/config.js';
import { runAgent } from '@runtime/runner.js';
import { judgeWithDeepSeek } from '@runtime/ci/judge.js';
import { parseJsonBlock } from '@runtime/ci/parse.js';
import { buildStagePrompt } from '@runtime/ci/prompts.js';
import {
  createEvalRun, listEvalCases, finishEvalRun, failEvalRun,
  insertEvalResult, updateEvalResult, listEvalResults,
  insertEvalTrace, listEvalTraces, getEvalRun,
} from '@api/db/queries/eval.js';
import type { EvalCase, EvalRun, EvalResult, EvalStage, EvalTrace } from '@contracts/types.js';
import { makeMemoryTraceSink, type TraceRecord } from './traces.js';
import { buildReport } from './report.js';

/**
 * 黄金测试集评估编排器：
 * runEvalRun → 遍历 case → 执行器(run) → 判官(score) → eval_results + eval_traces → eval_runs 聚合 → report
 *
 * 双执行器：
 *  - httpPipelineExecutor：黑盒 HTTP 跑完整流水线（最忠实，测全链）
 *  - inProcessStageExecutor：进程内 buildStagePrompt + runAgent（快，单 stage 调试）
 * 判官可注入（deepseekScorer 真判 / stubScorer 离线冒烟）。
 */

export interface CaseExecution {
  output: string;
  latencyMs: number;
  traces: TraceRecord[];
}

export interface EvalExecutor {
  run(c: EvalCase): Promise<CaseExecution>;
}

// ── 执行器 a：黑盒 HTTP 完整流水线 ────────────────────

interface HttpExecutorOpts {
  apiBaseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;      // 单 case 超时，默认 20min（Reflexion 可能久）
  cleanup?: boolean;       // 默认 true：收集后删临时竞品
  pollIntervalMs?: number; // 默认 3000
}

export function httpPipelineExecutor(opts: HttpExecutorOpts = {}): EvalExecutor {
  const base = opts.apiBaseUrl ?? config.apiBaseUrl;
  const key = opts.apiKey ?? config.apiKey;
  const timeoutMs = opts.timeoutMs ?? 20 * 60 * 1000;
  const pollIntervalMs = opts.pollIntervalMs ?? 3000;
  const cleanup = opts.cleanup ?? true;

  const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    return text ? (JSON.parse(text) as T) : (undefined as T);
  };

  return {
    async run(c) {
      const startedAt = Date.now();
      // 1. 解析 case.prompt 为竞品 seed
      let seed: { competitor?: { name?: string; notes?: string; monitor_urls?: string[] } } = {};
      try { seed = JSON.parse(c.prompt); } catch { seed = {}; }
      const name = `[Eval] ${c.category ?? 'case'}#${c.scenario.slice(0, 30)}`;
      // 2. 建临时竞品
      const created = await api<{ competitor: { id: string } }>('/api/competitors', {
        method: 'POST',
        body: JSON.stringify({
          name,
          notes: seed.competitor?.notes ?? c.ground_truth.slice(0, 200),
          monitor_urls: seed.competitor?.monitor_urls,
        }),
      });
      const compId = created.competitor.id;
      try {
        // 3. 触发完整流水线
        await api(`/api/competitors/${compId}/analyze`, { method: 'POST', body: '{}' });
        // 4. 轮询到 idle
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          if (Date.now() > deadline) throw new Error('pipeline timeout');
          await new Promise((r) => setTimeout(r, pollIntervalMs));
          const cur = await api<{ competitor: { status: string; last_checked_at: string | null } }>(`/api/competitors/${compId}`);
          if (cur.competitor.status === 'idle' && cur.competitor.last_checked_at) break;
        }
        // 5. 收集产物
        const latest = await api<{
          battlecard?: { content?: unknown; quality_score?: number | null };
          matrix?: { dimensions?: unknown[] };
          changes?: unknown[]; insights?: unknown[];
        }>(`/api/ci/competitors/${compId}/latest`);
        const output = JSON.stringify({
          battlecard: latest.battlecard?.content,
          quality_score: latest.battlecard?.quality_score,
          matrix_dims: latest.matrix?.dimensions?.length ?? 0,
          changes: latest.changes?.length ?? 0,
          insights: latest.insights?.length ?? 0,
        });
        return { output, latencyMs: Date.now() - startedAt, traces: [] };
      } finally {
        if (cleanup) {
          await api(`/api/competitors/${compId}`, { method: 'DELETE' }).catch(() => {});
        }
      }
    },
  };
}

// ── 执行器 b：进程内单 stage ──────────────────────────

interface InProcessOpts {
  workdir?: string;
  onTrace?: (t: TraceRecord) => void;
}

/** 把 case.prompt（JSON）解析成 buildStagePrompt 的 ctx；quality 直接传 battlecard */
function buildStageCtx(c: EvalCase) {
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(c.prompt) as Record<string, unknown>; } catch { data = {}; }
  const now = new Date().toISOString();
  const comp = {
    id: 'eval', name: (data.competitor as { name?: string } | undefined)?.name ?? '评测竞品',
    website: null, monitor_urls: null, notes: (data.competitor as { notes?: string } | undefined)?.notes ?? null,
    enabled: 1, status: 'idle', created_at: now, last_checked_at: null, last_error: null,
  } as const;
  switch (c.stage) {
    case 'monitor':
      return {
        competitor: comp,
        pages: [{ url: (data.url as string) ?? 'https://eval.example/page', changed: true, text: (data.text as string) ?? c.scenario, pricing: (data.pricing as unknown[]) ?? [], jobs: (data.jobs as unknown[]) ?? [] }],
      };
    case 'research':
      return {
        competitor: comp,
        latestChanges: (data.changes as unknown[]) ?? [],
        searchResults: (data.searchResults as { query: string; results: { title: string; link: string; snippet: string }[] }[]) ?? [],
        feedback: undefined,
      };
    case 'compare':
      return { ourProfile: config.ourProduct, competitor: comp, latestInsights: (data.insights as unknown[]) ?? [] };
    case 'battlecard': {
      const matrix = (data.matrix as { dimensions?: unknown[]; overall_assessment?: string } | undefined) ?? { dimensions: [], overall_assessment: '' };
      return {
        ourProfile: config.ourProduct, competitor: comp,
        matrix: { dimensions: (matrix.dimensions ?? []) as never[], overall_assessment: matrix.overall_assessment ?? '' },
        latestInsights: (data.insights as unknown[]) ?? [],
      };
    }
    case 'quality': {
      const bc = (data.battlecard ?? {}) as Record<string, unknown>;
      return { competitor: comp, battlecard: bc as never };
    }
    default:
      return { competitor: comp };
  }
}

export function inProcessStageExecutor(opts: InProcessOpts = {}): EvalExecutor {
  const workdir = opts.workdir;
  return {
    async run(c) {
      const mem = makeMemoryTraceSink();
      const sink = opts.onTrace ?? mem.sink;
      const ctx = buildStageCtx(c) as unknown as Parameters<typeof buildStagePrompt>[1];
      const prompt = buildStagePrompt(c.stage as Exclude<EvalStage, 'pipeline'>, ctx);
      // claude CLI 在 Windows 下偶发 exit 143（SIGTERM）且无输出，重试 3 次提升稳定性
      let lastErr: Error | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const result = await runAgent(prompt, {
            onTrace: (t) => sink({ stage: c.stage, prompt: t.prompt, output: t.output, exit_code: t.exitCode, timed_out: t.timedOut ? 1 : 0, duration_ms: t.durationMs, model: t.model }),
          }, workdir ? { cwd: workdir } : {});
          if (result.timedOut) throw new Error('agent timed out');
          if (result.exitCode !== 0) {
            lastErr = new Error(`agent exit ${result.exitCode}`);
            if (attempt < 2) { await new Promise((r) => setTimeout(r, 1000 * (attempt + 1))); continue; }
            throw lastErr;
          }
          return { output: result.output, latencyMs: result.durationMs, traces: mem.traces() };
        } catch (err) {
          lastErr = err instanceof Error ? err : new Error(String(err));
          if (attempt < 2) { await new Promise((r) => setTimeout(r, 1000 * (attempt + 1))); }
        }
      }
      throw lastErr ?? new Error('agent failed');
    },
  };
}

// ── 判官 ──────────────────────────────────────────────

export interface EvalScore {
  score: number;       // 0-10
  passed: boolean;
  feedback: string;
  latencyMs: number;
}

export interface EvalScorer {
  score(c: EvalCase, output: string): Promise<EvalScore>;
}

interface ScorerOpts {
  threshold?: number;
  onTrace?: (t: TraceRecord) => void;
}

/** 从判官 JSON 中宽容提取分数（复用 execute.ts extractScore 的思路） */
export function parseEvalJudgement(raw: string): { score: number | null; passed: boolean | null; feedback: string } {
  // 先试原生 JSON.parse（raw 本身是完整有效 JSON 时最可靠，兼容 feedback 含转义引号/换行）
  let parsed = (() => {
    try {
      const t = raw.trim().replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '').trim();
      const obj = JSON.parse(t) as Record<string, unknown>;
      return typeof obj === 'object' && obj !== null && !Array.isArray(obj) ? obj : null;
    } catch {
      return null;
    }
  })();
  // 原生失败再走宽容扫描器
  if (!parsed) parsed = parseJsonBlock<Record<string, unknown>>(raw);
  if (!parsed) return { score: null, passed: null, feedback: '' };
  let score: number | null = null;
  for (const cand of [parsed.score, parsed.rating, parsed['评分']]) {
    const n = Number(cand);
    if (!Number.isFinite(n)) continue;
    const s = n > 0 && n <= 1 ? Math.round(n * 10) : n;
    if (s >= 1 && s <= 10) { score = s; break; }
  }
  const passed = typeof parsed.passed === 'boolean' ? parsed.passed : null;
  const feedback = typeof parsed.feedback === 'string' ? parsed.feedback : '';
  return { score, passed, feedback };
}

export function deepseekScorer(opts: ScorerOpts = {}): EvalScorer {
  const threshold = opts.threshold ?? config.ciQualityThreshold;
  return {
    async score(c, output) {
      const startedAt = Date.now();
      const rubric = [
        `你是一名评测判官。判断下面的 Agent 输出是否达到黄金标准（Ground Truth）要求。`,
        `业务场景：${c.scenario}`,
        `评分维度：准确性（命中 ground truth 要点、无臆造）、完整性（覆盖要求）、相关性、格式正确性。`,
        `打分从严：明显偏离 ≤4，部分命中 5-6，基本达标 7-8，完全达标 9-10。`,
        ``,
        `Ground Truth：${c.ground_truth}`,
        ``,
        `Agent 输出：${output.slice(0, 12000)}`,
        ``,
        `只输出 JSON：{"score":1-10,"passed":true|false,"feedback":"具体差距与改进建议"}`,
      ].join('\n');
      let judgeLatency = Date.now() - startedAt;
      try {
        const raw = await judgeWithDeepSeek('评测', rubric, (t) => {
          judgeLatency = t.durationMs;
          opts.onTrace?.({ stage: 'judge', prompt: t.prompt, output: t.response, exit_code: null, timed_out: null, duration_ms: t.durationMs, model: t.model });
        });
        const { score, passed, feedback } = parseEvalJudgement(raw);
        if (score === null) {
          return { score: 0, passed: false, feedback: `判官输出无法解析: ${raw.slice(0, 200)}`, latencyMs: judgeLatency };
        }
        const finalPassed = passed !== null ? passed : score >= threshold;
        return { score, passed: finalPassed, feedback, latencyMs: judgeLatency };
      } catch (err) {
        return { score: 0, passed: false, feedback: `判官调用失败: ${err instanceof Error ? err.message : err}`, latencyMs: judgeLatency };
      }
    },
  };
}

/** 离线冒烟判官：不碰 DeepSeek */
export function stubScorer(score = 8, passed = true): EvalScorer {
  return {
    async score(c, _output) {
      return { score, passed, feedback: 'stub 判官（离线冒烟）', latencyMs: 0 };
    },
  };
}

// ── 并发池 ────────────────────────────────────────────

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = idx++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

// ── 主编排 ────────────────────────────────────────────

export interface RunEvalOptions {
  stage?: EvalStage;
  category?: string;
  limit?: number;
  executor?: EvalExecutor;
  scorer?: EvalScorer;
  concurrency?: number;
  onProgress?: (msg: string) => void;
}

export async function runEvalRun(name: string, opts: RunEvalOptions = {}): Promise<{ run: EvalRun; report: string }> {
  const log = opts.onProgress ?? (() => {});
  const scorer = opts.scorer ?? deepseekScorer();
  const concurrency = opts.concurrency ?? 2;

  // 按 case.stage 自动选执行器：pipeline 用黑盒 HTTP，其他用进程内。
  // 用户可传单一 executor 覆盖（如只想测单 stage 或只想测全链）。
  const customExecutor = opts.executor;
  const executorFor = (stage: EvalStage): EvalExecutor => {
    if (customExecutor) return customExecutor;
    return stage === 'pipeline' ? httpPipelineExecutor() : inProcessStageExecutor();
  };

  // 1. 创建 run
  const run = await createEvalRun(name);
  log(`[eval] run ${run.id.slice(0, 8)} created, fetching cases...`);
  const cases = await listEvalCases({ enabled: true, stage: opts.stage, category: opts.category });
  const selected = opts.limit ? cases.slice(0, opts.limit) : cases;
  log(`[eval] ${selected.length} cases selected (${run.id.slice(0, 8)})`);

  // 2. 并发跑每个 case（按 stage 选执行器）
  await mapLimit(selected, concurrency, async (c) => {
    const result = await insertEvalResult({ run_id: run.id, case_id: c.id });
    let exec: CaseExecution;
    try {
      exec = await executorFor(c.stage).run(c);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await updateEvalResult(result.id, { status: 'error', error: msg.slice(0, 500) });
      log(`  ✖ ${c.scenario.slice(0, 40)} 执行失败: ${msg.slice(0, 60)}`);
      return;
    }
    // 判官
    let score: EvalScore;
    try {
      score = await scorer.score(c, exec.output);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await updateEvalResult(result.id, {
        status: 'error', error: msg.slice(0, 500),
        agent_output: exec.output.slice(0, 20000), latency_ms: exec.latencyMs,
      });
      log(`  ✖ ${c.scenario.slice(0, 40)} 判官失败: ${msg.slice(0, 60)}`);
      return;
    }
    await updateEvalResult(result.id, {
      status: score.passed ? 'passed' : 'failed',
      passed: score.passed ? 1 : 0,
      score: score.score,
      latency_ms: score.latencyMs + exec.latencyMs,
      agent_output: exec.output.slice(0, 20000),
      judge_feedback: score.feedback.slice(0, 3000),
    });
    // traces 落库
    for (const t of exec.traces) {
      await insertEvalTrace({
        run_id: run.id, case_id: c.id, stage: t.stage,
        prompt: t.prompt, output: t.output, exit_code: t.exit_code,
        timed_out: t.timed_out, duration_ms: t.duration_ms, model: t.model,
      });
    }
    log(`  ${score.passed ? '✓' : '✗'} ${c.scenario.slice(0, 40)} score=${score.score} latency=${exec.latencyMs}ms`);
  });

  // 3. 聚合
  const results = await listEvalResults(run.id);
  const traces = await listEvalTraces(run.id);
  const total = results.length;
  const passed = results.filter((r) => r.status === 'passed').length;
  const scored = results.filter((r) => r.score !== null);
  const avgScore = scored.length ? scored.reduce((a, r) => a + (r.score ?? 0), 0) / scored.length : null;
  const latencyRows = results.filter((r) => r.latency_ms !== null);
  const avgLatency = latencyRows.length ? latencyRows.reduce((a, r) => a + (r.latency_ms ?? 0), 0) / latencyRows.length : null;
  await finishEvalRun(run.id, {
    cases_total: total, cases_passed: passed,
    avg_score: avgScore ? Math.round(avgScore * 100) / 100 : null,
    avg_latency_ms: avgLatency ? Math.round(avgLatency) : null,
  });
  const runRow = await getEvalRun(run.id);
  if (!runRow) throw new Error('eval run not found');
  log(`[eval] run ${run.id.slice(0, 8)} completed: ${passed}/${total} passed`);
  const report = buildReport(runRow, results, traces);
  return { run: runRow, report };
}
