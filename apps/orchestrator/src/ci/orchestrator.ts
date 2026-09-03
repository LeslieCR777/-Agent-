import { createTask, getTask } from '@api/db/queries/tasks.js';
import { getCompetitor, touchCompetitor } from '@api/db/queries/competitors.js';
import { latestBattlecard } from '@api/db/queries/ci.js';
import { insertEvent } from '@api/db/queries/events.js';
import { config } from '@platform/config.js';
import {
  CI_TAG,
  CI_STAGE_ORDER,
  CI_QUALITY_THRESHOLD,
  CI_MAX_REFLEXION_ROUNDS,
  CI_STAGE_PRIORITY,
} from '@contracts/constants.js';
import type { CiStage, Task } from '@contracts/types.js';
import { parseCiTags, type CiTagInfo } from '@contracts/ci-tags.js';
export { parseCiTags } from '@contracts/ci-tags.js';
import { maybeSendAlerts } from './alert.js';
import {
  attachStageTask,
  getRun,
  markStageCompleted,
  markStageFailed,
  reserveRunStage,
  transitionRun,
  evidenceGate,
  type RunStage,
} from '@api/db/queries/analysis.js';

/**
 * CI 流水线编排器（服务端，允许 import db 层）。
 *
 * 每个 stage 是一个独立的 Worker 任务，tags 形如 ['ci', stage, competitorId, '<mode>:<round>']。
 * stage 任务完成后（task_completed 事件钩子），orchestrator 决定是否接力下一个 stage。
 *
 *   full:    monitor → research → compare → battlecard → quality
 *             └─ quality 不达标且未达上限 → 回 research(round+1)（Reflexion）
 *             └─ 达标/达上限 → 竞品 status=idle + 触发告警
 *   monitor: 仅监控；有变化才续 research，否则结束
 *
 * Worker 无状态："领到就干、干完就报"。接力即建下个 stage 任务，
 * 天然复用既有 claim/heartbeat/sweeper 故障恢复。
 */

/** 发起流水线：先建 monitor stage 任务 */
export async function kickoffPipeline(
  competitorId: string,
  mode: 'full' | 'monitor',
  options: { runId?: string; startStage?: Exclude<CiStage, 'daily_monitor'> } = {}
): Promise<Task> {
  const competitor = await getCompetitor(competitorId);
  if (!competitor) throw new Error('NOT_FOUND');
  await insertEvent({ type: 'ci_pipeline_started', payload: { competitor_id: competitorId, mode } });
  return createStage({
    competitorId, competitorName: competitor.name, stage: options.startStage ?? 'monitor', mode, round: 0,
    runId: options.runId,
  });
}

async function createStage(input: {
  competitorId: string;
  competitorName: string;
  stage: CiStage;
  mode: 'full' | 'monitor';
  round: number;
  feedback?: string;
  runId?: string;
  parentId?: string | null;
}): Promise<Task> {
  let reserved: Awaited<ReturnType<typeof reserveRunStage>> | null = null;
  if (input.runId) {
    reserved = await reserveRunStage({
      runId: input.runId, stage: input.stage as Exclude<CiStage, 'daily_monitor'>,
      round: input.round, input: { competitor_id: input.competitorId },
      model: config.agentModel, promptVersion: 'p1-v1',
      tools: input.stage === 'monitor' ? ['safe_fetch', 'extract', 'hash'] :
        input.stage === 'research' ? ['search', 'safe_fetch', 'claim'] : [],
    });
    if (reserved.stage.task_id) {
      const existingTask = await getTask(reserved.stage.task_id);
      if (existingTask) return existingTask;
    }
  }
  const title = `[CI] ${input.stage} ${input.competitorName} (round ${input.round})`;
  // prompt 是占位说明 + 跨进程上下文（feedback 等）：真实指令由 Worker 执行时构建
  const parts = [
    `[CI stage=${input.stage} competitor=${input.competitorId} mode=${input.mode} round=${input.round}]`,
  ];
  if (input.feedback) parts.push(`[CI feedback=${input.feedback}]`);
  const prompt = parts.join('\n');
  const tags = [CI_TAG, input.stage, input.competitorId, `${input.mode}:${input.round}`];
  if (input.runId) tags.push(`run:${input.runId}`);
  const task = await createTask({
    title,
    prompt,
    parent_id: input.parentId ?? null,
    source: 'ci',
    tags,
    priority: CI_STAGE_PRIORITY,
  });
  if (reserved) await attachStageTask(reserved.stage.id, task.id);
  return task;
}

