import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDb, teardownTestDb } from './helpers.js';

await setupTestDb();
const { createTask, getTask, claimNextTask } = await import('../src/db/queries/tasks.js');
const { registerAgent, heartbeat, getAgent } = await import('../src/db/queries/agents.js');
const dbModule = await import('../src/db/index.js');
const { runSweep } = await import('../src/heartbeat/sweeper.js');
const { config } = await import('../src/shared/config.js');

beforeEach(() => {
  // 清空待分配池，避免跨测试残留
  dbModule.getDb().prepare(`UPDATE tasks SET status = 'failed', finished_at = ? WHERE status = 'unassigned'`)
    .run(new Date().toISOString());
});
after(() => { void teardownTestDb(); });

test('心跳超时 → agent offline + 任务重派回 unassigned', async () => {
  // 1. 注册 agent 并领取任务
  registerAgent({ id: 'worker-h1', name: 'h1', role: 'worker' });
  const t = createTask({ title: 'crash', prompt: 'p' });
  claimNextTask('worker-h1');
  assert.equal(getTask(t.id)!.status, 'claimed');

  // 2. 模拟心跳超时：把 last_heartbeat_at 改到很久以前
  const { getDb } = await import('../src/db/index.js');
  getDb().prepare(`UPDATE agents SET last_heartbeat_at = ? WHERE id = ?`)
    .run(new Date(Date.now() - 60_000).toISOString(), 'worker-h1');

  // 3. 清扫
  await runSweep();

  assert.equal(getAgent('worker-h1')!.status, 'offline');
  const after = getTask(t.id)!;
  assert.equal(after.status, 'unassigned'); // 重派回池
  assert.equal(after.agent_id, null);
});

test('认领次数超上限 → 任务 failed（防死循环重派）', async () => {
  await import('../src/db/index.js');

  registerAgent({ id: 'worker-h2', name: 'h2', role: 'worker' });
  const t = createTask({ title: 'bad', prompt: 'p' });
  claimNextTask('worker-h2');
  const { getDb } = await import('../src/db/index.js');

  // 手动把 assign_count 推到上限，再模拟超时
  getDb().prepare(`UPDATE tasks SET assign_count = ? WHERE id = ?`).run(config.maxAssignCount, t.id);
  getDb().prepare(`UPDATE agents SET last_heartbeat_at = ? WHERE id = ?`)
    .run(new Date(Date.now() - 60_000).toISOString(), 'worker-h2');

  await runSweep();

  const after = getTask(t.id)!;
  assert.equal(after.status, 'failed');
  assert.ok(after.error?.includes('assign limit'));
});

test('心跳正常则不清扫', async () => {
  registerAgent({ id: 'worker-h3', name: 'h3', role: 'worker' });
  heartbeat('worker-h3');
  await runSweep();
  assert.equal(getAgent('worker-h3')!.status, 'idle'); // 未被标 offline
});
