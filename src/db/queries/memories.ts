import { getDb, newId, nowIso } from '../index.js';
import type { Memory } from '../../shared/types.js';

/** 记忆读写（需求文档 4.4）。embedding 存 BLOB（Float64Array 序列化字节）。 */

export interface CreateMemoryInput {
  content: string;
  embedding?: Float64Array;
  source_task_id?: string | null;
}

export function createMemory(input: CreateMemoryInput): Memory {
  const row: Memory = {
    id: newId(),
    content: input.content,
    embedding: input.embedding ? serializeVector(input.embedding) : null,
    source_task_id: input.source_task_id ?? null,
    useful_score: 0,
    created_at: nowIso(),
  };
  getDb()
    .prepare(
      `INSERT INTO memories (id, content, embedding, source_task_id, useful_score, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(row.id, row.content, row.embedding, row.source_task_id, row.useful_score, row.created_at);
  return row;
}

export function listMemories(limit = 200): Memory[] {
  return getDb()
    .prepare(`SELECT * FROM memories ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as unknown as Memory[];
}

export function deleteMemory(id: string): boolean {
  const res = getDb().prepare(`DELETE FROM memories WHERE id = ?`).run(id);
  return res.changes === 1;
}

/** 点赞/点踩反馈（后续检索加权） */
export function scoreMemory(id: string, delta: number): Memory | null {
  const d = getDb();
  d.prepare(`UPDATE memories SET useful_score = useful_score + ? WHERE id = ?`).run(delta, id);
  const row = d.prepare(`SELECT * FROM memories WHERE id = ?`).get(id);
  return (row as unknown as Memory | undefined) ?? null;
}

/** 读取全部带向量的记忆（内存余弦检索，数据量 < 10万条够用） */
export function allMemoriesWithVector(): { id: string; content: string; source_task_id: string | null; useful_score: number; vector: Float64Array }[] {
  const rows = getDb().prepare(`SELECT * FROM memories WHERE embedding IS NOT NULL`).all() as unknown as Memory[];
  return rows.map((r) => ({
    id: r.id,
    content: r.content,
    source_task_id: r.source_task_id,
    useful_score: r.useful_score,
    vector: deserializeVector(r.embedding!),
  }));
}

/** Float64Array → Buffer（存储） */
function serializeVector(v: Float64Array): Uint8Array {
  const buf = Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  return new Uint8Array(buf);
}

/** Buffer → Float64Array */
function deserializeVector(bytes: Uint8Array): Float64Array {
  const buf = Buffer.from(bytes);
  return new Float64Array(buf.buffer, buf.byteOffset, buf.byteLength / 8);
}
