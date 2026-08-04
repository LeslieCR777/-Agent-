import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { apiAsAgent, api, ApiClientError } from './client.js';
import { runAgent, prepareTaskDir } from './runner.js';
import { Heartbeater } from './heartbeat.js';
import { isCiTask, executeCiStage } from '../ci/execute.js';

/**
 * Worker 主循环（需求文档 FR-2/FR-3）：
 *   register → 心跳线程 → 轮询领取 → 执行（claude 子进程）→ 上报 → 释放 → 循环。
 * 崩溃恢复由服务端清扫器负责，Worker 自身只管"领到就干、干完就报"。
 * 依赖守死：本文件不 import 任何 db/ 模块，session/记忆全部走 HTTP。
 */

interface TaskPayload {
  task: {
    id: string;
    title: string;
    prompt: string;
    attachments: string | null;
    tags: string | null;
  };
}

function parseArgs(): { name: string; role: string } {
  const args = process.argv.slice(2);
  let name = 'worker';
  let role = 'worker';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name' && args[i + 1]) name = args[i + 1];
    if (args[i] === '--role' && args[i + 1]) role = args[i + 1];
  }
  return { name, role };
}

async function main(): Promise<void> {
  const { name, role } = parseArgs();
  const agentId = `${role}-${name}`;
  logger.info('worker', `starting ${role} "${name}" as ${agentId}`);

  // 1. 注册
  await api('/api/agents/register', {
    method: 'POST',
    body: { id: agentId, name, role },
  });
  logger.info('worker', `registered as ${agentId}`);

  // 2. 心跳
  const heart = new Heartbeater(agentId);
  heart.start();

  // 3. 主循环
  let consecutiveErrors = 0;
  while (true) {
    try {
      const claimed = await apiAsAgent<TaskPayload | null>(agentId, '/api/tasks/next', { method: 'POST' });
      if (!claimed) {
        consecutiveErrors = 0;
        await sleep(config.workerPollIntervalMs);
        continue;
      }

      consecutiveErrors = 0;
      await executeTask(agentId, claimed.task);

      // 4. 释放（回到 idle）
      await apiAsAgent(agentId, `/api/agents/${agentId}/release`, { method: 'POST' }).catch(() => {});
    } catch (err) {
      consecutiveErrors++;
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof ApiClientError && err.status >= 400 && err.status < 500) {
        consecutiveErrors = 0;
      }
      if (consecutiveErrors >= 5) {
        logger.error('worker', `too many consecutive errors, restarting: ${msg}`);
        heart.stop();
        process.exit(1);
      }
      logger.warn('worker', `loop error: ${msg}`);
      await sleep(Math.min(1000 * 2 ** consecutiveErrors, 15000));
    }
  }
}

/** 日志上报节流器：500ms 批量一次 PATCH in_progress（CI 任务也复用） */
export interface LogFlusher {
  push(line: string): void;
  flush(): Promise<void>;
}

function makeLogFlusher(agentId: string, taskId: string): LogFlusher {
  const logs: string[] = [];
  let flushing = false;
  let lastFlush = 0;
  const flushLogs = async () => {
    if (flushing || logs.length === 0) return;
    flushing = true;
    const batch = logs.splice(0);
    try {
      await apiAsAgent(agentId, `/api/tasks/${taskId}/status`, {
        method: 'PATCH',
        body: { status: 'in_progress', log: batch.join('\n') },
      });
    } catch {
      // 日志上报失败不致命
      logs.unshift(...batch); // 放回，避免丢日志
    } finally {
      flushing = false;
    }
  };
  return {
    push(line: string) {
      logs.push(line);
      const now = Date.now();
      if (now - lastFlush > 500) {
        lastFlush = now;
        void flushLogs();
      }
    },
    flush: () => flushLogs(),
  };
}

/** 执行单个任务：上报 in_progress → 准备资产 → 跑 agent → 逐行上报日志 → 上报终态 */
async function executeTask(agentId: string, task: { id: string; title: string; prompt: string; attachments: string | null; tags: string | null }): Promise<void> {
  logger.info('worker', `▶ executing task ${task.id.slice(0, 8)} "${task.title}"`);

  // 上报 in_progress（API 侧据此建 session）。这是后续 completed/failed
  // 的合法前置状态，必须确认成功；失败重试，避免快任务把 completed 顶到
  // 未 in_progress 的任务上被状态机拒绝。
  await reportInProgress(agentId, task.id);

  // 准备任务专属工作目录：建目录 + 下载引用的资产（attachment id 列表）
  const workdir = await prepareTaskDir(task.id, task.attachments);

  // CI 任务：走专门的 stage 执行器（工具 → prompt → agent → 产物上报）
  const tags = safeParseTags(task.tags);
  if (isCiTask(tags)) {
    await executeCiStage(agentId, task as Parameters<typeof executeCiStage>[1], workdir);
    return;
  }

  const flusher = makeLogFlusher(agentId, task.id);

  const runStart = Date.now();
  const result = await runAgent(task.prompt, {
    onLog: flusher.push,
  }, { cwd: workdir });
  const elapsed = Math.round((Date.now() - runStart) / 1000);
  await flusher.flush();

  logger.info('worker', `finish task ${task.id.slice(0, 8)} exit=${result.exitCode} elapsed=${elapsed}s output_len=${result.output.length}`);

  if (result.exitCode === 0 && !result.timedOut) {
    await apiAsAgent(agentId, `/api/tasks/${task.id}/status`, {
      method: 'PATCH',
      body: { status: 'completed', result: result.output.slice(0, 100_000) },
    });
  } else {
    const reason = result.timedOut ? 'agent timed out' : `agent exit ${result.exitCode}`;
    await apiAsAgent(agentId, `/api/tasks/${task.id}/status`, {
      method: 'PATCH',
      body: { status: 'failed', error: reason },
    }).catch(() => {});
  }
}

function safeParseTags(tagsJson: string | null): string[] | null {
  if (!tagsJson) return null;
  try {
    const parsed = JSON.parse(tagsJson);
    return Array.isArray(parsed) ? parsed.map(String) : null;
  } catch {
    return null;
  }
}

/** 上报 in_progress，失败重试直至成功（快任务场景的关键前置状态） */
async function reportInProgress(agentId: string, taskId: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await apiAsAgent(agentId, `/api/tasks/${taskId}/status`, {
        method: 'PATCH',
        body: { status: 'in_progress' },
      });
      return;
    } catch (err) {
      if (attempt === 4) throw err;
      await sleep(500 * 2 ** attempt);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  logger.error('worker', `fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
