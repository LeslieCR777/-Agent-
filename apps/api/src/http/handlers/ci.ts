import type { ServerResponse } from 'node:http';
import type { ApiRequest } from '../middleware.js';
import { sendJson, HttpError } from '../middleware.js';
import { getCompetitor, listEnabledCompetitors } from '@api/db/queries/competitors.js';
import {
  upsertPageHash,
  insertChanges,
  listChanges,
  latestInsights,
  insertInsight,
  latestMatrix,
  insertMatrix,
  latestBattlecard,
  insertBattlecard,
  listBattlecards,
  setBattlecardQuality,
  insertAlert,
  listAlerts,
  pendingHighCriticalChanges,
} from '@api/db/queries/ci.js';
import { getProfile, saveProfile } from '@api/db/queries/profile.js';
import { config } from '@platform/config.js';
import type {
  Battlecard,
  ChangeType,
  CompetitorChange,
  ComparisonMatrix,
  QualityResult,
  ResearchInsight,
  Severity,
} from '@contracts/types.js';
import { enqueueOutbox, linkArtifactToRunClaims, requestLegacyPipeline } from '@api/db/queries/analysis.js';

const CHANGE_TYPES: ChangeType[] = ['pricing', 'product', 'hiring', 'news', 'patent', 'blog', 'open_source'];
const SEVERITIES: Severity[] = ['low', 'medium', 'high', 'critical'];

async function requireCompetitor(id: string) {
  const competitor = await getCompetitor(id);
  if (!competitor) throw new HttpError(404, 'NOT_FOUND');
  return competitor;
}

function parseChanges(body: Record<string, unknown>): CompetitorChange[] {
  const raw = body.changes;
  if (!Array.isArray(raw)) throw new HttpError(400, 'changes must be an array');
  const out: CompetitorChange[] = [];
  for (const c of raw as Record<string, unknown>[]) {
    const changeType = c.change_type as ChangeType;
    const severity = c.severity as Severity;
    if (!CHANGE_TYPES.includes(changeType)) throw new HttpError(400, `invalid change_type: ${String(changeType)}`);
    if (!SEVERITIES.includes(severity)) throw new HttpError(400, `invalid severity: ${String(severity)}`);
    out.push({
      competitor: String(c.competitor ?? ''),
      change_type: changeType,
      title: String(c.title ?? ''),
      summary: String(c.summary ?? ''),
      url: String(c.url ?? ''),
      severity,
      raw_data: c.raw_data,
    });
  }
  return out;
}

