import {
  claimOutboxEvent,
  completeOutboxEvent,
  getRun,
  retryOutboxEvent,
  retryFailedStage,
} from '@api/db/queries/analysis.js';
import { kickoffPipeline, onCiTaskCompleted, onCiTaskFailed, retryRunStage } from '@orchestrator/ci/orchestrator.js';
import { logger } from '@platform/logger.js';
import { getTask } from '@api/db/queries/tasks.js';
import { maybeSendAlerts } from '@orchestrator/ci/alert.js';
import { latestSessionForTask } from '@api/db/queries/sessions.js';
import { distillTaskExperience } from '@orchestrator/memory/distill.js';

let timer: NodeJS.Timeout | null = null;
let working = false;

async function dispatchOnce(): Promise<void> {
  if (working) return;
  working = true;
  try {
    for (let i = 0; i < 20; i++) {
      const event = await claimOutboxEvent();
      if (!event) break;
      try {
        if (event.event_type === 'run.queued') {
          const run = await getRun(event.aggregate_id);
          const competitor = run?.snapshot.competitor as { id?: string } | undefined;
          if (!run || !competitor?.id) throw new Error('INVALID_RUN_SNAPSHOT');
          if (!['cancelled', 'published'].includes(run.status)) {
            await kickoffPipeline(competitor.id, 'full', { runId: run.id });
          }
        } else if (event.event_type === 'run.resume_requested') {
          const run = await getRun(event.aggregate_id);
          const competitor = run?.snapshot.competitor as { id?: string; name?: string } | undefined;
          if (!run || !competitor?.id || !competitor.name) throw new Error('INVALID_RUN_SNAPSHOT');
          await kickoffPipeline(competitor.id, 'full', { runId: run.id, startStage: 'compare' });
        } else if (event.event_type === 'stage.retry_requested') {
          const run = await getRun(event.aggregate_id);
          if (!run) throw new Error('NOT_FOUND');
          const stages = await import('@api/db/queries/analysis.js').then((m) => m.listRunStages(run.id));
          const stage = stages.find((item) => item.status === 'queued' && item.task_id === null);
          if (!stage) throw new Error('NO_RETRYABLE_STAGE');
          await retryRunStage(stage);
        } else if (event.event_type === 'legacy.pipeline_requested') {
          await kickoffPipeline(
            String(event.payload.competitor_id),
            event.payload.mode === 'monitor' ? 'monitor' : 'full'
          );
        } else if (event.event_type === 'alerts.send_requested') {
          await maybeSendAlerts(String(event.payload.competitor_id));
        } else if (event.event_type === 'task.completed' || event.event_type === 'task.failed') {
          const task = await getTask(String(event.payload.task_id));
          if (task) {
            if (event.event_type === 'task.completed') {
              await onCiTaskCompleted(task);
              if (task.result && task.source !== 'ci') {
                const session = await latestSessionForTask(task.id);
                void distillTaskExperience({
                  taskId: task.id,
                  taskTitle: task.title,
                  taskPrompt: task.prompt,
                  output: session?.output ?? '',
                  result: task.result,
                });
              }
            } else await onCiTaskFailed(task);
          }
        }
        await completeOutboxEvent(event.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await retryOutboxEvent(event.id, event.attempts, message);
        logger.warn('outbox', `${event.event_type} failed: ${message}`);
      }
    }
  } finally {
    working = false;
  }
}

export function startOutboxDispatcher(intervalMs = 1000): void {
  if (timer) return;
  timer = setInterval(() => { void dispatchOnce(); }, intervalMs);
  timer.unref?.();
  void dispatchOnce();
  logger.info('outbox', `dispatcher started every ${intervalMs}ms`);
}

export function stopOutboxDispatcher(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export { dispatchOnce };
