import { newId, nowIso, query, exec } from '../index.js';
import type { Memory } from '../../shared/types.js';

/** 记忆读写（需求文档 4.4，MySQL 异步版）。embedding 存 LONGBLOB（Float64Array 序列化字节）。 */

export interface CreateMemoryInput {
  content: string;
  embedding?: Float64Array;
  source_task_id?: string | null;
}

export async function createMemory(input: CreateMemoryInput): Promise<Memory> {
  const row: Memory = {
    id: newId(),
    content: input.content,
    embedding: input.embedding ? serializeVector(input.embedding) : null,
    source_task_id: input.source_task_id ?? null,
    useful_score: 0,
    created_at: nowIso(),
  };
  await exec(
    `INSERT INTO memories (id, content, embedding, source_task_id, useful_score, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [row.id, row.content, row.embedding, row.source_task_id, row.useful_score, row.created_at]
  );
  return row;
}

export async function listMemories(limit = 200): Promise<Memory[]> {
  const rows = await query<Memory>(
    `SELECT * FROM memories ORDER BY created_at DESC LIMIT ?`,
    [limit]
  );
  return rows;
}

export async function deleteMemory(id: string): Promise<boolean> {
  const affected = await exec(`DELETE FROM memories WHERE id = ?`, [id]);
  return affected === 1;
}

/** 点赞/点踩反馈（后续检索加权） */
export async function scoreMemory(id: string, delta: number): Promise<Memory | null> {
  await exec(`UPDATE memories SET useful_score = useful_score + ? WHERE id = ?`, [delta, id]);
  const rows = await query<Memory>(`SELECT * FROM memories WHERE id = ?`, [id]);
  return rows[0] ?? null;
}

/** 读取全部带向量的记忆（内存余弦检索，数据量 < 10万条够用） */
export async function allMemoriesWithVector(): Promise<{ id: string; content: string; source_task_id: string | null; useful_score: number; vector: Float64Array }[]> {
  const rows = await query<Memory>(`SELECT * FROM memories WHERE embedding IS NOT NULL`);
  return rows.map((r) => ({
    id: r.id,
    content: r.content,
    source_task_id: r.source_task_id,
    useful_score: Number(r.useful_score),
    vector: deserializeVector(r.embedding!),
  }));
}

/** Float64Array → Uint8Array（存储为 LONGBLOB） */
function serializeVector(v: Float64Array): Uint8Array {
  const buf = Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  return new Uint8Array(buf);
}

/** Buffer/Uint8Array → Float64Array */
function deserializeVector(bytes: Uint8Array): Float64Array {
  const buf = Buffer.from(bytes);
  return new Float64Array(buf.buffer, buf.byteOffset, buf.byteLength / 8);
}
