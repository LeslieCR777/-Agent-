import type { Run, RunArtifacts, RunStageRow, StageKind } from './models.js';
import { STAGE_PROGRESS } from './constants.js';

export function isCompetitorOnlyRun(run: Run): boolean {
  return run.snapshot?.brief?.purpose === 'competitor_only';
}

export function isRunAnalysisComplete(run: Run, stages: RunStageRow[]): boolean {
  if (run.status === 'published') return true;
  const competitorOnly = isCompetitorOnlyRun(run);
  const requiredStage = competitorOnly ? 'compare' : 'quality';
  const requiredStageCompleted = stages.some(
    (stage) => stage.stage === requiredStage && stage.status === 'completed',
  );
  if (competitorOnly) return requiredStageCompleted;
  return run.status === 'waiting_review' && requiredStageCompleted;
}

export function effectiveRunProgress(run: Run, stages: RunStageRow[], artifacts?: RunArtifacts): number {
  const competitorOnly = run.snapshot?.brief?.purpose === 'competitor_only';
  const completed = stages.filter((stage) => stage.status === 'completed').map((stage) => (
    competitorOnly && stage.stage === 'compare' ? 100 : STAGE_PROGRESS[stage.stage] ?? 0
  ));
  const artifactProgress = artifacts
    ? artifacts.reports.length ? 100
      : artifacts.battlecards.length ? STAGE_PROGRESS.battlecard
        : artifacts.matrices.length ? (competitorOnly ? 100 : STAGE_PROGRESS.compare)
        : artifacts.insights.length ? STAGE_PROGRESS.research : 0
    : 0;
  return Math.min(100, Math.max(run.progress ?? 0, artifactProgress, ...completed, 0));
}

export function progressDescription(run: Run, progress: number, hasQuality: boolean): string {
  if (hasQuality || progress >= 100) return '全部分析阶段已完成';
  if (run.status === 'waiting_review') return '调研已完成，等待证据与声明审核后继续';
  if (run.status === 'failed') return '运行中断，可查看失败阶段并重试';
  if (run.status === 'cancelled') return '运行已取消';
  if (run.status === 'queued') return '任务已排队，等待执行';
  return '正在执行分析流水线';
}

export function stageLabel(stage: StageKind | null): string | null {
  if (!stage) return null;
  const labels: Record<StageKind, string> = {
    monitor: '信息监测', research: '深度调研', compare: '竞争对比', battlecard: '销售战卡', quality: '质量检查',
  };
  return labels[stage];
}
