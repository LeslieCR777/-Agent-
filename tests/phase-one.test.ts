import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDb, teardownTestDb } from './helpers.js';
import { createCompetitor } from '@api/db/queries/competitors.js';
import {
  createAnalysisBrief,
  createClaim,
  createReport,
  createRun,
  evidenceGate,
  getReport,
  getRun,
  insertEvidence,
  reserveRunStage,
  reviewClaim,
  reviewEvidence,
  transitionReport,
  transitionRun,
} from '@api/db/queries/analysis.js';
import { assertSafeHttpUrl, UnsafeUrlError } from '@runtime/ci/tools/http.js';
import { validateBattlecard, validateMatrix } from '@runtime/ci/validate.js';
import { dispatchOnce } from '@orchestrator/outbox/dispatcher.js';
import { listRunStages } from '@api/db/queries/analysis.js';
import { config } from '@platform/config.js';
import { ensureBootstrapAdmin, login, verifySessionToken } from '@api/auth/index.js';

before(async () => { await setupTestDb(); });
after(async () => { await teardownTestDb(); });

test('运行冻结快照，阶段使用 (run_id, stage, round) 幂等', async () => {
  const competitor = await createCompetitor({ name: '阶段一竞品' });
  const brief = await createAnalysisBrief({
    our_product_id: null,
    competitor_ids: [competitor.id],
    purpose: 'competitor_only',
    market: 'CN',
    time_range_start: null,
    time_range_end: null,
    included_sources: ['example.com'],
    excluded_sources: [],
    max_runtime_seconds: 600,
    cost_budget: 5,
    allow_unverified: false,
    created_by: 'tester',
  });
  const frozen = { competitor: { id: competitor.id, name: competitor.name }, marker: 'old' };
  const run = await createRun({ brief, snapshot: frozen, actor: 'tester' });
  frozen.marker = 'new';
  assert.equal((await getRun(run.id))!.snapshot.marker, 'old');

  const first = await reserveRunStage({ runId: run.id, stage: 'monitor', round: 0 });
  const duplicate = await reserveRunStage({ runId: run.id, stage: 'monitor', round: 0 });
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(first.stage.id, duplicate.stage.id);
});

test('Evidence → Claim → Report 门禁及驳回失效传播', async () => {
  const competitor = await createCompetitor({ name: '证据竞品' });
  const brief = await createAnalysisBrief({
    our_product_id: null, competitor_ids: [competitor.id], purpose: 'competitor_only',
    market: 'US', time_range_start: null, time_range_end: null,
    included_sources: [], excluded_sources: [], max_runtime_seconds: 600,
    cost_budget: 5, allow_unverified: false, created_by: 'tester',
  });
  const run = await createRun({
    brief,
    snapshot: { competitor, source_policy: { allow_unverified: false } },
    actor: 'tester',
  });
  const evidence = await insertEvidence({
    run_id: run.id, competitor_id: competitor.id,
    request_url: 'https://example.com/product', body_hash: 'a'.repeat(64),
    raw_content: 'price: $260',
  });
  const claim = await createClaim({
    run_id: run.id, statement: '产品价格为 260 美元', subject: 'SKU-A',
    claim_type: 'price', confidence: 0.95, evidence_ids: [String(evidence.id)],
  });
  assert.equal((await evidenceGate(run.id)).allowed, false);
  await reviewEvidence(String(evidence.id), 'verified', 'reviewer', '官网可访问');
  await reviewClaim(String(claim.id), 'verified', 'reviewer', '与页面一致');
  assert.equal((await evidenceGate(run.id)).allowed, true);

  await transitionRun(run.id, 'running', 'system');
  await transitionRun(run.id, 'waiting_review', 'system');
  const report = await createReport(run.id, { title: '报告', summary: '已核验结论' }, [String(claim.id)], 'analyst');
  await transitionReport(String(report.id), 'reviewing', 'analyst');
  await transitionReport(String(report.id), 'approved', 'reviewer');
  await transitionReport(String(report.id), 'published', 'reviewer');
  assert.equal((await getRun(run.id))!.status, 'published');

  await reviewEvidence(String(evidence.id), 'rejected', 'reviewer', '来源内容被撤回');
  const invalid = await getReport(String(report.id));
  assert.equal(Number(invalid!.invalidated), 1);
});

test('安全抓取在发请求前拒绝回环地址和云元数据地址', async () => {
  await assert.rejects(() => assertSafeHttpUrl('http://127.0.0.1/admin'), UnsafeUrlError);
  await assert.rejects(() => assertSafeHttpUrl('http://169.254.169.254/latest/meta-data'), UnsafeUrlError);
  await assert.rejects(() => assertSafeHttpUrl('file:///etc/passwd'), UnsafeUrlError);
});

test('确定性校验拒绝缺维度矩阵和空战卡', () => {
  assert.throws(() => validateMatrix({ dimensions: [], overall_assessment: '' }));
  assert.throws(() => validateBattlecard({
    our_strengths: [], our_weaknesses: [], competitor_strengths: [],
    competitor_weaknesses: [], key_differentiators: [],
    objection_handling: {}, elevator_pitch: '',
  }));
});

test('Outbox 投递 run.queued，重复消费不产生重复阶段', async () => {
  const competitor = await createCompetitor({ name: 'Outbox 竞品' });
  const brief = await createAnalysisBrief({
    our_product_id: null, competitor_ids: [competitor.id], purpose: 'competitor_only',
    market: 'CN', time_range_start: null, time_range_end: null,
    included_sources: [], excluded_sources: [], max_runtime_seconds: 600,
    cost_budget: 5, allow_unverified: false, created_by: 'tester',
  });
  const run = await createRun({
    brief, snapshot: { competitor, source_policy: { allow_unverified: false } }, actor: 'tester',
  });
  await dispatchOnce();
  await dispatchOnce();
  const stages = await listRunStages(run.id);
  assert.equal(stages.filter((s) => s.stage === 'monitor' && s.round === 0).length, 1);
  assert.ok(stages[0].task_id);
});

test('用户密码使用哈希存储并签发可验证的限时会话', async () => {
  config.adminUsername = 'phase-one-admin';
  config.adminPassword = 'strong-password-123';
  await ensureBootstrapAdmin();
  assert.equal(await login(config.adminUsername, 'wrong-password'), null);
  const token = await login(config.adminUsername, config.adminPassword);
  assert.ok(token);
  assert.equal(verifySessionToken(token!)?.username, config.adminUsername);
});
