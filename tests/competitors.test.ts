import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDb, teardownTestDb } from './helpers.js';
import { createCompetitor, getCompetitor, listCompetitors, listEnabledCompetitors, updateCompetitor, deleteCompetitor, touchCompetitor } from '../src/db/queries/competitors.js';

beforeEach(async () => { await setupTestDb(); });
afterEach(async () => { await teardownTestDb(); });

test('竞品 CRUD：创建 → 查询 → 更新 → 删除', () => {
  const c = createCompetitor({ name: '竞品 A', website: 'https://a.com', monitor_urls: ['https://a.com/pricing'] });
  assert.ok(c.id);
  assert.equal(c.status, 'idle');
  assert.equal(c.enabled, 1);

  const got = getCompetitor(c.id)!;
  assert.equal(got.name, '竞品 A');
  assert.deepEqual(JSON.parse(got.monitor_urls!), ['https://a.com/pricing']);

  const updated = updateCompetitor(c.id, { notes: '重点监控' })!;
  assert.equal(updated.notes, '重点监控');

  assert.equal(deleteCompetitor(c.id), true);
  assert.equal(getCompetitor(c.id), null);
});

test('enabled 过滤与列表', () => {
  const a = createCompetitor({ name: 'A', enabled: true });
  createCompetitor({ name: 'B', enabled: false });
  const all = listCompetitors();
  assert.equal(all.length, 2);
  const enabled = listEnabledCompetitors();
  assert.equal(enabled.length, 1);
  assert.equal(enabled[0].id, a.id);
});

test('touchCompetitor 更新监控状态', () => {
  const c = createCompetitor({ name: 'A' });
  touchCompetitor(c.id, { status: 'monitoring', last_checked_at: '2026-01-01T00:00:00Z' });
  const got = getCompetitor(c.id)!;
  assert.equal(got.status, 'monitoring');
  assert.equal(got.last_checked_at, '2026-01-01T00:00:00Z');
});
