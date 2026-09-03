import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDb, teardownTestDb } from './helpers.js';

await setupTestDb();
const { createTask, getTask, claimNextTask } = await import('@api/db/queries/tasks.js');
const { registerAgent, heartbeat, getAgent } = await import('@api/db/queries/agents.js');
const { exec } = await import('@api/db/index.js');
const { runSweep } = await import('@orchestrator/heartbeat/sweeper.js');
const { config } = await import('@platform/config.js');

beforeEach(async () => {
  // 清空待分配池，避免跨测试残留
  await exec(`UPDATE tasks SET status = 'failed', finished_at = ? WHERE status = 'unassigned'`, [new Date().toISOString()]);
});
after(() => { void teardownTestDb(); });

test('心跳超时 → agent offline + 任务重派回 unassigned', async () => {
  // 1. 注册 agent 并领取任务
  await registerAgent({ id: 'worker-h1', name: 'h1', role: 'worker' });
  const t = await createTask({ title: 'crash', prompt: 'p' });
  await claimNextTask('worker-h1');
  assert.equal((await getTask(t.id))!.status, 'claimed');

  // 2. 模拟心跳超时：把 last_heartbeat_at 改到很久以前
  await exec(`UPDATE agents SET last_heartbeat_at = ? WHERE id = ?`, [new Date(Date.now() - 60_000).toISOString(), 'worker-h1']);

  // 3. 清扫
  await runSweep();

  assert.equal((await getAgent('worker-h1'))!.status, 'offline');
  const after = (await getTask(t.id))!;
  assert.equal(after.status, 'unassigned'); // 重派回池
  assert.equal(after.agent_id, null);
});

test('认领次数超上限 → 任务 failed（防死循环重派）', async () => {
  await registerAgent({ id: 'worker-h2', name: 'h2', role: 'worker' });
  const t = await createTask({ title: 'bad', prompt: 'p' });
  await claimNextTask('worker-h2');

  // 手动把 assign_count 推到上限，再模拟超时
  await exec(`UPDATE tasks SET assign_count = ? WHERE id = ?`, [config.maxAssignCount, t.id]);
  await exec(`UPDATE agents SET last_heartbeat_at = ? WHERE id = ?`, [new Date(Date.now() - 60_000).toISOString(), 'worker-h2']);

  await runSweep();

  const after = (await getTask(t.id))!;
  assert.equal(after.status, 'failed');
  assert.ok(after.error?.includes('assign limit'));
});

test('心跳正常则不清扫', async () => {
  await registerAgent({ id: 'worker-h3', name: 'h3', role: 'worker' });
  await heartbeat('worker-h3');
  await runSweep();
  assert.equal((await getAgent('worker-h3'))!.status, 'idle'); // 未被标 offline
});
