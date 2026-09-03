import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDb, teardownTestDb } from './helpers.js';

await setupTestDb();
const { generateCases, generateCaseRows } = await import('@runtime/eval/generator.js');
const { createEvalCase, listEvalCases, listEvalRuns, listEvalResults, listEvalTraces, getEvalRun } = await import('@api/db/queries/eval.js');
const { runEvalRun, inProcessStageExecutor, httpPipelineExecutor, stubScorer, deepseekScorer, parseEvalJudgement } = await import('@runtime/eval/harness.js');
const { runAgent } = await import('@runtime/runner.js');
const { config } = await import('@platform/config.js');

after(() => { void teardownTestDb(); });

test('生成器：generateCases 出有效用例 + 入库回环', async () => {
  const cases = generateCases({ categories: ['pricing_change'], count: 5, seed: 'test' });
  assert.equal(cases.length, 5);
  for (const c of cases) {
    assert.ok(c.scenario.length > 0);
    assert.ok(c.ground_truth.length > 0);
    assert.ok(c.prompt.length > 0);
    assert.equal(c.category, 'pricing_change');
  }
  const rows = await generateCaseRows({ categories: ['pricing_change'], count: 3, seed: 'test2' });
  assert.equal(rows.length, 3);
  const listed = await listEvalCases({ enabled: true, category: 'pricing_change' });
  assert.ok(listed.length >= 3);
});

test('Trace 捕获：echo agent 下 runAgent 出 trace', async () => {
  let captured: unknown = null;
  const result = await runAgent('你好', { onTrace: (t) => { captured = t; } });
  assert.ok(captured, 'trace 应被 emit');
  const t = captured as { prompt: string; output: string; exitCode: number; timedOut: boolean; durationMs: number; model: string };
  assert.equal(t.prompt, '你好');
  assert.ok(t.output.length > 0); // echo agent 输出 argv（含 --model），非空即可
  assert.ok(t.durationMs > 0);
  assert.equal(t.timedOut, false);
  assert.equal(t.model, config.agentModel);
  assert.ok(result.durationMs > 0);
});

test('runEvalRun：单 stage 进程内执行，全部通过', async () => {
  // 3 条 research case（prompt 含 searchResults）
  await createEvalCase({ scenario: '融资事件A', stage: 'research', prompt: JSON.stringify({ competitor: { name: '智云' }, searchResults: [{ query: '融资', results: [{ title: '完成融资', link: 'http://x', snippet: 'B轮' }] }] }), ground_truth: '财务状况主题有结论', category: 'funding' });
  await createEvalCase({ scenario: '专利事件B', stage: 'research', prompt: JSON.stringify({ competitor: { name: '云帆' }, searchResults: [{ query: '专利', results: [{ title: '申请专利', link: 'http://y', snippet: '多代理' }] }] }), ground_truth: '产品与技术主题命中专利', category: 'patent' });
  await createEvalCase({ scenario: '市场扩张C', stage: 'research', prompt: JSON.stringify({ competitor: { name: '星链' }, searchResults: [{ query: '东南亚', results: [{ title: '进军东南亚', link: 'http://z', snippet: '低价' }] }] }), ground_truth: '市场主题命中东南亚', category: 'market' });

  const { run, report } = await runEvalRun('test-run', {
    stage: 'research',
    executor: inProcessStageExecutor(),
    scorer: stubScorer(8, true),
    concurrency: 2,
  });
  assert.equal(run.status, 'completed');
  assert.equal(run.cases_total, 3);
  assert.equal(run.cases_passed, 3);
  assert.equal(run.avg_score, 8);
  const results = await listEvalResults(run.id);
  assert.equal(results.length, 3);
  assert.ok(results.every((r) => r.status === 'passed'));
  const traces = await listEvalTraces(run.id);
  assert.ok(traces.length >= 3, `应至少 3 条 trace，实际 ${traces.length}`);
  assert.ok(report.includes('正确率'));
});

test('runEvalRun：判官打低分 → 失败', async () => {
  await createEvalCase({ scenario: '测试失败', stage: 'research', prompt: JSON.stringify({ competitor: { name: 'X' }, searchResults: [] }), ground_truth: '应有结论' });
  const { run } = await runEvalRun('fail-run', {
    stage: 'research',
    executor: inProcessStageExecutor(),
    scorer: stubScorer(5, false),
  });
  assert.equal(run.cases_passed, 0);
  const results = await listEvalResults(run.id);
  assert.equal(results[0].status, 'failed');
});

test('runEvalRun：判官抛错 → result error，run 仍完成', async () => {
  await createEvalCase({ scenario: '判官错误', stage: 'research', prompt: JSON.stringify({ competitor: { name: 'Y' }, searchResults: [] }), ground_truth: 'x' });
  const throwingScorer = { async score() { throw new Error('judge down'); } };
  const { run } = await runEvalRun('err-run', {
    stage: 'research',
    executor: inProcessStageExecutor(),
    scorer: throwingScorer as never,
  });
  assert.equal(run.status, 'completed'); // run 不崩
  const results = await listEvalResults(run.id);
  assert.equal(results[0].status, 'error');
});

test('parseEvalJudgement：宽容解析判官 JSON', () => {
  assert.deepEqual(parseEvalJudgement('{"score":8,"passed":true,"feedback":"很好"}'), { score: 8, passed: true, feedback: '很好' });
  assert.equal(parseEvalJudgement('{"评分":0.6,"feedback":"中"}').score, 6); // 0-1 → ×10
  assert.equal(parseEvalJudgement('不是JSON').score, null);
  assert.equal(parseEvalJudgement('{"score":8}').passed, null);
  // 真实判官场景：feedback 含转义引号/中文引号（JSON.stringify 产物）
  const escaped = JSON.stringify({ score: 8, passed: true, feedback: '建议补充 topic: "组织与人才" 主题' });
  assert.equal(parseEvalJudgement(escaped).score, 8);
  // 多行 + 前缀文字
  assert.equal(parseEvalJudgement('评审结果：\n{"score":7,"passed":true,"feedback":"ok"}').score, 7);
});

test('pipeline case 自动路由到 httpPipelineExecutor（不再 unknown stage）', async () => {
  // 创建一个 pipeline case
  await createEvalCase({
    scenario: '全流水线评测', stage: 'pipeline',
    prompt: JSON.stringify({ competitor: { name: '全链路', notes: '测全链' } }),
    ground_truth: 'battlecard 应产出',
  });
  // 用 stub 判官 + 覆盖 executor 为 http（不真连服务器，直接验证路由不抛 unknown stage）
  // 这里 httpPipelineExecutor 会尝试连服务器失败 → error 而非 unknown stage，证明路由正确
  const { run } = await runEvalRun('pipe-route', {
    stage: 'pipeline',
    executor: httpPipelineExecutor({ apiBaseUrl: 'http://127.0.0.1:9', timeoutMs: 2000, pollIntervalMs: 500, cleanup: true }),
    scorer: stubScorer(),
  });
  const results = await listEvalResults(run.id);
  // 路由正确：结果是 error（连不上服务器），而不是 "unknown stage: pipeline" 解析错误
  assert.equal(results[0].status, 'error');
  assert.ok(!(results[0].error ?? '').includes('unknown stage'), '不应再出现 unknown stage 错误');
});

test('runEvalRuns 历史可查', async () => {
  const runs = await listEvalRuns(5);
  assert.ok(runs.length >= 3);
  assert.ok(runs.some((r) => r.name === 'test-run'));
});
