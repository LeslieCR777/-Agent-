import { logger } from '@platform/logger.js';
import { runAgent as runModelAgent } from '@runtime/runner.js';
import { embedTexts } from '@api/memory/embed.js';
import { createMemory } from '@api/db/queries/memories.js';

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

/** 通过统一 runner 调用 Claude 原生 Messages API。 */
async function runAgent(prompt: string): Promise<string> {
  const result = await runModelAgent(prompt);
  if (result.exitCode !== 0) {
    throw new Error(result.errorOutput || `Claude API failed (${result.exitCode})`);
  }
  return result.output;
}
