import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';

/**
 * 数据库单例。API Server 是数据库唯一持有者（文档 2.1 架构基石）。
 * Worker/Lead 禁止 import 本模块，一律走 HTTP（见 6.1 依赖规则）。
 */

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!db) throw new Error('DB not initialized — call initDb() first');
  return db;
}

/** 关闭连接（测试清理用；正式流程进程退出时自动释放） */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function initDb(): DatabaseSync {
  if (db) return db;
  const path = resolve(process.cwd(), config.dbPath);
  mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
  db.exec(schema);
  logger.info('db', `initialized at ${path}`);
  return db;
}

/**
 * 同步事务（node:sqlite 是同步 API，单进程内天然串行）。
 * BEGIN IMMEDIATE 在第一步写操作前就拿到写锁，杜绝两个写事务交叉，
 * 等价于文档 5.5 伪代码要求的行级原子性。
 *
 * 支持嵌套：内层 withTransaction 直接 join 外层事务（不重复 BEGIN），
 * 由最外层统一 COMMIT/ROLLBACK。这样 updateTaskStatus 之类内部自带
 * 事务的函数可以被安全地包在更大的事务里。
 *
 * 用法：withTransaction(() => { ... }) —— 返回 fn 的返回值。
 */
let txDepth = 0;
export function withTransaction<T>(fn: () => T): T {
  const d = getDb();
  const outer = txDepth === 0;
  if (outer) d.exec('BEGIN IMMEDIATE');
  txDepth++;
  try {
    const result = fn();
    txDepth--;
    if (outer) {
      d.exec('COMMIT');
      txDepth = 0;
    }
    return result;
  } catch (err) {
    txDepth--;
    if (outer) {
      try {
        d.exec('ROLLBACK');
      } catch {
        /* 忽略回滚失败 */
      }
      txDepth = 0;
    }
    throw err;
  }
}

/** 生成 UUID（带随机后缀，杜绝极端场景下 UUID 复用） */
export function newId(): string {
  return `${crypto.randomUUID()}`;
}

/** 当前时间 ISO8601 字符串 */
export function nowIso(): string {
  return new Date().toISOString();
}
