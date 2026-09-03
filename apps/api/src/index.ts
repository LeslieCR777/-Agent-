import { createServer, type ServerResponse } from 'node:http';
import { config } from '@platform/config.js';
import { logger } from '@platform/logger.js';
import { initDb } from '@api/db/index.js';
import { Router, notFound } from './http/router.js';
import { ApiRequest, readJsonBody, requireApiKey, requireServiceScope, resolveAgent, handleError, sendJson } from './http/middleware.js';
import { tasksHandlers } from './http/handlers/tasks.js';
import { agentsHandlers } from './http/handlers/agents.js';
import { memoriesHandlers } from './http/handlers/memories.js';
import { schedulesHandlers } from './http/handlers/schedules.js';
import { eventsHandlers } from './http/handlers/events.js';
import { statsHandlers } from './http/handlers/stats.js';
import { assetsHandlers } from './http/handlers/assets.js';
import { initWs, broadcast, stopWs } from './ws/index.js';
import { registerEventHook } from '@api/db/queries/events.js';
import { competitorsHandlers } from './http/handlers/competitors.js';
import { ciHandlers } from './http/handlers/ci.js';
import { analysisHandlers } from './http/handlers/analysis.js';
import { authHandlers } from './http/handlers/auth.js';
import { ensureBootstrapAdmin } from './auth/index.js';
import { projectsHandlers } from './http/handlers/projects.js';

