import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDb, teardownTestDb } from './helpers.js';
import { createCompetitor, getCompetitor } from '../src/db/queries/competitors.js';
import { getTask, updateTaskStatus } from '../src/db/queries/tasks.js';
import { insertBattlecard, setBattlecardQuality } from '../src/db/queries/ci.js';
import { parseCiTags, kickoffPipeline, onCiTaskCompleted } from '../src/ci/orchestrator.js';
import { config } from '../src/shared/config.js';
import { getDb } from '../src/db/index.js';

let compId = '';
let compName = '竞品 A';

beforeEach(async () => {
  await setupTestDb();
  compId = createCompetitor({ name: compName }).id;
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

test('kickoffPipeline 建出 monitor 任务且 tags 正确', () => {
  const task = kickoffPipeline(compId, 'full');
  assert.equal(task.status, 'unassigned');
  const tags = JSON.parse(task.tags!);
  assert.deepEqual(tags, ['ci', 'monitor', compId, 'full:0']);
});

/** 模拟 Worker 走完状态机（unassigned→claimed→in_progress→completed）再触发 orchestrator */
function completeTask(taskId: string, opts: { result?: string } = {}): void {
  const agentId = 'test-agent';
  updateTaskStatus({ taskId, status: 'claimed', agentId });
  updateTaskStatus({ taskId, status: 'in_progress', agentId });
  updateTaskStatus({ taskId, status: 'completed', agentId, result: opts.result });
  const t = getTask(taskId)!;
  onCiTaskCompleted(t);
}

test('full 流水线：monitor 完成 → 创建 research', () => {
  const t = kickoffPipeline(compId, 'full');
  completeTask(t.id);
  const tasks = getCiTasks();
  // monitor + research
  assert.ok(tasks.some((x) => x.tags.includes('monitor')));
  assert.ok(tasks.some((x) => x.tags.includes('research')));
});

test('monitor-only：无变化则结束（不创建 research）', () => {
  const t = kickoffPipeline(compId, 'monitor');
  // 结果不含 CHANGES_INSERTED → 不续 research
  completeTask(t.id);
  const tasks = getCiTasks();
  assert.ok(tasks.some((x) => x.tags.includes('monitor')));
  assert.ok(!tasks.some((x) => x.tags.includes('research')));
  // 竞品状态回 idle
  assert.equal(getCompetitor(compId)!.status, 'idle');
});

test('Reflexion：quality 低于阈值且未达上限 → 回 research round+1', () => {
  config.ciQualityThreshold = 9;
  config.ciMaxReflexionRounds = 2;
  // 手动串起 monitor → research → compare → battlecard → quality
  const t0 = kickoffPipeline(compId, 'full'); // monitor
  completeTask(t0.id);
  const t1 = getStageTask('research');
  completeTask(t1.id);
  const t2 = getStageTask('compare');
  completeTask(t2.id);
  const t3 = getStageTask('battlecard');
  completeTask(t3.id);
  const t4 = getStageTask('quality');
  // 插入战卡 + 打 8 分（< 阈值 9）
  const bc = {
    our_strengths: ['a'], our_weaknesses: [], competitor_strengths: [],
    competitor_weaknesses: [], key_differentiators: [], objection_handling: {}, elevator_pitch: 'p',
  };
  const row = insertBattlecard(compId, bc, 0, t4.id);
  setBattlecardQuality(row.id, { score: 8, feedback: '不够详细' });
  completeTask(t4.id);
  // 应创建 research round 1
  const researchRound1 = getCiTasks().filter((x) => x.tags.includes('research') && x.tags.includes('full:1'));
  assert.equal(researchRound1.length, 1);
});

function getStageTask(stage: string) {
  const all = getCiTasks();
  const t = all.find((x) => x.tags.includes(stage) && x.status === 'unassigned');
  assert.ok(t, `expected unassigned ${stage} task`);
  return t;
}

function getCiTasks() {
  const rows = getDb().prepare(`SELECT * FROM tasks WHERE source = 'ci' ORDER BY created_at`).all() as unknown as {
    id: string; tags: string; status: string;
  }[];
  return rows.map((r) => ({ ...r, tags: JSON.parse(r.tags) as string[] }));
}