export const ciHandlers = {
  // ── Worker 侧（X-Agent-ID）：产物上报 ─────────────────

  /** POST /api/ci/pages/check 页面哈希快筛（三级检测第一级） */
  async pagesCheck(req: ApiRequest, res: ServerResponse): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const competitor_id = String(body.competitor_id ?? '');
    const url = String(body.url ?? '');
    const sha256 = String(body.sha256 ?? '');
    if (!competitor_id || !url || !sha256) throw new HttpError(400, 'competitor_id, url, sha256 required');
    await requireCompetitor(competitor_id);
    const { changed } = await upsertPageHash({
      competitor_id,
      url,
      sha256,
      title: body.title ? String(body.title) : null,
    });
    sendJson(res, 200, { changed });
  },

  /** POST /api/ci/changes 批量上报变化（task_id 为来源 monitor 任务） */
  async changes(req: ApiRequest, res: ServerResponse): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const competitor_id = String(body.competitor_id ?? '');
    if (!competitor_id) throw new HttpError(400, 'competitor_id required');
    await requireCompetitor(competitor_id);
    const changes = parseChanges(body);
    const taskId = typeof body.task_id === 'string' ? body.task_id : '';
    const { inserted } = await insertChanges(competitor_id, changes, taskId);
    sendJson(res, 200, { inserted });
  },

  /** POST /api/ci/insights */
  async insights(req: ApiRequest, res: ServerResponse): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const competitor_id = String(body.competitor_id ?? '');
    if (!competitor_id) throw new HttpError(400, 'competitor_id required');
    await requireCompetitor(competitor_id);
    const insight = body.insight as ResearchInsight;
    if (!insight || typeof insight.topic !== 'string') throw new HttpError(400, 'insight.topic required');
    const round = Number(body.round ?? 0);
    const feedback = body.feedback ? String(body.feedback) : null;
    const taskId = typeof body.task_id === 'string' ? body.task_id : '';
    const row = await insertInsight(competitor_id, insight, round, feedback, taskId);
    sendJson(res, 201, { insight: row });
  },

  /** POST /api/ci/matrices */
  async matrices(req: ApiRequest, res: ServerResponse): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const competitor_id = String(body.competitor_id ?? '');
    if (!competitor_id) throw new HttpError(400, 'competitor_id required');
    await requireCompetitor(competitor_id);
    const matrix = body.matrix as ComparisonMatrix;
    if (!matrix || !Array.isArray(matrix.dimensions)) throw new HttpError(400, 'matrix.dimensions required');
    const round = Number(body.round ?? 0);
    const taskId = typeof body.task_id === 'string' ? body.task_id : '';
    const row = await insertMatrix(competitor_id, matrix, round, taskId);
    if (taskId) await linkArtifactToRunClaims(taskId, 'matrix', row.id);
    sendJson(res, 201, { matrix: row });
  },

  /** POST /api/ci/battlecards */
  async battlecards(req: ApiRequest, res: ServerResponse): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const competitor_id = String(body.competitor_id ?? '');
    if (!competitor_id) throw new HttpError(400, 'competitor_id required');
    await requireCompetitor(competitor_id);
    const battlecard = body.battlecard as Battlecard;
    if (!battlecard || !Array.isArray(battlecard.our_strengths)) {
      throw new HttpError(400, 'battlecard.our_strengths required');
    }
    const round = Number(body.round ?? 0);
    const taskId = typeof body.task_id === 'string' ? body.task_id : '';
    const row = await insertBattlecard(competitor_id, battlecard, round, taskId);
    if (taskId) await linkArtifactToRunClaims(taskId, 'battlecard', row.id);
    sendJson(res, 201, { battlecard: row });
  },

  /** POST /api/ci/quality 质检结果（服务端回填最新战卡） */
  async quality(req: ApiRequest, res: ServerResponse): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const competitor_id = String(body.competitor_id ?? '');
    if (!competitor_id) throw new HttpError(400, 'competitor_id required');
    await requireCompetitor(competitor_id);
    const q = body.quality as QualityResult;
    const score = Number(q?.score ?? NaN);
    if (!Number.isFinite(score) || score < 1 || score > 10) throw new HttpError(400, 'quality.score must be 1-10');
    const bc = await latestBattlecard(competitor_id);
    if (!bc) throw new HttpError(409, 'no battlecard to grade');
    await setBattlecardQuality(bc.id, { score, feedback: String(q?.feedback ?? '') });
    sendJson(res, 200, { ok: true, score, battlecard_id: bc.id });
  },

  // ── 服务端：查询 / 触发 ───────────────────────────────

  /** POST /api/ci/daily-monitor 遍历 enabled 竞品逐个发起 monitor（Worker 领到 daily_monitor 任务时调用） */
  async dailyMonitor(req: ApiRequest, res: ServerResponse): Promise<void> {
    const competitors = await listEnabledCompetitors();
    const kicked: string[] = [];
    for (const c of competitors) {
      await requestLegacyPipeline(c.id, 'monitor', req.actor ?? 'service:scheduler');
      kicked.push(c.id);
    }
    sendJson(res, 200, { kicked });
  },

  /** GET /api/ci/profile 我方产品档案（看板展示；DB 优先，空表回退 .env） */
  async profile(_req: ApiRequest, res: ServerResponse): Promise<void> {
    const dbProfile = await getProfile();
    if (dbProfile) {
      sendJson(res, 200, {
        profile: {
          id: dbProfile.id,
          name: dbProfile.name,
          website: dbProfile.website ?? '',
          positioning: dbProfile.positioning ?? '',
          targetMarket: dbProfile.target_market ?? '',
          source: 'db',
        },
      });
      return;
    }
    // 空表：回退 .env 默认（config.ourProduct）
    sendJson(res, 200, { profile: { ...config.ourProduct, source: 'env' } });
  },

  /** PUT /api/ci/profile 用户自行注册/更新我方产品画像 */
  async profileSave(req: ApiRequest, res: ServerResponse): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null;
    if (!name) throw new HttpError(400, 'name is required');
    const saved = await saveProfile({
      name,
      website: typeof body.website === 'string' ? body.website.trim() : undefined,
      positioning: typeof body.positioning === 'string' ? body.positioning.trim() : undefined,
      target_market: typeof body.targetMarket === 'string' ? body.targetMarket.trim() : undefined,
    });
    sendJson(res, 200, {
      profile: {
        id: saved.id,
        name: saved.name,
        website: saved.website ?? '',
        positioning: saved.positioning ?? '',
        targetMarket: saved.target_market ?? '',
        source: 'db',
      },
    });
  },

  /** GET /api/ci/competitors/:id/latest 看板聚合：竞品 + 最新矩阵/战卡 + 近期变化/洞察 */
  async latest(req: ApiRequest, res: ServerResponse): Promise<void> {
    const competitor = await requireCompetitor(req.params!.id);
    const [matrix, battlecard, changes, insights] = await Promise.all([
      latestMatrix(competitor.id),
      latestBattlecard(competitor.id),
      listChanges(competitor.id, { limit: 10 }),
      latestInsights(competitor.id),
    ]);
    sendJson(res, 200, { competitor, matrix, battlecard, changes, insights });
  },

  /** GET /api/ci/competitors/:id/changes */
  async changesList(req: ApiRequest, res: ServerResponse): Promise<void> {
    const competitor = await requireCompetitor(req.params!.id);
    const q = req.query!;
    const severity = q.get('severity') as Severity | null;
    if (severity && !SEVERITIES.includes(severity)) throw new HttpError(400, 'invalid severity');
    const limit = q.get('limit') ? Number(q.get('limit')) : 50;
    sendJson(res, 200, { changes: await listChanges(competitor.id, { severity: severity ?? undefined, limit }) });
  },

  /** GET /api/ci/competitors/:id/insights */
  async insightsList(req: ApiRequest, res: ServerResponse): Promise<void> {
    const competitor = await requireCompetitor(req.params!.id);
    sendJson(res, 200, { insights: await latestInsights(competitor.id) });
  },

  /** GET /api/ci/competitors/:id/matrices */
  async matricesList(req: ApiRequest, res: ServerResponse): Promise<void> {
    const competitor = await requireCompetitor(req.params!.id);
    sendJson(res, 200, { matrix: await latestMatrix(competitor.id) });
  },

  /** GET /api/ci/competitors/:id/battlecards */
  async battlecardsList(req: ApiRequest, res: ServerResponse): Promise<void> {
    const competitor = await requireCompetitor(req.params!.id);
    sendJson(res, 200, { battlecards: await listBattlecards(competitor.id) });
  },

  /** GET /api/ci/alerts 告警记录 */
  async alertsList(req: ApiRequest, res: ServerResponse): Promise<void> {
    const q = req.query!;
    const status = q.get('status') || undefined;
    const limit = q.get('limit') ? Number(q.get('limit')) : 50;
    sendJson(res, 200, { alerts: await listAlerts({ status, limit }) });
  },

  /** POST /api/ci/alerts/send 手动补发该竞品未告警的 high/critical 变化 */
  async alertsSend(req: ApiRequest, res: ServerResponse): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const competitor_id = String(body.competitor_id ?? '');
    if (!competitor_id) throw new HttpError(400, 'competitor_id required');
    await requireCompetitor(competitor_id);
    const pending = await pendingHighCriticalChanges(competitor_id);
    if (pending.length === 0) {
      sendJson(res, 200, { sent: 0 });
      return;
    }
    await enqueueOutbox('competitor', competitor_id, 'alerts.send_requested', {
      competitor_id,
      actor: req.actor ?? 'user',
    });
    sendJson(res, 202, { queued: pending.length });
  },
};