function buildRouter(): Router {
  const r = new Router();
  const worker = (scope: string, handler: (req: ApiRequest, res: ServerResponse) => Promise<void> | void) =>
    async (req: ApiRequest, res: ServerResponse) => {
      if (!await requireServiceScope(req, res, scope)) return;
      if (!await resolveAgent(req, res, true)) return;
      await handler(req, res);
    };

  // 健康检查（免鉴权）
  r.get('/api/health', statsHandlers.health);
  r.post('/api/auth/login', authHandlers.login);

  // 任务
  r.post('/api/tasks', async (req, res) => { if (!requireApiKey(req, res)) return; await tasksHandlers.create(req, res); });
  r.get('/api/tasks', (req, res) => { if (!requireApiKey(req, res)) return; tasksHandlers.list(req, res); });
  r.get('/api/tasks/:id', (req, res) => { if (!requireApiKey(req, res)) return; tasksHandlers.detail(req, res); });
  r.post('/api/tasks/next', worker('tasks:claim', tasksHandlers.claimNext));
  r.post('/api/tasks/:id/claim', worker('tasks:claim', tasksHandlers.claim));
  r.patch('/api/tasks/:id/status', worker('tasks:report', tasksHandlers.updateStatus));

  // Agent
  r.post('/api/agents/register', async (req, res) => { if (!await requireServiceScope(req, res, 'agents:register')) return; await agentsHandlers.register(req, res); });
  r.post('/api/agents/:id/heartbeat', async (req, res) => { if (!await requireServiceScope(req, res, 'agents:heartbeat')) return; await agentsHandlers.heartbeat(req, res); });
  r.get('/api/agents', (req, res) => { if (!requireApiKey(req, res)) return; agentsHandlers.list(req, res); });
  r.get('/api/agents/:id', (req, res) => { if (!requireApiKey(req, res)) return; agentsHandlers.detail(req, res); });
  r.post('/api/agents/:id/release', async (req, res) => { if (!await requireServiceScope(req, res, 'agents:heartbeat')) return; await agentsHandlers.release(req, res); });

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

  // ── 竞品情报（CI）──
  // 竞品 CRUD
  r.post('/api/competitors', (req, res) => { if (!requireApiKey(req, res)) return; competitorsHandlers.create(req, res); });
  r.get('/api/competitors', (req, res) => { if (!requireApiKey(req, res)) return; competitorsHandlers.list(req, res); });
  r.get('/api/competitors/:id', (req, res) => { if (!requireApiKey(req, res)) return; competitorsHandlers.detail(req, res); });
  r.patch('/api/competitors/:id', (req, res) => { if (!requireApiKey(req, res)) return; competitorsHandlers.patch(req, res); });
  r.del('/api/competitors/:id', (req, res) => { if (!requireApiKey(req, res)) return; competitorsHandlers.del(req, res); });
  // 流水线触发
  r.post('/api/competitors/:id/analyze', (req, res) => { if (!requireApiKey(req, res)) return; competitorsHandlers.analyze(req, res); });
  r.post('/api/competitors/:id/monitor', (req, res) => { if (!requireApiKey(req, res)) return; competitorsHandlers.monitor(req, res); });
  // CI 查询 / 触发
  r.post('/api/ci/daily-monitor', worker('tasks:claim', ciHandlers.dailyMonitor));
  r.get('/api/ci/profile', (req, res) => { if (!requireApiKey(req, res)) return; void ciHandlers.profile(req, res); });
  r.patch('/api/ci/profile', (req, res) => { if (!requireApiKey(req, res)) return; void ciHandlers.profileSave(req, res); });
  r.get('/api/ci/alerts', (req, res) => { if (!requireApiKey(req, res)) return; ciHandlers.alertsList(req, res); });
  r.post('/api/ci/alerts/send', (req, res) => { if (!requireApiKey(req, res)) return; ciHandlers.alertsSend(req, res); });
  r.get('/api/ci/competitors/:id/latest', (req, res) => { if (!requireApiKey(req, res)) return; ciHandlers.latest(req, res); });
  r.get('/api/ci/competitors/:id/changes', (req, res) => { if (!requireApiKey(req, res)) return; ciHandlers.changesList(req, res); });
  r.get('/api/ci/competitors/:id/insights', (req, res) => { if (!requireApiKey(req, res)) return; ciHandlers.insightsList(req, res); });
  r.get('/api/ci/competitors/:id/matrices', (req, res) => { if (!requireApiKey(req, res)) return; ciHandlers.matricesList(req, res); });
  r.get('/api/ci/competitors/:id/battlecards', (req, res) => { if (!requireApiKey(req, res)) return; ciHandlers.battlecardsList(req, res); });
  // CI 产物上报（Worker 侧，需要 X-Agent-ID）
  r.post('/api/ci/pages/check', worker('artifacts:write', ciHandlers.pagesCheck));
  r.post('/api/ci/changes', worker('artifacts:write', ciHandlers.changes));
  r.post('/api/ci/insights', worker('artifacts:write', ciHandlers.insights));
  r.post('/api/ci/matrices', worker('artifacts:write', ciHandlers.matrices));
  r.post('/api/ci/battlecards', worker('artifacts:write', ciHandlers.battlecards));
  r.post('/api/ci/quality', worker('artifacts:write', ciHandlers.quality));

  // ── 阶段一正式分析入口 ──
  r.post('/api/analysis-briefs', (req, res) => { if (!requireApiKey(req, res)) return; return analysisHandlers.createBrief(req, res); });
  r.get('/api/analysis-briefs/:id/preflight', (req, res) => { if (!requireApiKey(req, res)) return; return analysisHandlers.preflight(req, res); });
  r.post('/api/runs', (req, res) => { if (!requireApiKey(req, res)) return; return analysisHandlers.createRun(req, res); });
  r.get('/api/runs', (req, res) => { if (!requireApiKey(req, res)) return; return analysisHandlers.listRuns(req, res); });
  r.get('/api/runs/:id', (req, res) => { if (!requireApiKey(req, res)) return; return analysisHandlers.runDetail(req, res); });
  r.post('/api/runs/:id/cancel', (req, res) => { if (!requireApiKey(req, res)) return; return analysisHandlers.cancelRun(req, res); });
  r.post('/api/runs/:id/retry', (req, res) => { if (!requireApiKey(req, res)) return; return analysisHandlers.retryRun(req, res); });
  r.get('/api/runs/:id/evidence', (req, res) => { if (!requireApiKey(req, res)) return; return analysisHandlers.runEvidence(req, res); });
  r.get('/api/evidence', (req, res) => { if (!requireApiKey(req, res)) return; return analysisHandlers.evidenceList(req, res); });
  r.post('/api/evidence', worker('evidence:write', analysisHandlers.createEvidence));
  r.patch('/api/evidence/:id/review', (req, res) => { if (!requireApiKey(req, res)) return; return analysisHandlers.reviewEvidence(req, res); });
  r.patch('/api/evidence/review-batch', (req, res) => { if (!requireApiKey(req, res)) return; return analysisHandlers.reviewEvidenceBatch(req, res); });
  r.post('/api/claims', worker('claims:write', analysisHandlers.createClaim));
  r.get('/api/claims', (req, res) => { if (!requireApiKey(req, res)) return; return analysisHandlers.claimsList(req, res); });
  r.patch('/api/claims/:id/review', (req, res) => { if (!requireApiKey(req, res)) return; return analysisHandlers.reviewClaim(req, res); });
  r.post('/api/reports', (req, res) => { if (!requireApiKey(req, res)) return; return analysisHandlers.createReport(req, res); });
  r.post('/api/reports/:id/:action', (req, res) => { if (!requireApiKey(req, res)) return; return analysisHandlers.reportAction(req, res); });
  r.get('/api/reports/:id/export', (req, res) => { if (!requireApiKey(req, res)) return; return analysisHandlers.reportExport(req, res); });

  // 阶段二：项目空间、产品目录与价格/参数时间线
  r.post('/api/projects', (req, res) => { if (!requireApiKey(req, res)) return; return projectsHandlers.create(req, res); });
  r.get('/api/projects', (req, res) => { if (!requireApiKey(req, res)) return; return projectsHandlers.list(req, res); });
  r.get('/api/projects/:id', (req, res) => { if (!requireApiKey(req, res)) return; return projectsHandlers.detail(req, res); });
  r.get('/api/projects/:id/dashboard', (req, res) => { if (!requireApiKey(req, res)) return; return projectsHandlers.dashboard(req, res); });
  r.get('/api/projects/:id/runs', (req, res) => { if (!requireApiKey(req, res)) return; return projectsHandlers.runs(req, res); });
  r.post('/api/projects/:id/members', (req, res) => { if (!requireApiKey(req, res)) return; return projectsHandlers.addMember(req, res); });
  r.post('/api/projects/:id/skus', (req, res) => { if (!requireApiKey(req, res)) return; return projectsHandlers.attachSku(req, res); });
  r.get('/api/catalog', (req, res) => { if (!requireApiKey(req, res)) return; return projectsHandlers.catalog(req, res); });
  r.post('/api/catalog/items/:type', (req, res) => { if (!requireApiKey(req, res)) return; return projectsHandlers.createCatalogItem(req, res); });
  r.post('/api/catalog/imports/preview', (req, res) => { if (!requireApiKey(req, res)) return; return projectsHandlers.importPreview(req, res); });
  r.post('/api/catalog/imports/:id/confirm', (req, res) => { if (!requireApiKey(req, res)) return; return projectsHandlers.importConfirm(req, res); });
  r.post('/api/skus/:id/product-snapshots', (req, res) => { if (!requireApiKey(req, res)) return; return projectsHandlers.productSnapshot(req, res); });
  r.post('/api/skus/:id/price-snapshots', (req, res) => { if (!requireApiKey(req, res)) return; return projectsHandlers.priceSnapshot(req, res); });
  r.get('/api/skus/:id/timeline', (req, res) => { if (!requireApiKey(req, res)) return; return projectsHandlers.timeline(req, res); });

  return r;
}

