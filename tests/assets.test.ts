import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDb, teardownTestDb } from './helpers.js';

await setupTestDb();
const { createAsset, listAssets, getAsset, deleteAsset, getAssets } = await import('../src/db/queries/assets.js');

after(() => { void teardownTestDb(); });

test('创建资产 → 可查可删', async () => {
  const a = await createAsset({ filename: 'f.csv', original_name: '数据.csv', size: 123, mime: 'text/csv' });
  assert.ok(a.id);
  assert.equal(a.original_name, '数据.csv');
  assert.equal(a.size, 123);

  const got = await getAsset(a.id);
  assert.ok(got);
  assert.equal(got!.filename, 'f.csv');

  const all = await listAssets();
  assert.ok(all.some((x) => x.id === a.id));

  assert.ok(await deleteAsset(a.id));
  assert.equal(await getAsset(a.id), null);
});

test('批量取资产 getAssets', async () => {
  const a = await createAsset({ filename: 'a.bin', original_name: 'a', size: 1 });
  const b = await createAsset({ filename: 'b.bin', original_name: 'b', size: 2 });
  const got = await getAssets([a.id, b.id]);
  assert.equal(got.length, 2);
  const ids = got.map((x) => x.id).sort();
  assert.deepEqual(ids, [a.id, b.id].sort());
});
