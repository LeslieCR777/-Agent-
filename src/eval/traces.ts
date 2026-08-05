import { insertEvalTrace } from '../db/queries/eval.js';
import type { AgentTrace } from '../worker/runner.js';
import type { JudgeTrace } from '../ci/judge.js';

/**
 * Trace 收集 sink（评估框架用）。
 * runAgent / judgeWithDeepSeek 的 onTrace 回调通过这里落库或进内存缓冲。
 * 生产热路径（Worker/lead/distill）不传 sink → 零开销。
 */

export interface TraceRecord {
  stage: string;
  prompt: string | null;
  output: string | null;
  exit_code: number | null;
  timed_out: number | null;
  duration_ms: number | null;
  model: string | null;
}

/** 写库 sink：每条 trace 异步落 eval_traces 表 */
export function makeDbTraceSink(runId: string, caseId: string, defaultStage: string): (t: { stage?: string } & Partial<AgentTrace> & Partial<JudgeTrace>) => void {
  return (t) => {
    // 不 await：fire-and-forget，避免阻塞评估主流程
    void insertEvalTrace({
      run_id: runId,
      case_id: caseId,
      stage: t.stage ?? defaultStage,
      prompt: (t as Partial<AgentTrace>).prompt ?? (t as Partial<JudgeTrace>).prompt ?? null,
      output: (t as Partial<AgentTrace>).output ?? (t as Partial<JudgeTrace>).response ?? null,
      exit_code: (t as Partial<AgentTrace>).exitCode ?? null,
      timed_out: (t as Partial<AgentTrace>).timedOut === undefined ? null : (t as Partial<AgentTrace>).timedOut ? 1 : 0,
      duration_ms: (t as Partial<AgentTrace>).durationMs ?? (t as Partial<JudgeTrace>).durationMs ?? null,
      model: (t as Partial<AgentTrace>).model ?? (t as Partial<JudgeTrace>).model ?? null,
    }).catch(() => { /* trace 写入失败不影响评估 */ });
  };
}

/** 内存缓冲 sink：调试/进程内收集用 */
export function makeMemoryTraceSink(limit = 100): { sink: (t: TraceRecord) => void; traces: () => TraceRecord[] } {
  const buf: TraceRecord[] = [];
  const sink = (t: TraceRecord) => {
    buf.push(t);
    if (buf.length > limit) buf.shift();
  };
  return { sink, traces: () => buf.slice() };
}
