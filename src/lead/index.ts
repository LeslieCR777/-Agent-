import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { api } from '../worker/client.js';
import { spawnAgent } from '../worker/runner.js';
import { AGENT_WORKDIR } from '../shared/constants.js';

/**
 * Lead Agent（需求文档 FR-4，独立进程）：
 *   claude 拆解父任务 → 解析 JSON 子任务数组 → 写入任务池（parent_id 关联）
 *   → 轮询子任务全部终态（多个 Worker 并行消费）→ claude 汇总 → 更新父任务。
 * 容错：子任务失败不影响其他子任务；全部失败也能给父任务一个失败总结。
 */

interface TaskDetail {
  task: {
    id: string;
    title: string;
    prompt: string;
    status: string;
    result: string | null;
    error: string | null;
  };
}

interface SubTaskSpec {
  title: string;
  prompt: string;
}

function parseArgs(): { taskId: string } {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--taskId');
  const taskId = idx >= 0 && args[idx + 1] ? args[idx + 1] : '';
  return { taskId };
}

async function main(): Promise<void> {
  const { taskId } = parseArgs();
  if (!taskId) {
    logger.error('lead', 'usage: npm run lead -- --taskId <parent_task_id>');
    process.exit(1);
  }

  // 0. 注册为 lead agent
  await api('/api/agents/register', {
    method: 'POST',
    body: { id: 'lead-main', name: 'lead-main', role: 'lead' },
  }).catch(() => {});
  // lead 常驻心跳，避免被清扫器标 offline
  const heartTimer = setInterval(() => {
    void api('/api/agents/lead-main/heartbeat', { method: 'POST', agentId: 'lead-main' }).catch(() => {});
  }, config.heartbeatIntervalMs);
  heartTimer.unref?.();

  const parent = await api<TaskDetail>(`/api/tasks/${taskId}`);
  logger.info('lead', `拆解父任务 ${taskId.slice(0, 8)} "${parent.task.title}"`);

  // 1. 拆解：claude 返回 JSON 子任务数组
  const spec = await decompose(parent.task.prompt, parent.task.title);
  if (!spec || spec.length === 0) {
    logger.warn('lead', '拆解返回空，跳过');
    await api(`/api/tasks/${taskId}/status`, {
      method: 'PATCH',
      body: { status: 'failed', error: 'Lead 拆解失败：未生成子任务' },
    });
    process.exit(1);
  }

  // 2. 写入子任务
  logger.info('lead', `生成 ${spec.length} 个子任务`);
  const childIds: string[] = [];
  for (const s of spec) {
    const created = await api<{ task: { id: string } }>('/api/tasks', {
      method: 'POST',
      body: {
        title: s.title,
        prompt: s.prompt,
        parent_id: taskId,
        source: 'api',
        tags: ['subtask', 'lead'],
      },
    });
    childIds.push(created.task.id);
  }

  // 3. 轮询直到所有子任务终态
  const results: { id: string; title: string; status: string; result: string | null; error: string | null }[] = [];
  while (true) {
    await sleep(config.leadPollIntervalMs);
    const pending = [];
    for (const id of childIds) {
      const detail = await api<TaskDetail>(`/api/tasks/${id}`);
      const t = detail.task;
      const existing = results.find((r) => r.id === id);
      if (existing) {
        existing.status = t.status;
        existing.result = t.result;
        existing.error = t.error;
      } else {
        results.push({ id, title: t.title, status: t.status, result: t.result, error: t.error });
      }
      if (!['completed', 'failed', 'superseded'].includes(t.status)) pending.push(id);
    }
    if (pending.length === 0) break;
    logger.info('lead', `等待 ${pending.length} 个子任务完成...`);
  }

  // 4. 汇总：把各子任务结果拼给 claude 生成最终交付
  const summaryInput = results
    .map((r) => `### 子任务: ${r.title}\n状态: ${r.status}\n结果: ${r.result ?? r.error ?? '(无输出)'}`)
    .join('\n\n');
  const final = await summarize(parent.task.prompt, summaryInput);
  const success = results.filter((r) => r.status === 'completed').length;

  await api(`/api/tasks/${taskId}/status`, {
    method: 'PATCH',
    body: {
      status: success === results.length ? 'completed' : 'completed', // 子任务部分失败仍交付总结，成功数注明
      result: `[子任务完成 ${success}/${results.length}]\n\n${final}`,
    },
  });
  logger.info('lead', `父任务完成，成功 ${success}/${results.length}`);

  clearInterval(heartTimer);
  process.exit(0);
}

/** 调 claude 拆解：要求返回 JSON 数组 [{title, prompt}] */
async function decompose(prompt: string, title: string): Promise<SubTaskSpec[] | null> {
  const decomposePrompt = [
    `你是一个任务拆解器。请把下面这个任务拆成 2~5 个可并行执行的子任务。`,
    `每个子任务要有独立的标题和独立的 prompt（能直接交给一个 Worker 执行）。`,
    `只输出一个 JSON 数组，格式：[{"title":"子任务标题","prompt":"子任务执行指令"}]，不要任何其他文字。`,
    ``,
    `父任务标题：${title}`,
    `父任务 prompt：${prompt}`,
  ].join('\n');

  const out = await runAgent(decomposePrompt);
  const spec = tryParseJsonArray(out);
  if (!spec) {
    logger.warn('lead', '无法解析拆解结果 JSON，重试一次原始输出...');
    logger.debug('lead', out.slice(0, 500));
  }
  return spec;
}

/** 调 claude 汇总子任务结果 */
async function summarize(parentPrompt: string, childSummary: string): Promise<string> {
  const summarizePrompt = [
    `你是 Lead。下面是"父任务"及各子任务的执行结果。请整合成一个最终交付。`,
    `要求：开头一句话结论，然后分点给出可用的交付内容；若子任务有失败，说明缺失了什么。`,
    ``,
    `父任务：${parentPrompt.slice(0, 3000)}`,
    ``,
    `各子任务结果：`,
    childSummary,
  ].join('\n');
  return runAgent(summarizePrompt);
}

/** 从 Agent 输出中尽量宽容地解析 JSON 数组 */
function tryParseJsonArray(text: string): SubTaskSpec[] | null {
  try {
    const trimmed = text.trim();
    // 去掉可能的 ```json 围栏
    const cleaned = trimmed
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();
    const arr = JSON.parse(cleaned);
    if (Array.isArray(arr) && arr.length > 0) {
      const valid = arr.filter((x): x is SubTaskSpec =>
        x && typeof x.title === 'string' && typeof x.prompt === 'string' && x.title.trim() && x.prompt.trim());
      if (valid.length > 0) return valid;
    }
  } catch {
    // fallthrough
  }
  return null;
}

/** 调 claude CLI（复用 worker/runner 的跨平台 spawn 封装；prompt 走 stdin） */
function runAgent(prompt: string): Promise<string> {
  return new Promise((resolveP, reject) => {
    const workdir = resolve(process.cwd(), AGENT_WORKDIR);
    mkdirSync(workdir, { recursive: true });
    const child = spawnAgent(['-p', '--output-format', 'text'], { cwd: workdir });
    let out = '';
    let err = '';
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`agent exit ${code}: ${err.slice(0, 300)}`));
      else resolveP(out);
    });
    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  logger.error('lead', `fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