export function createAppServer() {
  const router = buildRouter();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const method = req.method ?? 'GET';

    const origin = req.headers.origin;
    if (origin && config.webOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-API-Key, X-Agent-ID');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (method === 'OPTIONS') {
      res.writeHead(origin && config.webOrigins.includes(origin) ? 204 : 403);
      res.end();
      return;
    }

    // WS 升级走 ws 服务器
    if (url.pathname === '/ws' || url.pathname.startsWith('/ws/')) return;

    const match = router.match(method, url.pathname);
    if (!match) return notFound(res);

    const apiReq = req as ApiRequest;
    apiReq.traceId = crypto.randomUUID();
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
      handleError(res, err, `api:${apiReq.traceId}`, apiReq.traceId);
    }
  });

  return server;
}

async function main() {
  await initDb();

  await ensureBootstrapAdmin();

  const server = createAppServer();

  // WS 事件推送：事件落库即广播（DB 与实时流单一事实来源）
  const wss = initWs(server);
  registerEventHook((event) => broadcast(JSON.stringify({ type: 'event', event })));

  logger.info('server', 'API event hook registered (ws only)');

  server.listen(config.port, () => {
    logger.info('server', `API listening on http://localhost:${config.port}`);
  });

  const shutdown = (signal: string) => {
    logger.info('server', `received ${signal}, shutting down`);
    stopWs(wss);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // 全局兜底：单个未捕获异常/拒绝不崩整个 API（记日志，进程继续）
  process.on('uncaughtException', (err) => {
    logger.error('server', `uncaughtException: ${err instanceof Error ? err.stack ?? err.message : err}`);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('server', `unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`);
  });
}

// 直接被测试 import 时不启动；命令行运行时启动
if (import.meta.main) {
  main().catch((err) => {
    logger.error('server', `fatal: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
