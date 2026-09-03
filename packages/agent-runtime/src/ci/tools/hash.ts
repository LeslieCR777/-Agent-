import { createHash } from 'node:crypto';

/** 页面内容 SHA-256（三级检测第一级：哈希快筛的比对键） */
export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
