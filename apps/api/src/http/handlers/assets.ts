import type { ServerResponse } from 'node:http';
import type { ApiRequest } from '../middleware.js';
import { sendJson, HttpError } from '../middleware.js';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync, readdirSync, rmdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createAsset, listAssets, getAsset, deleteAsset } from '@api/db/queries/assets.js';

/**
 * 文件资产库 API：
 *  - POST  /api/assets         上传文件（multipart 或原始 body）
 *  - GET   /api/assets         列表
 *  - GET   /api/assets/:id     下载
 *  - GET   /api/assets/:id/meta 元数据
 *  - DELETE /api/assets/:id    删除
 *
 * 文件本体存 <cwd>/assets/<id>/<filename>，DB 存元数据。
 * Worker 通过任务 attachments 引用资产，执行时拷入任务工作目录。
 */

const ASSET_DIR = resolve(process.cwd(), 'assets');
const MAX_SIZE = 50 * 1024 * 1024; // 50MB

function ensureDir(): void {
  mkdirSync(ASSET_DIR, { recursive: true });
}

function assetPath(id: string, filename: string): string {
  return resolve(ASSET_DIR, id, filename);
}

export const assetsHandlers = {
  /** POST /api/assets 上传。Content-Type 非 multipart 时把 body 当原始文件内容。 */
  async upload(req: ApiRequest, res: ServerResponse): Promise<void> {
    ensureDir();
    const contentType = req.headers['content-type'] ?? '';
    let filename = 'asset.bin';
    // 支持简单格式：文件名经 query 或 Content-Disposition 传入
    const disp = req.headers['content-disposition'];
    if (disp && /filename=/.test(disp)) {
      const m = disp.match(/filename="?([^";]+)"?/i);
      if (m) filename = m[1];
    }
    const qName = req.query?.get('filename');
    if (qName) filename = qName;

    // 读原始 body（非 JSON）
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > MAX_SIZE) throw new HttpError(413, 'file too large');
      chunks.push(buf);
    }
    const data = Buffer.concat(chunks);
    if (data.length === 0) throw new HttpError(400, 'empty file');

    const safeName = sanitizeFilename(filename);
    const description = typeof req.query?.get('description') === 'string' ? req.query.get('description')! : undefined;
    // 先落库拿到稳定 id，再用同一 id 作为磁盘目录名（保证下载路径一致）
    const asset = await createAsset({
      filename: safeName,
      original_name: filename,
      size: data.length,
      mime: contentType.split(';')[0] || undefined,
      description,
    });
    const dir = resolve(ASSET_DIR, asset.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(assetPath(asset.id, safeName), data);
    sendJson(res, 201, { asset });
  },

  /** GET /api/assets 列表（不暴露 filename 内部字段细节） */
  async list(_req: ApiRequest, res: ServerResponse): Promise<void> {
    const assets = (await listAssets()).map(({ filename: _f, ...rest }) => rest);
    sendJson(res, 200, { assets });
  },

  /** GET /api/assets/:id/meta */
  async meta(req: ApiRequest, res: ServerResponse): Promise<void> {
    const asset = await getAsset(req.params!.id);
    if (!asset) throw new HttpError(404, 'NOT_FOUND');
    sendJson(res, 200, { asset });
  },

  /** GET /api/assets/:id 下载文件本体 */
  async download(req: ApiRequest, res: ServerResponse): Promise<void> {
    const asset = await getAsset(req.params!.id);
    if (!asset) throw new HttpError(404, 'NOT_FOUND');
    const file = assetPath(asset.id, asset.filename);
    if (!existsSync(file)) throw new HttpError(404, 'FILE_MISSING');
    const data = readFileSync(file);
    res.writeHead(200, {
      'Content-Type': asset.mime ?? 'application/octet-stream',
      'Content-Length': data.length,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(asset.original_name)}"`,
    });
    res.end(data);
  },

  /** DELETE /api/assets/:id */
  async del(req: ApiRequest, res: ServerResponse): Promise<void> {
    const asset = await getAsset(req.params!.id);
    if (!asset) throw new HttpError(404, 'NOT_FOUND');
    const dir = resolve(ASSET_DIR, asset.id);
    if (existsSync(dir)) {
      // 清掉整个资产目录（含文件）
      for (const f of readdirSync(dir)) unlinkSync(resolve(dir, f));
      rmdirSync(dir);
    }
    await deleteAsset(asset.id);
    sendJson(res, 200, { ok: true });
  },
};

/** 去掉路径穿越/非法字符 */
function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'asset.bin';
  return base.replace(/[^\w.\-()一-鿿\s]/g, '_') || 'asset.bin';
}
