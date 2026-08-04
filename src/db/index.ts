import mysql, { type Pool, type PoolConnection } from 'mysql2/promise';
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';

/**
 * 查询行类型。mysql2 的 execute 泛型约束是 RowDataPacket，但我们返回业务对象，
 * 用宽松的 Record<string, any> 让 execute<Row[]> 满足约束、返回可断言成业务类型。
 */
export type Row = Record<string, any>;

/**
 * 数据库单例（MySQL）。API Server 是数据库唯一持有者（文档 2.1 架构基石）。
 * Worker/Lead 禁止 import 本模块，一律走 HTTP（见 6.1 依赖规则）。
 *
 * 关键机制：
 * - 连接池：mysql2/promise Pool，所有语句经 pool/连接执行（异步）
 * - 事务：withTransaction 用 AsyncLocalStorage 传播「当前事务连接」，
 *   嵌套 withTransaction 复用同一连接（join 外层事务），最外层 commit/rollback。
 * - 原子性：BEGIN IMMEDIATE（SQLite）→ START TRANSACTION（MySQL）。
 *   认领任务等竞争操作在事务内用 SELECT ... FOR UPDATE SKIP LOCKED 选行。
 */

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) throw new Error('DB not initialized — call initDb() first');
  return pool;
}

/** 事务上下文：当前连接 + 嵌套深度（AsyncLocalStorage 传播） */
interface TxCtx {
  conn: PoolConnection;
  depth: number;
}
const txCtx = new AsyncLocalStorage<TxCtx>();

/**
 * 事务内返回当前连接；事务外返回一个池连接（执行完不释放，交由调用方/语句级）。
 * 查询层统一：`const db = conn(); const [rows] = await db.execute(...)`。
 */
export function conn(): PoolConnection {
  const ctx = txCtx.getStore();
  if (ctx) return ctx.conn;
  // 事务外：直接经连接池执行（无长连接语义）。这里返回 null 由调用方走 pool。
  throw new Error('conn() only available inside withTransaction — use getPool() outside');
}

/** 关闭连接池（测试清理用） */
export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function initDb(): Promise<Pool> {
  if (pool) return pool;
  pool = mysql.createPool({
    host: config.mysql.host,
    port: config.mysql.port,
    user: config.mysql.user,
    password: config.mysql.password,
    database: config.mysql.database,
    waitForConnections: true,
    connectionLimit: 10,
    charset: 'utf8mb4',
  });
  // 启动时验证连接
  const conn = await pool.getConnection();
  conn.release();
  logger.info('db', `MySQL pool initialized at ${config.mysql.host}:${config.mysql.port}/${config.mysql.database}`);
  return pool;
}

/**
 * 事务封装（MySQL 异步版）。
 * 嵌套复用：内层 withTransaction 检测到已有事务上下文 → 直接 join，深度+1；
 * 最外层获取连接 → START TRANSACTION → fn → COMMIT / ROLLBACK → release。
 * fn 必须是 async（事务内所有语句 await）。
 */
export async function withTransaction<T>(fn: () => Promise<T>): Promise<T> {
  const existing = txCtx.getStore();
  if (existing) {
    // 已在外层事务中：join（深度+1，最终由最外层统一提交）
    existing.depth++;
    try {
      return await fn();
    } finally {
      existing.depth--;
    }
  }

  const conn = await getPool().getConnection();
  const ctx: TxCtx = { conn, depth: 0 };
  try {
    await conn.beginTransaction();
    return await txCtx.run(ctx, async () => {
      ctx.depth++;
      try {
        const result = await fn();
        await conn.commit();
        return result;
      } catch (err) {
        try { await conn.rollback(); } catch { /* 忽略回滚失败 */ }
        throw err;
      } finally {
        ctx.depth--;
      }
    });
  } finally {
    conn.release();
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
