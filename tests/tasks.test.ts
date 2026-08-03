import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDb, teardownTestDb } from './helpers.js';

await setupTestDb();
const { createTask, getTask, claimNextTask, updateTaskStatus } = await import('../src/db/queries/tasks.js');
const { registerAgent, getAgent } = await import('../src/db/queries/agents.js');
const dbModule = await import('../src/db/index.js');
const { withTransaction } = dbModule;

/** 清空待分配池（消除跨测试残留任务，保证 claim 只领到本测试创建的任务） */
function clearUnassigned(): void {
  dbModule.getDb().prepare(`UPDATE tasks SET status = 'failed', finished_at = ? WHERE status = 'unassigned'`)
    .run(new Date().toISOString());
}

beforeEach(() => {
  registerAgent({ id: 'worker-t1', name: 't1', role: 'worker' }); // upsert 幂等
  clearUnassigned();
});
after(() => { void teardownTestDb(); });

test('创建任务 → 初始 unassigned', () => {
  const t = createTask({ title: 't', prompt: 'p' });
  assert.equal(t.status, 'unassigned');
  assert.equal(t.assign_count, 0);
  assert.equal(t.priority, 5);
});

test('认领任务 → claimed + agent + assign_count+1', () => {
  const t = createTask({ title: 'claim', prompt: 'p' });
  const c = claimNextTask('worker-t1');
  assert.equal(c!.id, t.id);
  assert.equal(c!.status, 'claimed');
  assert.equal(c!.agent_id, 'worker-t1');
  assert.equal(c!.assign_count, 1);
  // agent 标 busy 是 handler 层职责（setAgentBusy），db 层只更新任务
  assert.equal(getAgent('worker-t1')!.status, 'idle');
});

test('已认领任务不会被第二个 Worker 抢走（原子性）', () => {
  const t = createTask({ title: 'racy', prompt: 'p' });
  const w1 = claimNextTask('worker-t1');
  assert.equal(w1!.id, t.id);
  // 第二个 claim 应拿到 null（池里已没有 unassigned）
  const again = claimNextTask('worker-t1');
  assert.equal(again, null);
  // 状态保持 claimed
  assert.equal(getTask(t.id)!.status, 'claimed');
});

test('状态机合法迁移 in_progress → completed', () => {
  const t = createTask({ title: 'flow', prompt: 'p' });
  const claimed = claimNextTask('worker-t1')!;
  const started = updateTaskStatus({ taskId: claimed.id, status: 'in_progress', agentId: 'worker-t1' });
  assert.equal(started.status, 'in_progress');
  assert.ok(started.started_at);
  const done = updateTaskStatus({ taskId: claimed.id, status: 'completed', result: 'ok', agentId: 'worker-t1' });
  assert.equal(done.status, 'completed');
  assert.equal(done.result, 'ok');
  assert.ok(done.finished_at);
});

test('非法迁移 rejected（completed → 任何）', () => {
  const t = createTask({ title: 'illegal', prompt: 'p' });
  const claimed = claimNextTask('worker-t1')!;
  updateTaskStatus({ taskId: claimed.id, status: 'in_progress', agentId: 'worker-t1' });
  updateTaskStatus({ taskId: claimed.id, status: 'completed', result: 'x', agentId: 'worker-t1' });
  const after = getTask(claimed.id)!;
  assert.equal(after.status, 'completed');
  // 终态再改（db 层守门）→ 抛错
  assert.throws(() => updateTaskStatus({ taskId: claimed.id, status: 'failed', error: 'x', agentId: 'worker-t1' }));
  // 非法迁移 unassigned -> completed → 抛错
  const fresh = createTask({ title: 'skip', prompt: 'p' });
  assert.throws(() => updateTaskStatus({ taskId: fresh.id, status: 'completed', result: 'x', agentId: 'worker-t1' }));
});

test('withTransaction 回滚：抛错后状态不变', () => {
  const t = createTask({ title: 'rollback', prompt: 'p' });
  assert.throws(() =>
    withTransaction(() => {
      updateTaskStatus({ taskId: t.id, status: 'claimed', agentId: 'worker-t1' });
      throw new Error('boom');
    })
  );
  assert.equal(getTask(t.id)!.status, 'unassigned');
});

test('相同优先级下 FIFO 领取', () => {
  const a = createTask({ title: 'a', prompt: 'pa', priority: 5 });
  const b = createTask({ title: 'b', prompt: 'pb', priority: 5 });
  const first = claimNextTask('worker-t1')!;
  assert.equal(first.id, a.id); // 先建先得
  const second = claimNextTask('worker-t1')!;
  assert.equal(second.id, b.id);
});
