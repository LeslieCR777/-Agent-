import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { AGENT_WORKDIR } from '../shared/constants.js';
import { spawnAgent, agentArgs } from '../worker/runner.js';
import { embedTexts } from './embed.js';
import { createMemory } from '../db/queries/memories.js';

/**
 * 经验沉淀（需求文档 FR-5）：任务完成后，用 Agent 从执行输出中
 * 提炼"可复用经验" → 向量化 → 入库。
 * 异步执行、失败不影响主流程（文档 4.7 记忆独立写）。
 */

export async function distillTaskExperience(input: {
  taskId: string;
  taskTitle: string;
  taskPrompt: string;
  output: string;
  result: string | null;
}): Promise<void> {
  const { taskId, taskTitle, output, result } = input;
  try {
    const snippet = [output.slice(0, 6000), result ? `\n--- 最终结果 ---\n${result.slice(0, 3000)}` : ''].join('\n');
    if (!snippet.trim()) return;

    const extractPrompt = [
      `你是经验沉淀员。下面是一次 AI 任务（标题：${taskTitle}）的执行过程与结果。`,
      '请提炼出 1~3 条【可复用的经验】——即下次做相似任务时能直接借鉴的要点、坑、方法、模式。',
      '不要复述过程，只给结论性、可操作的经验。',
      '输出纯文本，每条经验独立成段，不要编号以外的修饰。',
      '',
      '=== 执行过程 ===',
      snippet,
    ].join('\n');

    const extracted = await runAgent(extractPrompt);
    if (!extracted.trim()) return;

    const [vector] = await embedTexts([extracted]);
    const memory = await createMemory({
      content: extracted.trim().slice(0, 2000),
      embedding: vector,
      source_task_id: taskId,
    });
    logger.info('distill', `saved memory=${memory.id.slice(0, 8)} for task=${taskId.slice(0, 8)}`);
  } catch (err) {
    // 提炼失败不影响主流程
    logger.warn('distill', `distill failed for task=${taskId}: ${err instanceof Error ? err.message : err}`);
  }
}

/** 调用 Agent 子进程（复用 worker/runner 的跨平台 spawn 封装） */
function runAgent(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const workdir = resolveWorkspace();
    mkdirSync(workdir, { recursive: true });
    const child = spawnAgent(agentArgs(), { cwd: workdir });
    let out = '';
    let err = '';
    child.stdout?.on('data', (d) => (out += d.toString()));
    child.stderr?.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`agent exit ${code}: ${err.slice(0, 300)}`));
      } else {
        resolve(out);
      }
    });
    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}

function resolveWorkspace(): string {
  return resolve(process.cwd(), AGENT_WORKDIR);
}
