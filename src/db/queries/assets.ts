import { newId, nowIso, query, exec } from '../index.js';
import type { Asset } from '../../shared/types.js';

/** 文件资产库读写（MySQL 异步版）。文件本体存磁盘 assets/<id>，DB 存元数据。 */

export interface CreateAssetInput {
  filename: string;       // 磁盘存储名
  original_name: string;  // 原始文件名
  size: number;
  mime?: string;
  description?: string;
}

export async function createAsset(input: CreateAssetInput): Promise<Asset> {
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
  await exec(
    `INSERT INTO assets (id, name, filename, original_name, size, mime, description, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.name, row.filename, row.original_name, row.size, row.mime, row.description, row.created_at]
  );
  return row;
}

export async function listAssets(): Promise<Asset[]> {
  const rows = await query<Asset>(`SELECT * FROM assets ORDER BY created_at DESC`);
  return rows;
}

export async function getAsset(id: string): Promise<Asset | null> {
  const rows = await query<Asset>(`SELECT * FROM assets WHERE id = ?`, [id]);
  return rows[0] ?? null;
}

export async function deleteAsset(id: string): Promise<boolean> {
  const affected = await exec(`DELETE FROM assets WHERE id = ?`, [id]);
  return affected === 1;
}

/** 批量取资产（供 worker 准备任务目录用） */
export async function getAssets(ids: string[]): Promise<Asset[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = await query<Asset>(`SELECT * FROM assets WHERE id IN (${placeholders})`, ids);
  return rows;
}
