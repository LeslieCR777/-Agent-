import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDb, teardownTestDb } from './helpers.js';
import { createCompetitor } from '../src/db/queries/competitors.js';
import {
  upsertPageHash, insertChanges, listChanges,
  insertInsight, latestInsights,
  insertMatrix, latestMatrix,
  insertBattlecard, latestBattlecard, setBattlecardQuality,
  insertAlert, listAlerts, pendingHighCriticalChanges,
} from '../src/db/queries/ci.js';
import type { CompetitorChange } from '../src/shared/types.js';

let compId = '';

beforeEach(async () => {
  await setupTestDb();
  compId = createCompetitor({ name: '竞品 A' }).id;
});
afterEach(async () => { await teardownTestDb(); });

const change = (hash: string, severity: 'high' | 'medium' = 'medium'): CompetitorChange => ({
  competitor: '竞品 A', change_type: 'pricing', title: '价格调整', summary: '摘要',
  url: 'https://a.com', severity, raw_data: { h: hash },
});

test('upsertPageHash：首次 changed，同 hash 不再变', () => {
  assert.equal(upsertPageHash({ competitor_id: compId, url: 'https://a.com', sha256: 'abc' }).changed, true);
  assert.equal(upsertPageHash({ competitor_id: compId, url: 'https://a.com', sha256: 'abc' }).changed, false);
  assert.equal(upsertPageHash({ competitor_id: compId, url: 'https://a.com', sha256: 'def' }).changed, true);
});

test('insertChanges 去重：同 content_hash 二次插入 inserted=0', () => {
  const c1 = change('hash1');
  const r1 = insertChanges(compId, [c1], 't1');
  assert.equal(r1.inserted, 1);
  const r2 = insertChanges(compId, [c1], 't2');
  assert.equal(r2.inserted, 0);
  assert.equal(listChanges(compId).length, 1);
});

test('latestMatrix / latestBattlecard 取最新 round', () => {
  const mk = (n: number) => ({
    dimensions: [{ dimension: 'D', our_score: n, competitor_score: n, notes: '' }],
    overall_assessment: 'assess' + n,
  });
  insertMatrix(compId, mk(1), 0, 't1');
  insertMatrix(compId, mk(2), 1, 't2');
  const latest = latestMatrix(compId)!;
  assert.equal(latest.round, 1);
  assert.equal(latest.dimensions[0].our_score, 2);

  const bc = {
    our_strengths: ['a'], our_weaknesses: [], competitor_strengths: [],
    competitor_weaknesses: [], key_differentiators: [], objection_handling: {}, elevator_pitch: 'p',
  };
  insertBattlecard(compId, bc, 0, 't1');
  insertBattlecard(compId, bc, 1, 't2');
  assert.equal(latestBattlecard(compId)!.round, 1);
});

test('setBattlecardQuality 回填 quality_score', () => {
  const bc = {
    our_strengths: ['a'], our_weaknesses: [], competitor_strengths: [],
    competitor_weaknesses: [], key_differentiators: [], objection_handling: {}, elevator_pitch: 'p',
  };
  const row = insertBattlecard(compId, bc, 0, 't1');
  assert.equal(row.quality_score, null);
  setBattlecardQuality(row.id, { score: 9, feedback: '很好' });
  assert.equal(latestBattlecard(compId)!.quality_score, 9);
});

test('insertInsight / latestInsights 按 round 过滤', () => {
  insertInsight(compId, { topic: 't0', summary: 's0', key_findings: [], sources: [], confidence: 0.5 }, 0, null, 't1');
  insertInsight(compId, { topic: 't1', summary: 's1', key_findings: [], sources: [], confidence: 0.9 }, 1, null, 't2');
  const all = latestInsights(compId);
  assert.equal(all.length, 2);
  const r1 = latestInsights(compId, 1);
  assert.equal(r1.length, 1);
  assert.equal(r1[0].topic, 't1');
});

test('pendingHighCriticalChanges 排除已告警的 change', () => {
  const high = change('h1', 'high');
  const med = change('h2', 'medium');
  insertChanges(compId, [high, med], 't1');
  // 未告警时两条 high/critical 待处理（medium 不算）
  assert.equal(pendingHighCriticalChanges(compId).length, 1);
  const pending = pendingHighCriticalChanges(compId);
  const alert = insertAlert({ competitor_id: compId, change_id: pending[0].id, payload: 'x' });
  assert.ok(alert.id);
  // 告警后不再待处理
  assert.equal(pendingHighCriticalChanges(compId).length, 0);
  assert.equal(listAlerts().length, 1);
});
