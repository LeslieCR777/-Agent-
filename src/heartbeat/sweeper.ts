import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { withTransaction, nowIso, query, exec } from '../db/index.js';
import { findStaleAgents, setAgentOffline } from '../db/queries/agents.js';
import { insertEvent } from '../db/queries/events.js';
import type { Agent } from '../shared/types.js';

/**
 * 服务端心跳清扫（需求文档 FR-3，MySQL 异步版）：
 * 每秒扫一次，把超过 HEARTBEAT_TIMEOUT_MS 未心跳的 agent 标 offline，
 * 并将其名下 claimed/in_progress 的任务事务性置 stale → 重派（回 unassigned）
 * 或超认领上限 → failed。任务绝不因 Worker 崩溃丢失。
 */

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startSweeper(): void {
  if (timer) return;
  logger.info('sweeper', `starting (timeout=${config.heartbeatTimeoutMs}ms, max_assign=${config.maxAssignCount})`);
  timer = setInterval(() => {
    void runSweep();
  }, config.sweepIntervalMs);
  timer.unref?.();
}

export function stopSweeper(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function runSweep(): Promise<void> {
  if (running) return; // 防重入
  running = true;
  try {
    const now = nowIso();
    const staleAgents = await findStaleAgents(config.heartbeatTimeoutMs, now);
    for (const agent of staleAgents) {
      await recoverAgent(agent, now);
    }
  } catch (err) {
    logger.error('sweeper', `sweep error: ${err instanceof Error ? err.message : err}`);
  } finally {
    running = false;
  }
}

async function recoverAgent(agent: Agent, now: string): Promise<void> {
  await withTransaction(async () => {
    // 1. 标 offline
    await setAgentOffline(agent.id);

    // 2. 找回该 agent 名下未完成的任务
    const tasks = await query<{ id: string; assign_count: number; status: string }>(
      `SELECT id, assign_count, status FROM tasks
       WHERE agent_id = ? AND status IN ('claimed','in_progress')`,
      [agent.id]
    );

    for (const task of tasks) {
      const canRetry = Number(task.assign_count) < config.maxAssignCount;
      await insertEvent({
        task_id: task.id,
        agent_id: agent.id,
        type: 'task_stale',
        payload: {
          reason: 'heartbeat_timeout',
          agent: agent.name,
          assign_count: Number(task.assign_count),
          will_retry: canRetry,
        },
      });

      if (canRetry) {
        // stale → unassigned：放回待分配池，可被其他 Worker 领取
        await exec(
          `UPDATE tasks SET status = 'unassigned', agent_id = NULL, claimed_at = NULL
           WHERE id = ? AND status IN ('claimed','in_progress')`,
          [task.id]
        );
      } else {
        // 认领超上限 → failed（bad 任务防死循环）
        await exec(
          `UPDATE tasks SET status = 'failed', error = ?, agent_id = NULL, finished_at = ?
           WHERE id = ? AND status IN ('claimed','in_progress')`,
          ['assign limit exceeded (task repeatedly crashed workers)', now, task.id]
        );
      }
    }

    if (tasks.length > 0) {
      logger.warn('sweeper', `recovered agent=${agent.name} task_count=${tasks.length}`);
    }
  });
}
