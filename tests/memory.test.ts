import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDb, teardownTestDb } from './helpers.js';

await setupTestDb();
const { embedTexts, hasRemoteEmbedding } = await import('../src/memory/embed.js');
const { cosine } = await import('../src/memory/search.js');
const { createMemory, allMemoriesWithVector, deleteMemory } = await import('../src/db/queries/memories.js');

after(() => { void teardownTestDb(); });

test('离线哈希 embedding 确定且同维度', async () => {
  assert.equal(hasRemoteEmbedding(), false);
  const [v1, v2, v3] = await embedTexts(['状态机用于任务流转', '状态机用于任务流转', '今天天气不错']);
  assert.ok(v1.length > 0);
  assert.deepEqual(Array.from(v1), Array.from(v2)); // 同文本 → 同向量
  assert.notDeepEqual(Array.from(v1), Array.from(v3)); // 不同文本 → 不同向量
});

test('余弦相似度：相同向量=1，正交=0', () => {
  const a = Float64Array.from([1, 0, 0]);
  const b = Float64Array.from([1, 0, 0]);
  const c = Float64Array.from([0, 1, 0]);
  assert.equal(cosine(a, b), 1);
  assert.equal(cosine(a, c), 0);
});

test('语义相似文本向量更接近', async () => {
  const [a] = await embedTexts(['如何部署 docker 容器']);
  const [b] = await embedTexts(['docker 容器部署教程']);
  const [c] = await embedTexts(['股票市场分析']);
  assert.ok(cosine(a, b) > cosine(a, c));
});

test('记忆写入后可检索、可删除', async () => {
  const [vec] = await embedTexts(['爬虫反爬经验']);
  const m = createMemory({ content: '爬虫要处理反爬机制', embedding: vec, source_task_id: 'task-x' });
  const all = allMemoriesWithVector();
  assert.ok(all.some((x) => x.id === m.id));
  assert.ok(deleteMemory(m.id));
  assert.equal(allMemoriesWithVector().some((x) => x.id === m.id), false);
});
