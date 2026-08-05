import { newId, nowIso, query, exec } from '../index.js';

/** 我方产品画像（用户自行注册，看板可编辑）。空表时由 handler 回退 .env 默认。 */

export interface OurProfile {
  id: string;
  name: string;
  website: string | null;
  positioning: string | null;
  target_market: string | null;
  updated_at: string;
}

export interface OurProfileInput {
  name: string;
  website?: string;
  positioning?: string;
  target_market?: string;
}

export async function getProfile(): Promise<OurProfile | null> {
  const rows = await query<OurProfile>(`SELECT * FROM our_profile ORDER BY updated_at DESC LIMIT 1`);
  return rows[0] ?? null;
}

/** 保存（每次覆盖，单行语义）。返回最新画像。 */
export async function saveProfile(input: OurProfileInput): Promise<OurProfile> {
  // 先清空旧数据（单行表），再插入新行 —— 保证 getProfile 取到最新
  await exec(`DELETE FROM our_profile`);
  const row: OurProfile = {
    id: newId(),
    name: input.name,
    website: input.website ?? null,
    positioning: input.positioning ?? null,
    target_market: input.target_market ?? null,
    updated_at: nowIso(),
  };
  await exec(
    `INSERT INTO our_profile (id, name, website, positioning, target_market, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [row.id, row.name, row.website, row.positioning, row.target_market, row.updated_at]
  );
  return row;
}
