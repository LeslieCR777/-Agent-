import { allMemoriesWithVector } from '../db/queries/memories.js';
import { embedTexts } from './embed.js';

/**
 * 向量余弦相似度检索（需求文档 FR-5）。
 * 数据量小，全表内存扫描足够；规模化再换 sqlite-vec。
 */

export interface SearchHit {
  id: string;
  content: string;
  source_task_id: string | null;
  useful_score: number;
  score: number;
}

export async function searchMemories(query: string, topK: number): Promise<SearchHit[]> {
  const [qVec] = await embedTexts([query]);
  const memories = allMemoriesWithVector();
  if (memories.length === 0) return [];

  const hits = memories.map((m) => ({
    id: m.id,
    content: m.content,
    source_task_id: m.source_task_id,
    useful_score: m.useful_score,
    score: cosine(qVec, m.vector),
  }));

  return hits
    .filter((h) => h.score > 0.05) // 阈值：太不相关的不要
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

export function cosine(a: Float64Array, b: Float64Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