/** 从 monitor 任务结果中解析 CHANGES_INSERTED（Worker 上报 result 时带上） */
function changesInserted(task: Task): number {
  const m = task.result?.match(/CHANGES_INSERTED=(\d+)/);
  return m ? Number.parseInt(m[1], 10) : 0;
}

/** 接力下个 stage（按 CI_STAGE_ORDER 顺序） */
function nextStage(stage: CiStage): CiStage | null {
  const i = CI_STAGE_ORDER.indexOf(stage);
  if (i === -1 || i >= CI_STAGE_ORDER.length - 1) return null;
  return CI_STAGE_ORDER[i + 1] as CiStage;
}

/** 结束本轮竞品分析：竞品状态回到 idle */
async function finishCompetitorRun(competitorId: string, error?: string): Promise<void> {
  await touchCompetitor(competitorId, { status: 'idle', last_error: error ?? null });
}

/**
 * stage 任务完成回调（server.ts 事件钩子调用，async）。
 * 同一事务内只做 DB 操作；告警异步 fire-and-forget。
 */
export async function onCiTaskCompleted(task: Task): Promise<void> {
  const info = parseCiTags(task.tags ? safeParseTags(task.tags) : null);
  if (!info || task.status !== 'completed') return;

  const competitorId = info.competitorId;
  if (!competitorId) return;

  const competitor = await getCompetitor(competitorId);
  if (!competitor) return;
  if (info.runId) {
    await markStageCompleted(task.id, { result: task.result ?? null });
    const run = await getRun(info.runId);
    if (!run || run.status === 'cancelled' || run.status === 'published') return;
    const brief = run.snapshot.brief as { max_runtime_seconds?: number } | undefined;
    const maxSeconds = Number(brief?.max_runtime_seconds ?? 3600);
    const started = Date.parse(run.started_at ?? run.created_at);
    if (Number.isFinite(started) && Date.now() - started > maxSeconds * 1000) {
      await transitionRun(run.id, 'failed', 'system:budget', 'MAX_RUNTIME_EXCEEDED');
      await finishCompetitorRun(competitorId, 'MAX_RUNTIME_EXCEEDED');
      return;
    }
  }

  switch (info.stage) {
    case 'monitor': {
      await touchCompetitor(competitorId, { status: 'monitoring', last_checked_at: task.finished_at ?? undefined });
      const inserted = changesInserted(task);
      const continuePipeline = info.mode === 'full' || inserted > 0;
      if (continuePipeline) {
        await createStage({ competitorId, competitorName: competitor.name, stage: 'research', mode: info.mode, round: info.round, runId: info.runId ?? undefined, parentId: task.id });
      } else {
        await finishCompetitorRun(competitorId);
      }
      break;
    }
    case 'research':
      if (info.runId) {
        const gate = await evidenceGate(info.runId);
        if (!gate.allowed) {
          const run = await getRun(info.runId);
          if (run?.status === 'running') {
            await transitionRun(info.runId, 'waiting_review', 'system:evidence-gate');
          }
          break;
        }
      }
    case 'compare':
      if (info.runId) {
        const run = await getRun(info.runId);
        const purpose = (run?.snapshot.brief as { purpose?: string } | undefined)?.purpose;
        if (purpose === 'competitor_only') {
          await finishCompetitorRun(competitorId);
          if (run?.status === 'running') {
            await transitionRun(info.runId, 'waiting_review', 'system:orchestrator');
            await transitionRun(info.runId, 'published', 'system:orchestrator');
          }
          break;
        }
      }
    case 'battlecard': {
      const next = nextStage(info.stage);
      if (next) {
        await createStage({ competitorId, competitorName: competitor.name, stage: next, mode: info.mode, round: info.round, runId: info.runId ?? undefined, parentId: task.id });
      } else {
        await finishCompetitorRun(competitorId);
      }
      break;
    }
    case 'quality': {
      const bc = await latestBattlecard(competitorId);
      const score = bc?.quality_score ?? null;
      const passed = score !== null && score >= config.ciQualityThreshold;
      const canRetry = info.round + 1 <= config.ciMaxReflexionRounds;
      await insertEvent({
        type: 'ci_quality_checked',
        payload: { competitor_id: competitorId, score, passed, round: info.round },
      });
      if (!passed && canRetry) {
        // Reflexion：回 research 重搜，带上质检反馈
        await createStage({
          competitorId,
          competitorName: competitor.name,
          stage: 'research',
          mode: info.mode,
          round: info.round + 1,
          feedback: bc?.quality_detail ?? undefined,
          runId: info.runId ?? undefined,
          parentId: task.id,
        });
      } else {
        await finishCompetitorRun(competitorId);
        if (info.runId) {
          const run = await getRun(info.runId);
          if (run?.status === 'running') await transitionRun(info.runId, 'waiting_review', 'system:orchestrator');
        }
        // 告警异步执行：不阻塞 orchestrator
        void maybeSendAlerts(competitorId);
      }
      break;
    }
    default:
      break;
  }
}

