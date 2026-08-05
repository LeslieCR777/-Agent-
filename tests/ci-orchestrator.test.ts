import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDb, teardownTestDb } from './helpers.js';
import { createCompetitor, getCompetitor } from '../src/db/queries/competitors.js';
import { getTask, updateTaskStatus } from '../src/db/queries/tasks.js';
import { insertBattlecard, setBattlecardQuality } from '../src/db/queries/ci.js';
import { parseCiTags, kickoffPipeline, onCiTaskCompleted } from '../src/ci/orchestrator.js';
import { config } from '../src/shared/config.js';
import { query } from '../src/db/index.js';

let compId = '';
let compName = '竞品 A';

beforeEach(async () => {
  await setupTestDb();
  compId = (await createCompetitor({ name: compName })).id;
});
afterEach(async () => { await teardownTestDb(); });

test('parseCiTags：解析合法 tags', () => {
  const info = parseCiTags(['ci', 'monitor', compId, 'full:0']);
  assert.equal(info?.stage, 'monitor');
  assert.equal(info?.competitorId, compId);
  assert.equal(info?.mode, 'full');
  assert.equal(info?.round, 0);
  assert.equal(parseCiTags(null), null);
  assert.equal(parseCiTags(['other', 'monitor']), null);
});

test('kickoffPipeline 建出 monitor 任务且 tags 正确', async () => {
  const task = await kickoffPipeline(compId, 'full');
  assert.equal(task.status, 'unassigned');
  const tags = JSON.parse(task.tags!);
  assert.deepEqual(tags, ['ci', 'monitor', compId, 'full:0']);
});

/** 模拟 Worker 走完状态机（unassigned→claimed→in_progress→completed）再触发 orchestrator */
async function completeTask(taskId: string, opts: { result?: string } = {}): Promise<void> {
  const agentId = 'test-agent';
  await updateTaskStatus({ taskId, status: 'claimed', agentId });
  await updateTaskStatus({ taskId, status: 'in_progress', agentId });
  await updateTaskStatus({ taskId, status: 'completed', agentId, result: opts.result });
  const t = (await getTask(taskId))!;
  await onCiTaskCompleted(t);
}

test('full 流水线：monitor 完成 → 创建 research', async () => {
  const t = await kickoffPipeline(compId, 'full');
  await completeTask(t.id);
  const tasks = await getCiTasks();
  // monitor + research
  assert.ok(tasks.some((x) => x.tags.includes('monitor')));
  assert.ok(tasks.some((x) => x.tags.includes('research')));
});

test('monitor-only：无变化则结束（不创建 research）', async () => {
  const t = await kickoffPipeline(compId, 'monitor');
  // 结果不含 CHANGES_INSERTED → 不续 research
  await completeTask(t.id);
  const tasks = await getCiTasks();
  assert.ok(tasks.some((x) => x.tags.includes('monitor')));
  assert.ok(!tasks.some((x) => x.tags.includes('research')));
  // 竞品状态回 idle
  assert.equal((await getCompetitor(compId))!.status, 'idle');
});

test('Reflexion：quality 低于阈值且未达上限 → 回 research round+1', async () => {
  config.ciQualityThreshold = 9;
  config.ciMaxReflexionRounds = 2;
  // 手动串起 monitor → research → compare → battlecard → quality
  const t0 = await kickoffPipeline(compId, 'full'); // monitor
  await completeTask(t0.id);
  const t1 = await getStageTask('research');
  await completeTask(t1.id);
  const t2 = await getStageTask('compare');
  await completeTask(t2.id);
  const t3 = await getStageTask('battlecard');
  await completeTask(t3.id);
  const t4 = await getStageTask('quality');
  // 插入战卡 + 打 8 分（< 阈值 9）
  const bc = {
    our_strengths: ['a'], our_weaknesses: [], competitor_strengths: [],
    competitor_weaknesses: [], key_differentiators: [], objection_handling: {}, elevator_pitch: 'p',
  };
  const row = await insertBattlecard(compId, bc, 0, t4.id);
  await setBattlecardQuality(row.id, { score: 8, feedback: '不够详细' });
  await completeTask(t4.id);
  // 应创建 research round 1
  const researchRound1 = (await getCiTasks()).filter((x) => x.tags.includes('research') && x.tags.includes('full:1'));
  assert.equal(researchRound1.length, 1);
});

async function getStageTask(stage: string) {
  const all = await getCiTasks();
  const t = all.find((x) => x.tags.includes(stage) && x.status === 'unassigned');
  assert.ok(t, `expected unassigned ${stage} task`);
  return t;
}

async function getCiTasks() {
  const rows = await query<{ id: string; tags: string; status: string }>(
    `SELECT id, tags, status FROM tasks WHERE source = 'ci' ORDER BY created_at`
  );
  return rows.map((r) => ({ ...r, tags: JSON.parse(r.tags) as string[] }));
}
