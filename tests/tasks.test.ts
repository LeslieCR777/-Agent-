import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDb, teardownTestDb } from './helpers.js';

await setupTestDb();
const { createTask, getTask, claimNextTask, updateTaskStatus } = await import('@api/db/queries/tasks.js');
const { registerAgent, getAgent } = await import('@api/db/queries/agents.js');
const { withTransaction, exec } = await import('@api/db/index.js');

/** 清空待分配池（消除跨测试残留任务，保证 claim 只领到本测试创建的任务） */
async function clearUnassigned(): Promise<void> {
  await exec(`UPDATE tasks SET status = 'failed', finished_at = ? WHERE status = 'unassigned'`, [new Date().toISOString()]);
}

beforeEach(async () => {
  await registerAgent({ id: 'worker-t1', name: 't1', role: 'worker' }); // upsert 幂等
  await clearUnassigned();
});
after(() => { void teardownTestDb(); });

test('创建任务 → 初始 unassigned', async () => {
  const t = await createTask({ title: 't', prompt: 'p' });
  assert.equal(t.status, 'unassigned');
  assert.equal(t.assign_count, 0);
  assert.equal(t.priority, 5);
});

test('认领任务 → claimed + agent + assign_count+1', async () => {
  const t = await createTask({ title: 'claim', prompt: 'p' });
  const c = await claimNextTask('worker-t1');
  assert.equal(c!.id, t.id);
  assert.equal(c!.status, 'claimed');
  assert.equal(c!.agent_id, 'worker-t1');
  assert.equal(c!.assign_count, 1);
  // agent 标 busy 是 handler 层职责（setAgentBusy），db 层只更新任务
  assert.equal((await getAgent('worker-t1'))!.status, 'idle');
});

test('已认领任务不会被第二个 Worker 抢走（原子性）', async () => {
  const t = await createTask({ title: 'racy', prompt: 'p' });
  const w1 = await claimNextTask('worker-t1');
  assert.equal(w1!.id, t.id);
  // 第二个 claim 应拿到 null（池里已没有 unassigned）
  const again = await claimNextTask('worker-t1');
  assert.equal(again, null);
  // 状态保持 claimed
  assert.equal((await getTask(t.id))!.status, 'claimed');
});

test('状态机合法迁移 in_progress → completed', async () => {
  const t = await createTask({ title: 'flow', prompt: 'p' });
  const claimed = (await claimNextTask('worker-t1'))!;
  const started = await updateTaskStatus({ taskId: claimed.id, status: 'in_progress', agentId: 'worker-t1' });
  assert.equal(started.status, 'in_progress');
  assert.ok(started.started_at);
  const done = await updateTaskStatus({ taskId: claimed.id, status: 'completed', result: 'ok', agentId: 'worker-t1' });
  assert.equal(done.status, 'completed');
  assert.equal(done.result, 'ok');
  assert.ok(done.finished_at);
});

test('非法迁移 rejected（completed → 任何）', async () => {
  const t = await createTask({ title: 'illegal', prompt: 'p' });
  const claimed = (await claimNextTask('worker-t1'))!;
  await updateTaskStatus({ taskId: claimed.id, status: 'in_progress', agentId: 'worker-t1' });
  await updateTaskStatus({ taskId: claimed.id, status: 'completed', result: 'x', agentId: 'worker-t1' });
  const after = (await getTask(claimed.id))!;
  assert.equal(after.status, 'completed');
  // 终态再改（db 层守门）→ 抛错
  await assert.rejects(() => updateTaskStatus({ taskId: claimed.id, status: 'failed', error: 'x', agentId: 'worker-t1' }));
  // 非法迁移 unassigned -> completed → 抛错
  const fresh = await createTask({ title: 'skip', prompt: 'p' });
  await assert.rejects(() => updateTaskStatus({ taskId: fresh.id, status: 'completed', result: 'x', agentId: 'worker-t1' }));
});

test('withTransaction 回滚：抛错后状态不变', async () => {
  const t = await createTask({ title: 'rollback', prompt: 'p' });
  await assert.rejects(() =>
    withTransaction(async () => {
      await updateTaskStatus({ taskId: t.id, status: 'claimed', agentId: 'worker-t1' });
      throw new Error('boom');
    })
  );
  assert.equal((await getTask(t.id))!.status, 'unassigned');
});

test('相同优先级下 FIFO 领取', async () => {
  const a = await createTask({ title: 'a', prompt: 'pa', priority: 5 });
  const b = await createTask({ title: 'b', prompt: 'pb', priority: 5 });
  const first = (await claimNextTask('worker-t1'))!;
  assert.equal(first.id, a.id); // 先建先得
  const second = (await claimNextTask('worker-t1'))!;
  assert.equal(second.id, b.id);
});
