import { getDb, newId, nowIso } from '../index.js';
import type { Asset } from '../../shared/types.js';

/** 文件资产库读写。文件本体存磁盘 assets/<id>，DB 存元数据。 */

export interface CreateAssetInput {
  filename: string;       // 磁盘存储名
  original_name: string;  // 原始文件名
  size: number;
  mime?: string;
  description?: string;
}

export function createAsset(input: CreateAssetInput): Asset {
  const row: Asset = {
    id: newId(),
    name: input.original_name,
    filename: input.filename,
    original_name: input.original_name,
    size: input.size,
    mime: input.mime ?? null,
    description: input.description ?? null,
    created_at: nowIso(),
  };
  getDb()
    .prepare(
      `INSERT INTO assets (id, name, filename, original_name, size, mime, description, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(row.id, row.name, row.filename, row.original_name, row.size, row.mime, row.description, row.created_at);
  return row;
}

export function listAssets(): Asset[] {
  return getDb().prepare(`SELECT * FROM assets ORDER BY created_at DESC`).all() as unknown as Asset[];
}

export function getAsset(id: string): Asset | null {
  const row = getDb().prepare(`SELECT * FROM assets WHERE id = ?`).get(id);
  return (row as unknown as Asset | undefined) ?? null;
}

export function deleteAsset(id: string): boolean {
  const res = getDb().prepare(`DELETE FROM assets WHERE id = ?`).run(id);
  return res.changes === 1;
}

/** 批量取资产（供 worker 准备任务目录用） */
export function getAssets(ids: string[]): Asset[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return getDb().prepare(`SELECT * FROM assets WHERE id IN (${placeholders})`).all(...ids) as unknown as Asset[];
}
