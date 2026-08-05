import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';

/**
 * 评审 Agent（DeepSeek API，OpenAI 兼容接口）。
 * 与 claude CLI 不同：评审走 HTTP 直连 DeepSeek，不依赖本地 CLI。
 * 多 agent 测评 = 3 个不同视角的评审 prompt 并行调用 DeepSeek，聚合投票。
 */

export interface JudgeVote {
  role: string;
  score: number;      // 1-10
  feedback: string;
}

/** 评审角色（多视角，避免单一评审偏见） */
export const JUDGE_ROLES = [
  { key: 'accuracy', label: '准确性评审' },
  { key: 'completeness', label: '完整性评审' },
  { key: 'actionable', label: '销售可用性评审' },
] as const;

/** 单次评审：调用 DeepSeek（OpenAI 兼容 chat/completions） */
/** 判官调用轨迹（评估框架用） */
export interface JudgeTrace {
  role: string;
  prompt: string;
  response: string;
  durationMs: number;
  model: string;
}

export async function judgeWithDeepSeek(role: string, prompt: string, onTrace?: (t: JudgeTrace) => void): Promise<string> {
  if (!config.deepseek.apiKey) {
    throw new Error('DEEPSEEK_API_KEY not configured');
  }
  const startedAt = Date.now();
  const res = await fetch(`${config.deepseek.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.deepseek.apiKey}`,
    },
    body: JSON.stringify({
      model: config.deepseek.model,
      temperature: 0.2, // 评审要稳定，低温
      messages: [
        { role: 'system', content: `你是竞品情报系统的${role}评审员。只输出 JSON，不要任何其他文字。` },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status}`);
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('DeepSeek returned empty response');
  // Golden Trace：有 sink 才 emit
  onTrace?.({
    role,
    prompt: prompt.slice(0, 2000),
    response: content.slice(0, 4000),
    durationMs: Date.now() - startedAt,
    model: config.deepseek.model,
  });
  return content;
}

/**
 * 三评审投票聚合：
 * - score = round(三均值)，钳制到 1-10（防极端值污染）
 * - passed = score >= 阈值（多数票通过 = 均值过线）
 * - feedback = 三 feedback 拼接（回 research 重搜时全部带上）
 */
export function aggregateVotes(votes: JudgeVote[]): { score: number; feedback: string } {
  if (votes.length === 0) return { score: 0, feedback: '无评审结果' };
  const raw = votes.reduce((a, v) => a + v.score, 0) / votes.length;
  const score = Math.max(1, Math.min(10, Math.round(raw)));
  const feedback = votes
    .map((v) => `[${v.role}] ${v.feedback}`)
    .join('\n')
    .slice(0, 3000);
  return { score, feedback };
}

/** demo 模式下的评审投票桩（无 key 也能跑通 quality 阶段） */
export function demoJudgeVotes(): JudgeVote[] {
  return JUDGE_ROLES.map((r) => ({
    role: r.label,
    score: 8,
    feedback: `demo 数据：${r.label} 通过，战卡结构完整、基于给定数据、可直接用于销售场景。`,
  }));
}
