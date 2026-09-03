import type { ServerResponse } from 'node:http';
import type { ApiRequest } from '../middleware.js';
import { sendJson, HttpError } from '../middleware.js';
import {
  createMemory,
  listMemories,
  deleteMemory,
  scoreMemory,
} from '@api/db/queries/memories.js';
import { searchMemories, type SearchHit } from '@api/memory/search.js';
import { embedTexts } from '@api/memory/embed.js';
import { logger } from '@platform/logger.js';

export const memoriesHandlers = {
  /** POST /api/memories 写入记忆（内部沉淀）。无 embedding 时现场向量化。 */
  async create(req: ApiRequest, res: ServerResponse): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const content = typeof body.content === 'string' && body.content.trim() ? body.content.trim() : null;
    if (!content) throw new HttpError(400, 'content is required');

    let vector: Float64Array | undefined;
    try {
      const [emb] = await embedTexts([content]);
      vector = emb;
    } catch (err) {
      logger.warn('memories', `embedding failed, storing without vector: ${err instanceof Error ? err.message : err}`);
    }

    const mem = await createMemory({
      content,
      embedding: vector,
      source_task_id: typeof body.source_task_id === 'string' ? body.source_task_id : null,
    });
    // 不把 embedding 原始字节暴露给客户端
    const { embedding: _emb, ...safe } = mem;
    sendJson(res, 201, { memory: safe });
  },

  /** GET /api/memories 全部记忆（剥离 embedding） */
  async list(_req: ApiRequest, res: ServerResponse): Promise<void> {
    const memories = (await listMemories()).map(({ embedding: _emb, ...safe }) => safe);
    sendJson(res, 200, { memories });
  },

  /** GET /api/memories/search?q=&topK= 语义检索 Top-K */
  async search(req: ApiRequest, res: ServerResponse): Promise<void> {
    const q = req.query!.get('q')?.trim() ?? '';
    if (!q) throw new HttpError(400, 'q is required');
    const topK = Math.min(Number(req.query!.get('topK') ?? 5) || 5, 20);
    let hits: SearchHit[];
    try {
      hits = await searchMemories(q, topK);
    } catch (err) {
      logger.warn('memories', `search embedding failed, falling back to keyword: ${err instanceof Error ? err.message : err}`);
      hits = await keywordFallback(q, topK);
    }
    sendJson(res, 200, { results: hits.map((h) => ({
      id: h.id,
      content: h.content,
      source_task_id: h.source_task_id,
      useful_score: h.useful_score,
      score: Number(h.score.toFixed(4)),
    })) });
  },

  /** DELETE /api/memories/:id */
  async del(req: ApiRequest, res: ServerResponse): Promise<void> {
    const ok = await deleteMemory(req.params!.id);
    if (!ok) throw new HttpError(404, 'NOT_FOUND');
    sendJson(res, 200, { ok: true });
  },

  /** PATCH /api/memories/:id 点赞/点踩反馈 */
  async patch(req: ApiRequest, res: ServerResponse): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const delta = Number(body.delta ?? body.useful ?? 0);
    if (!Number.isFinite(delta)) throw new HttpError(400, 'delta must be a number');
    const mem = await scoreMemory(req.params!.id, delta);
    if (!mem) throw new HttpError(404, 'NOT_FOUND');
    sendJson(res, 200, { memory: mem });
  },
};

/** 无语义向量时（离线降级）的关键字兜底检索：TF-IDF 词重叠 */
async function keywordFallback(q: string, topK: number): Promise<SearchHit[]> {
  const memories = await listMemories();
  const qTerms = tokenize(q);
  if (qTerms.length === 0) return [];
  const scored = memories.map((m) => {
    const mTerms = tokenize(m.content);
    if (mTerms.length === 0) return null;
    const mSet = new Set(mTerms);
    const overlap = qTerms.filter((t) => mSet.has(t)).length;
    const score = overlap / Math.sqrt(qTerms.length * mTerms.length); // 余弦式归一
    return { id: m.id, content: m.content, source_task_id: m.source_task_id, useful_score: m.useful_score, score };
  }).filter((x): x is NonNullable<typeof x> => x !== null && x.score > 0);
  return scored.sort((a, b) => b.score - a.score).slice(0, topK);
}

function tokenize(s: string): string[] {
  // 中文按字拆，英文按词拆——宽泛匹配足够离线兜底
  return s.toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter(Boolean)
    .flatMap((w) => /[一-鿿]/.test(w) ? [...w] : [w]);
}
