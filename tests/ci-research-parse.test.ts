import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseResearchInsights } from '@runtime/ci/execute.js';

test('parseResearchInsights: accepts an insights envelope', () => {
  const insight = {
    topic: 'Product',
    summary: 'summary',
    key_findings: ['finding'],
    sources: [{ title: 'source', url: 'https://example.com' }],
    confidence: 0.8,
  };
  const parsed = parseResearchInsights(JSON.stringify({ insights: [insight] }));
  assert.deepEqual(parsed, [insight]);
});

test('parseResearchInsights: normalizes citation aliases', () => {
  const parsed = parseResearchInsights(JSON.stringify([{ topic: 'Product', references: [{ name: 'Nike', href: 'https://nike.example/product' }] }]));
  assert.deepEqual(parsed[0].sources, [{ title: 'Nike', url: 'https://nike.example/product' }]);
});

test('parseResearchInsights: uses real search evidence when sources are omitted', () => {
  const parsed = parseResearchInsights(
    JSON.stringify([{ topic: '财务状况', summary: 'summary' }]),
    [{ query: 'NIKE 融资 财务 营收', results: [{ title: 'Financial result', link: 'https://example.com/finance', snippet: 'result' }] }]
  );
  assert.deepEqual(parsed[0].sources, [{ title: 'Financial result', url: 'https://example.com/finance' }]);
});
