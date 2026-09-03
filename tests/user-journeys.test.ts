import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDb, teardownTestDb } from './helpers.js';
import { createCompetitor } from '@api/db/queries/competitors.js';
import {
  attachStageTask, createAnalysisBrief, createRun, getRunArtifacts, insertEvidence,
  listEvidence, reserveRunStage, reviewEvidence,
} from '@api/db/queries/analysis.js';
import { createProject, linkProjectRun, listProjectRuns } from '@api/db/queries/projects.js';
import { insertBattlecard, insertInsight, insertMatrix } from '@api/db/queries/ci.js';

before(async () => { await setupTestDb(); });
after(async () => { await teardownTestDb(); });

async function fixture() {
  const competitor = await createCompetitor({ name: 'Journey Competitor' });
  const project = await createProject({
    name: 'Journey Project', objective: 'Test end-to-end flow', market: 'CN',
    channels: ['official'], topics: ['pricing'], actor: 'user:analyst',
  });
  const brief = await createAnalysisBrief({
    our_product_id: null, competitor_ids: [competitor.id], purpose: 'competitor_only', market: 'CN',
    time_range_start: null, time_range_end: null, included_sources: ['official'], excluded_sources: [],
    max_runtime_seconds: 3600, cost_budget: 10, allow_unverified: false, created_by: 'user:analyst',
  });
  const run = await createRun({ brief, snapshot: { competitor, brief }, actor: 'user:analyst' });
  await linkProjectRun(project.id, run.id);
  return { competitor, project, run };
}

test('journey 1: project detail can create and revisit its analysis run', async () => {
  const { project, run } = await fixture();
  const runs = await listProjectRuns(project.id);
  const first = runs[0] as Record<string, unknown>;
  assert.equal(runs.length, 1);
  assert.equal(first.id, run.id);
  assert.equal((first.snapshot as { competitor: { name: string } }).competitor.name, 'Journey Competitor');
});

test('journey 2: run detail returns only the final artifacts produced by that run', async () => {
  const { competitor, run } = await fixture();
  const research = await reserveRunStage({ runId: run.id, stage: 'research', round: 0 });
  const compare = await reserveRunStage({ runId: run.id, stage: 'compare', round: 0 });
  const battlecard = await reserveRunStage({ runId: run.id, stage: 'battlecard', round: 0 });
  await attachStageTask(research.stage.id, 'task-research');
  await attachStageTask(compare.stage.id, 'task-compare');
  await attachStageTask(battlecard.stage.id, 'task-battlecard');
  await insertInsight(competitor.id, {
    topic: 'Pricing', summary: 'Price moved down', key_findings: ['Promotion started'], sources: [], confidence: 0.9,
  }, 0, null, 'task-research');
  await insertMatrix(competitor.id, {
    dimensions: [{ dimension: 'Price', our_score: 8, competitor_score: 7, notes: 'Comparable' }],
    overall_assessment: 'Our offer leads on price',
  }, 0, 'task-compare');
  await insertBattlecard(competitor.id, {
    our_strengths: ['Price'], our_weaknesses: ['Coverage'], competitor_strengths: ['Brand'],
    competitor_weaknesses: ['Cost'], key_differentiators: ['Value'], objection_handling: {}, elevator_pitch: 'Better value',
  }, 0, 'task-battlecard');
  const artifacts = await getRunArtifacts(run.id);
  assert.equal((artifacts.insights[0] as Record<string, unknown>).summary, 'Price moved down');
  assert.equal((artifacts.matrices[0].dimensions as Array<{ dimension: string }>)[0].dimension, 'Price');
  assert.equal((artifacts.battlecards[0].content as { elevator_pitch: string }).elevator_pitch, 'Better value');
});

test('journey 3: evidence queue can view, approve and reject evidence', async () => {
  const { competitor, run } = await fixture();
  const create = (suffix: string) => insertEvidence({
    run_id: run.id, competitor_id: competitor.id, request_url: `https://example.com/${suffix}`,
    title: `Evidence ${suffix}`, raw_content: `Full evidence body ${suffix}`, body_hash: suffix.repeat(64).slice(0, 64),
  });
  const approved = await create('a');
  const rejected = await create('b');
  assert.match(String(approved.raw_content), /Full evidence body/);
  await reviewEvidence(String(approved.id), 'verified', 'user:analyst', 'Source confirmed');
  await reviewEvidence(String(rejected.id), 'rejected', 'user:analyst', 'Wrong market');
  const verifiedRows = await listEvidence({ runId: run.id, status: 'verified', page: 1, size: 20 });
  const rejectedRows = await listEvidence({ runId: run.id, status: 'rejected', page: 1, size: 20 });
  assert.equal(verifiedRows.evidence[0].review_reason, 'Source confirmed');
  assert.equal(rejectedRows.evidence[0].review_reason, 'Wrong market');
});
