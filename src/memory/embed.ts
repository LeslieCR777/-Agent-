import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';

/**
 * Embedding 接口（需求文档 FR-5）。
 * 优先用 OpenAI Embedding API（用户有 Key 时走真向量）；
 * 无 Key 时降级为字符 n-gram 哈希向量，保证系统离线可跑、可测试。
 */

export const EMBEDDING_DIM = 256;
/** base URL 可通过 EMBEDDING_BASE_URL 配置（兼容 api.openai-proxy.org 等代理端点） */
function apiUrl(): string {
  const base = config.embeddingBaseUrl.replace(/\/+$/, '');
  return `${base}/v1/embeddings`;
}

export function hasRemoteEmbedding(): boolean {
  return Boolean(config.embeddingApiKey);
}

/** 批量文本 → 向量数组。失败抛错由调用方降级。 */
export async function embedTexts(texts: string[]): Promise<Float64Array[]> {
  const clean = texts.map((t) => t.slice(0, 8000));
  if (config.embeddingApiKey) {
    try {
      return await embedRemote(clean);
    } catch (err) {
      logger.warn('embed', `remote embedding failed, falling back to local hash: ${err instanceof Error ? err.message : err}`);
    }
  }
  return clean.map(localHashEmbed);
}

async function embedRemote(texts: string[]): Promise<Float64Array[]> {
  const res = await fetch(apiUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.embeddingApiKey}`,
    },
    body: JSON.stringify({ model: config.embeddingModel, input: texts }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenAI embeddings HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { data: { embedding: number[] }[] };
  return data.data.map((d) => Float64Array.from(d.embedding));
}

/** 无 Key 时的离线哈希向量：n-gram 特征 + 随机投影（无需预训练） */
function localHashEmbed(text: string): Float64Array {
  const vec = new Float64Array(EMBEDDING_DIM);
  const grams = new Set<string>();
  const t = text.toLowerCase();

  // 字符 bigram + 英文 token
  for (let i = 0; i < t.length - 1; i++) {
    grams.add(t.slice(i, i + 2));
  }
  for (const tok of t.split(/[^\p{L}\p{N}]+/u)) {
    if (tok.length > 1) grams.add(`w:${tok}`);
  }

  for (const g of grams) {
    const h1 = fnv1a(g);
    const h2 = fnv1a(g + ':salt');
    // 用两个哈希索引 + 确定性伪随机符号，近似随机投影
    const idx = h1 % EMBEDDING_DIM;
    vec[idx] += (h2 & 1) === 1 ? 1 : -1;
  }
  return vec;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
