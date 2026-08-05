import type { EvalResult, EvalRun, EvalTrace } from '../shared/types.js';

/** 评估报告生成：正确率、平均分/耗时、per-stage/per-category 明细、失败案例。 */

export function buildReport(run: EvalRun, results: EvalResult[], traces: EvalTrace[]): string {
  const lines: string[] = [];
  const total = results.length;
  const passed = results.filter((r) => r.status === 'passed').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const errored = results.filter((r) => r.status === 'error').length;
  const accuracy = total ? ((passed / total) * 100).toFixed(1) : '0.0';
  const avgScore = run.avg_score ?? 0;
  const avgLatency = run.avg_latency_ms ?? 0;

  lines.push(`# 评估报告：${run.name}`);
  lines.push(`运行 ${run.id.slice(0, 8)} · ${run.status} · ${run.started_at}`);
  lines.push('');
  lines.push(`| 指标 | 值 |`);
  lines.push(`|---|---|`);
  lines.push(`| 用例总数 | ${total} |`);
  lines.push(`| 通过 | ${passed} |`);
  lines.push(`| 失败 | ${failed} |`);
  lines.push(`| 错误 | ${errored} |`);
  lines.push(`| **正确率** | **${accuracy}%** |`);
  lines.push(`| 平均分 (0-10) | ${avgScore} |`);
  lines.push(`| 平均耗时 | ${avgLatency}ms |`);
  lines.push(`| Trace 数 | ${traces.length} |`);
  lines.push('');

  // per-stage 明细
  const byStage = new Map<string, EvalResult[]>();
  const byCategory = new Map<string, EvalResult[]>();
  // 需要 case 信息 —— 通过 traces 的 stage 反推 stage，但 results 无 stage。这里用 traces 做 stage 分布
  const stageTraces = new Map<string, number>();
  for (const t of traces) stageTraces.set(t.stage, (stageTraces.get(t.stage) ?? 0) + 1);
  if (stageTraces.size) {
    lines.push(`## Per-Stage Trace 分布`);
    lines.push(`| Stage | Trace 数 |`);
    lines.push(`|---|---|`);
    for (const [stage, n] of [...stageTraces.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${stage} | ${n} |`);
    }
    lines.push('');
  }

  // 失败案例 top-10
  const failedResults = results.filter((r) => r.status === 'failed' || r.status === 'error');
  if (failedResults.length) {
    lines.push(`## 失败/错误案例（前 ${Math.min(failedResults.length, 10)}）`);
    for (const r of failedResults.slice(0, 10)) {
      lines.push(`- \`${r.case_id.slice(0, 8)}\` [${r.status}] score=${r.score ?? '-'} latency=${r.latency_ms ?? '-'}ms`);
      if (r.error) lines.push(`  - 错误: ${r.error.slice(0, 200)}`);
      if (r.judge_feedback) lines.push(`  - 判官: ${r.judge_feedback.slice(0, 200)}`);
    }
    lines.push('');
  }

  // 全部结果汇总
  lines.push(`## 全部结果`);
  for (const r of results) {
    lines.push(`- [${r.status === 'passed' ? '✓' : '✗'}] \`${r.case_id.slice(0, 8)}\` score=${r.score ?? '-'} latency=${r.latency_ms ?? '-'}ms`);
  }
  return lines.join('\n');
}
