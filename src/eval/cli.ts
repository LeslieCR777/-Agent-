import { generateCaseRows } from './generator.js';
import { runEvalRun, deepseekScorer, stubScorer } from './harness.js';
import { listEvalRuns, listEvalResults, listEvalTraces, getEvalRun } from '../db/queries/eval.js';
import { buildReport } from './report.js';
import { initDb, closeDb } from '../db/index.js';
import { logger } from '../shared/logger.js';

/**
 * 评估 CLI：
 *   node --import tsx src/eval/cli.ts gen [--count N] [--category X] [--seed S]
 *   node --import tsx src/eval/cli.ts run <name> [--stage X] [--limit N] [--concurrency C] [--stub]
 *   node --import tsx src/eval/cli.ts report [--runId X | --latest]
 */

function parseArgs(): Record<string, string> {
  const args = process.argv.slice(2);
  const out: Record<string, string> = {};
  let cmd = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : 'true';
      out[key] = val;
      if (!args[i + 1]?.startsWith('--')) i++;
    } else if (!cmd) {
      cmd = a;
    }
  }
  out._cmd = cmd;
  return out;
}

async function main(): Promise<void> {
  await initDb();
  const args = parseArgs();
  const cmd = args._cmd;

  if (cmd === 'gen') {
    const count = Number(args.count ?? 30);
    const categories = args.category ? args.category.split(',') : undefined;
    const seed = args.seed;
    const rows = await generateCaseRows({ count, categories, seed });
    logger.info('eval', `generated ${rows.length} eval cases (count=${count}, seed=${seed ?? 'default'})`);
    return;
  }

  if (cmd === 'run') {
    const name = process.argv[2] === 'run' ? process.argv[3] : 'eval-run';
    const stage = (args.stage as 'monitor' | 'research' | 'compare' | 'battlecard' | 'quality' | 'pipeline') || undefined;
    const limit = args.limit ? Number(args.limit) : undefined;
    const concurrency = args.concurrency ? Number(args.concurrency) : 2;
    const useStub = args.stub === 'true';
    const { run, report } = await runEvalRun(name, {
      stage,
      limit,
      concurrency,
      scorer: useStub ? stubScorer() : deepseekScorer(),
      onProgress: (msg) => console.log(msg),
    });
    console.log('');
    console.log(report);
    logger.info('eval', `run ${run.id.slice(0, 8)} "${name}" done: ${run.cases_passed}/${run.cases_total} passed`);
    return;
  }

  if (cmd === 'report') {
    let runId = args.runId;
    if (!runId || args.latest === 'true') {
      const runs = await listEvalRuns(1);
      if (!runs.length) { console.log('无评估记录'); return; }
      runId = runs[0].id;
    }
    const run = await getEvalRun(runId);
    if (!run) { console.log(`run ${runId} 不存在`); return; }
    const results = await listEvalResults(runId);
    const traces = await listEvalTraces(runId);
    console.log(buildReport(run, results, traces));
    return;
  }

  console.log(`用法:
  gen    [--count N] [--category X] [--seed S]       生成测试集入库
  run    <name> [--stage X] [--limit N] [--concurrency C] [--stub]   跑评估
  report [--runId X | --latest]                      查看报告`);
}

main().then(async () => {
  await closeDb();
}).catch((err) => {
  logger.error('eval', `fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
