import { createServer, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { config } from './shared/config.js';
import { logger } from './shared/logger.js';
import { initDb } from './db/index.js';
import { Router, notFound } from './api/router.js';
import { ApiRequest, readJsonBody, requireApiKey, resolveAgent, handleError, sendJson } from './api/middleware.js';
import { tasksHandlers } from './api/handlers/tasks.js';
import { agentsHandlers } from './api/handlers/agents.js';
import { memoriesHandlers } from './api/handlers/memories.js';
import { schedulesHandlers } from './api/handlers/schedules.js';
import { eventsHandlers } from './api/handlers/events.js';
import { statsHandlers } from './api/handlers/stats.js';
import { assetsHandlers } from './api/handlers/assets.js';
import { startSweeper, stopSweeper } from './heartbeat/sweeper.js';
import { startScheduler, stopScheduler } from './scheduler/index.js';
import { initWs, broadcast, stopWs } from './ws/index.js';
import { registerEventHook } from './db/queries/events.js';

function buildRouter(): Router {
  const r = new Router();

  // 健康检查（免鉴权）
  r.get('/api/health', statsHandlers.health);

  // 任务
  r.post('/api/tasks', async (req, res) => { if (!requireApiKey(req, res)) return; await tasksHandlers.create(req, res); });
  r.get('/api/tasks', (req, res) => { if (!requireApiKey(req, res)) return; tasksHandlers.list(req, res); });
  r.get('/api/tasks/:id', (req, res) => { if (!requireApiKey(req, res)) return; tasksHandlers.detail(req, res); });
  r.post('/api/tasks/next', (req, res) => { if (!requireApiKey(req, res)) return; if (!resolveAgent(req, res, true)) return; void tasksHandlers.claimNext(req, res); });
  r.post('/api/tasks/:id/claim', (req, res) => { if (!requireApiKey(req, res)) return; if (!resolveAgent(req, res, true)) return; tasksHandlers.claim(req, res); });
  r.patch('/api/tasks/:id/status', (req, res) => { if (!requireApiKey(req, res)) return; if (!resolveAgent(req, res, true)) return; tasksHandlers.updateStatus(req, res); });

  // Agent
  r.post('/api/agents/register', (req, res) => { if (!requireApiKey(req, res)) return; agentsHandlers.register(req, res); });
  r.post('/api/agents/:id/heartbeat', (req, res) => { if (!requireApiKey(req, res)) return; agentsHandlers.heartbeat(req, res); });
  r.get('/api/agents', (req, res) => { if (!requireApiKey(req, res)) return; agentsHandlers.list(req, res); });
  r.get('/api/agents/:id', (req, res) => { if (!requireApiKey(req, res)) return; agentsHandlers.detail(req, res); });
  r.post('/api/agents/:id/release', (req, res) => { if (!requireApiKey(req, res)) return; agentsHandlers.release(req, res); });

  // 记忆
  r.post('/api/memories', async (req, res) => { if (!requireApiKey(req, res)) return; await memoriesHandlers.create(req, res); });
  r.get('/api/memories', (req, res) => { if (!requireApiKey(req, res)) return; memoriesHandlers.list(req, res); });
  r.get('/api/memories/search', async (req, res) => { if (!requireApiKey(req, res)) return; await memoriesHandlers.search(req, res); });
  r.del('/api/memories/:id', (req, res) => { if (!requireApiKey(req, res)) return; memoriesHandlers.del(req, res); });
  r.patch('/api/memories/:id', (req, res) => { if (!requireApiKey(req, res)) return; memoriesHandlers.patch(req, res); });

  // 定时任务
  r.post('/api/schedules', (req, res) => { if (!requireApiKey(req, res)) return; schedulesHandlers.create(req, res); });
  r.get('/api/schedules', (req, res) => { if (!requireApiKey(req, res)) return; schedulesHandlers.list(req, res); });
  r.get('/api/schedules/:id', (req, res) => { if (!requireApiKey(req, res)) return; schedulesHandlers.detail(req, res); });
  r.patch('/api/schedules/:id', (req, res) => { if (!requireApiKey(req, res)) return; schedulesHandlers.patch(req, res); });
  r.del('/api/schedules/:id', (req, res) => { if (!requireApiKey(req, res)) return; schedulesHandlers.del(req, res); });

  // 事件 / 统计
  r.get('/api/events', (req, res) => { if (!requireApiKey(req, res)) return; eventsHandlers.list(req, res); });
  r.get('/api/stats', (req, res) => { if (!requireApiKey(req, res)) return; statsHandlers.get(req, res); });

  // 资产库
  r.post('/api/assets', async (req, res) => { if (!requireApiKey(req, res)) return; await assetsHandlers.upload(req, res); });
  r.get('/api/assets', (req, res) => { if (!requireApiKey(req, res)) return; assetsHandlers.list(req, res); });
  r.get('/api/assets/:id', (req, res) => { if (!requireApiKey(req, res)) return; assetsHandlers.download(req, res); });
  r.get('/api/assets/:id/meta', (req, res) => { if (!requireApiKey(req, res)) return; assetsHandlers.meta(req, res); });
  r.del('/api/assets/:id', (req, res) => { if (!requireApiKey(req, res)) return; assetsHandlers.del(req, res); });

  return r;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/** 静态托管 ui/ 看板 */
function serveStatic(pathname: string, res: ServerResponse): boolean {
  if (!pathname.startsWith('/') || pathname.startsWith('/api') || pathname.startsWith('/ws')) return false;
  const uiDir = resolve(import.meta.dirname, 'ui');
  let rel = pathname === '/' ? '/index.html' : pathname;
  const file = resolve(uiDir, rel.slice(1));
  if (!file.startsWith(uiDir) || !existsSync(file)) {
    // 找不到则回退 index.html（SPA 式）
    const index = resolve(uiDir, 'index.html');
    if (!existsSync(index)) return false;
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(readFileSync(index));
    return true;
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
  return true;
}

export function createAppServer() {
  initDb();
  const router = buildRouter();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const method = req.method ?? 'GET';

    // WS 升级走 ws 服务器
    if (url.pathname === '/ws' || url.pathname.startsWith('/ws/')) return;

    // 静态看板（无需鉴权）
    if (serveStatic(url.pathname, res)) return;

    const match = router.match(method, url.pathname);
    if (!match) return notFound(res);

    const apiReq = req as ApiRequest;
    apiReq.params = match.params;
    apiReq.query = url.searchParams;
    try {
      // 资产上传 body 是原始二进制/CSV，不走 JSON 解析（handler 自己读 raw）
      const isAssetUpload = method === 'POST' && url.pathname === '/api/assets';
      if (['POST', 'PATCH', 'PUT'].includes(method) && !isAssetUpload) {
        apiReq.body = await readJsonBody(req);
      }
      await match.handler(apiReq, res);
    } catch (err) {
      handleError(res, err, 'api');
    }
  });

  return server;
}

async function main() {
  initDb();
  const server = createAppServer();

  // WS 事件推送：事件落库即广播（DB 与实时流单一事实来源）
  const wss = initWs(server);
  registerEventHook((event) => broadcast(JSON.stringify({ type: 'event', event })));
  logger.info('server', 'ws event hook registered');

  // 后台任务：心跳清扫 + 定时调度
  startSweeper();
  startScheduler();

  server.listen(config.port, () => {
    logger.info('server', `API listening on http://localhost:${config.port}`);
    logger.info('server', `dashboard at http://localhost:${config.port}/`);
  });

  const shutdown = (signal: string) => {
    logger.info('server', `received ${signal}, shutting down`);
    stopSweeper();
    stopScheduler();
    stopWs(wss);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// 直接被测试 import 时不启动；命令行运行时启动
if (import.meta.main) {
  main().catch((err) => {
    logger.error('server', `fatal: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
