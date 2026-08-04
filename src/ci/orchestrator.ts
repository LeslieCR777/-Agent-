import { createTask } from '../db/queries/tasks.js';
import { getCompetitor, touchCompetitor } from '../db/queries/competitors.js';
import { latestBattlecard } from '../db/queries/ci.js';
import { insertEvent } from '../db/queries/events.js';
import { config } from '../shared/config.js';
import {
  CI_TAG,
  CI_STAGE_ORDER,
  CI_QUALITY_THRESHOLD,
  CI_MAX_REFLEXION_ROUNDS,
  CI_STAGE_PRIORITY,
} from '../shared/constants.js';
import type { CiStage, Task } from '../shared/types.js';
import { maybeSendAlerts } from './alert.js';

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

export interface CiTagInfo {
  stage: CiStage;
  competitorId: string;
  mode: 'full' | 'monitor';
  round: number;
}

/** 解析 CI 任务 tags：['ci', stage, competitorId, '<mode>:<round>'] */
export function parseCiTags(tags: string[] | null): CiTagInfo | null {
  if (!tags || tags.length < 2 || tags[0] !== CI_TAG) return null;
  const stage = tags[1] as CiStage;
  if (!CI_STAGE_ORDER.includes(stage) && stage !== 'daily_monitor') return null;
  const competitorId = tags[2] ?? '';
  const meta = tags[3] ?? 'full:0';
  const [modeRaw, roundRaw] = meta.split(':');
  const mode = modeRaw === 'monitor' ? 'monitor' : 'full';
  const round = Number.parseInt(roundRaw ?? '0', 10);
  return { stage, competitorId, mode, round: Number.isFinite(round) ? round : 0 };
}

/** 发起流水线：先建 monitor stage 任务 */
export async function kickoffPipeline(competitorId: string, mode: 'full' | 'monitor'): Promise<Task> {
  const competitor = await getCompetitor(competitorId);
  if (!competitor) throw new Error('NOT_FOUND');
  await insertEvent({ type: 'ci_pipeline_started', payload: { competitor_id: competitorId, mode } });
  return createStage({ competitorId, competitorName: competitor.name, stage: 'monitor', mode, round: 0 });
}

async function createStage(input: {
  competitorId: string;
  competitorName: string;
  stage: CiStage;
  mode: 'full' | 'monitor';
  round: number;
  feedback?: string;
}): Promise<Task> {
  const title = `[CI] ${input.stage} ${input.competitorName} (round ${input.round})`;
  // prompt 是占位说明 + 跨进程上下文（feedback 等）：真实指令由 Worker 执行时构建
  const parts = [
    `[CI stage=${input.stage} competitor=${input.competitorId} mode=${input.mode} round=${input.round}]`,
  ];
  if (input.feedback) parts.push(`[CI feedback=${input.feedback}]`);
  const prompt = parts.join('\n');
  return createTask({
    title,
    prompt,
    source: 'ci',
    tags: [CI_TAG, input.stage, input.competitorId, `${input.mode}:${input.round}`],
    priority: CI_STAGE_PRIORITY,
  });
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

  switch (info.stage) {
    case 'monitor': {
      await touchCompetitor(competitorId, { status: 'monitoring', last_checked_at: task.finished_at ?? undefined });
      const inserted = changesInserted(task);
      const continuePipeline = info.mode === 'full' || inserted > 0;
      if (continuePipeline) {
        await createStage({ competitorId, competitorName: competitor.name, stage: 'research', mode: info.mode, round: info.round });
      } else {
        await finishCompetitorRun(competitorId);
      }
      break;
    }
    case 'research':
    case 'compare':
    case 'battlecard': {
      const next = nextStage(info.stage);
      if (next) {
        await createStage({ competitorId, competitorName: competitor.name, stage: next, mode: info.mode, round: info.round });
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
        });
      } else {
        await finishCompetitorRun(competitorId);
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
  await finishCompetitorRun(info.competitorId, task.error ?? 'ci stage failed');
}

function safeParseTags(tagsJson: string): string[] | null {
  try {
    const parsed = JSON.parse(tagsJson);
    return Array.isArray(parsed) ? parsed.map(String) : null;
  } catch {
    return null;
  }
}
