import type { Task } from '../shared/types.js';
import { searchMemories } from './search.js';

/**
 * 新任务创建时的记忆富化：检索 Top-K 相关经验，拼进 prompt。
 * 只追加在任务创建时；已含 marker 的 prompt 不再追加（防重复）。
 */

const MARKER = '=== 相关经验（来自共享记忆） ===';

export async function enrichPromptWithMemories(task: Task): Promise<string> {
  if (task.prompt.includes(MARKER)) return task.prompt;

  const hits = await searchMemories(task.prompt, 3);
  if (hits.length === 0) return task.prompt;

  const block = [
    '',
    MARKER,
    '以下是之前完成任务时沉淀的可复用经验，请在执行本任务时参考：',
    ...hits.map((h, i) => `${i + 1}. [来源任务 ${h.source_task_id ?? '未知'}] ${h.content.trim()}`),
    '（经验仅供参考，以当前任务的 prompt 为准。）',
    MARKER.replace('===', '=== 结束'),
    '',
  ].join('\n');

  return task.prompt + block;
}
