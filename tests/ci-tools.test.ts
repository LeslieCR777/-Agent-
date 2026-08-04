import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDb, teardownTestDb } from './helpers.js';
import { contentHash } from '../src/ci/tools/hash.js';
import { extractText, extractPricing, extractJobListings } from '../src/ci/tools/extract.js';
import { webSearch } from '../src/ci/tools/search.js';

beforeEach(async () => { await setupTestDb(); });
afterEach(async () => { await teardownTestDb(); });

test('contentHash 确定性', () => {
  const h1 = contentHash('<html>hello</html>');
  const h2 = contentHash('<html>hello</html>');
  assert.equal(h1, h2);
  assert.equal(h1.length, 64); // SHA-256 hex
  assert.notEqual(h1, contentHash('<html>world</html>'));
});

test('extractText 去标签', () => {
  const html = '<html><head><script>var x=1;</script><style>.a{}</style></head><body><h1>标题</h1><p>正文</p></body></html>';
  const text = extractText(html);
  assert.ok(!text.includes('<h1>'));
  assert.ok(text.includes('标题'));
  assert.ok(text.includes('正文'));
});

test('extractPricing 命中 ¥299/月 和 $49/mo', () => {
  const html = '<div>Starter ¥299/月</div><div>Pro $49/mo plan</div>';
  const pricing = extractPricing(html);
  assert.ok(pricing.length >= 2, `expected >=2 pricing hits, got ${pricing.length}`);
  assert.ok(pricing.some((p) => p.price.includes('¥299') || p.price.includes('$49')));
});

test('extractJobListings 命中招聘链接', () => {
  const html = '<a href="/careers">加入我们</a><a href="/jobs/senior">高级工程师</a><a href="/blog">博客</a>';
  const jobs = extractJobListings(html);
  assert.equal(jobs.length, 2);
  assert.ok(jobs.some((j) => j.url.includes('careers')));
  assert.ok(jobs.some((j) => j.url.includes('jobs')));
});

test('webSearch 无 key 回退 demo 桩', async () => {
  const results = await webSearch('竞品融资');
  assert.ok(results.length > 0);
  assert.ok(results.every((r) => r.title && r.link));
});