/** stage 任务失败：不接力，竞品标记 error（sweeper 会负责重派，重派仍失败则保持 error） */
export async function onCiTaskFailed(task: Task): Promise<void> {
  const info = parseCiTags(task.tags ? safeParseTags(task.tags) : null);
  if (!info || !info.competitorId) return;
  if (info.runId) await markStageFailed(task.id, task.error ?? 'ci stage failed');
  await finishCompetitorRun(info.competitorId, task.error ?? 'ci stage failed');
}

/** 失败阶段清空 task_id 后，仅重建该阶段，不重跑之前的成功阶段。 */
export async function retryRunStage(stage: RunStage): Promise<Task> {
  const run = await getRun(stage.run_id);
  if (!run) throw new Error('NOT_FOUND');
  const snapshot = run.snapshot;
  const competitor = snapshot.competitor as { id?: string; name?: string } | undefined;
  if (!competitor?.id || !competitor.name) throw new Error('INVALID_RUN_SNAPSHOT');
  return createStage({
    competitorId: competitor.id,
    competitorName: competitor.name,
    stage: stage.stage,
    mode: 'full',
    round: stage.round,
    runId: stage.run_id,
  });
}

/** 证据与 Claim 审核完成后，从 compare 阶段继续。 */
export async function resumeRunAfterReview(runId: string): Promise<Task> {
  const run = await getRun(runId);
  if (!run) throw new Error('NOT_FOUND');
  if (run.status !== 'waiting_review') throw new Error('RUN_NOT_WAITING_REVIEW');
  const gate = await evidenceGate(runId);
  if (!gate.allowed) throw new Error('EVIDENCE_GATE_FAILED');
  const competitor = run.snapshot.competitor as { id?: string; name?: string } | undefined;
  if (!competitor?.id || !competitor.name) throw new Error('INVALID_RUN_SNAPSHOT');
  await transitionRun(runId, 'running', 'user:reviewer');
  return createStage({
    competitorId: competitor.id, competitorName: competitor.name, stage: 'compare',
    mode: 'full', round: 0, runId,
  });
}

function safeParseTags(tagsJson: string): string[] | null {
  try {
    const parsed = JSON.parse(tagsJson);
    return Array.isArray(parsed) ? parsed.map(String) : null;
  } catch {
    return null;
  }
}
