import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routeFromHash, routeToHash } from '../apps/web/src/navigation.js';

test('控制台导航路由支持顶层页面与运行详情', () => {
  assert.deepEqual(routeFromHash('#evidence'), { tab: 'evidence', runId: null });
  assert.deepEqual(routeFromHash('#competitors'), { tab: 'competitors', runId: null });
  assert.deepEqual(routeFromHash('#runs/run-123'), { tab: 'runs', runId: 'run-123' });
  assert.deepEqual(routeFromHash('#/runs/run%2F123'), { tab: 'runs', runId: 'run/123' });
  assert.deepEqual(routeFromHash('#unknown'), { tab: 'projects', runId: null });
  assert.equal(routeToHash({ tab: 'projects', runId: null }), '#projects');
  assert.equal(routeToHash({ tab: 'runs', runId: 'run/123' }), '#runs/run%2F123');
});
