import { createHash } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { ApiRequest } from '../middleware.js';
import { HttpError, sendJson } from '../middleware.js';
import { getProfile } from '@api/db/queries/profile.js';
import { getCompetitor } from '@api/db/queries/competitors.js';
import { canAccessProject, linkProjectRun } from '@api/db/queries/projects.js';
import { config } from '@platform/config.js';
import {
  createAnalysisBrief,
  createClaim,
  createReport,
  createRun,
  getAnalysisBrief,
  getReport,
  getRunArtifacts,
  evidenceGate,
  getRun,
  insertEvidence,
  listEvidence,
  listClaims,
  listRuns,
  listRunStages,
  retryFailedStage,
  requestRunResume,
  reviewClaim,
  reviewEvidence,
  reviewEvidenceBatch,
  transitionReport,
  transitionRun,
  getIdempotentResponse,
  saveIdempotentResponse,
} from '@api/db/queries/analysis.js';
import type { ReportStatus, ReviewStatus, RunStatus } from '@domain/analysis.js';
import { renderTextPdf } from '@api/report/pdf.js';

const PURPOSES = ['pricing', 'product', 'battlecard', 'market_entry', 'comprehensive', 'competitor_only'];
const REVIEW_STATUSES: ReviewStatus[] = ['pending', 'verified', 'rejected', 'disputed', 'expired'];
const RUN_STATUSES: RunStatus[] = ['draft', 'queued', 'running', 'waiting_review', 'published', 'failed', 'cancelled'];

function actor(req: ApiRequest): string {
  return req.actor ?? 'user:api';
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${key} is required`);
  return value.trim();
}

function stringArray(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v.trim())) {
    throw new HttpError(400, `${name} must be a string array`);
  }
  return [...new Set(value.map((v) => String(v).trim()))];
}

function positiveNumber(value: unknown, fallback: number, name: string, max: number): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > max) throw new HttpError(400, `${name} invalid`);
  return n;
}

async function preflight(briefId: string) {
  const brief = await getAnalysisBrief(briefId);
  if (!brief) throw new HttpError(404, 'NOT_FOUND');
  const profile = await getProfile();
  const competitors = (await Promise.all(brief.competitor_ids.map(getCompetitor))).filter(Boolean);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!brief.competitor_ids.length) errors.push('至少选择一个竞品');
  if (competitors.length !== brief.competitor_ids.length) errors.push('存在已删除或无效的竞品');
  if (brief.purpose !== 'competitor_only' && !brief.our_product_id) errors.push('竞争对比必须选择我方产品版本');
  if (brief.competitor_ids.length > 1) warnings.push('当前一次运行处理一个竞品；启动时需指定 competitor_id');
  if (brief.purpose !== 'competitor_only' && !profile?.positioning) warnings.push('我方产品定位未填写');
  if (!config.anthropic.apiKey && !config.ciDemoMode) {
    errors.push('未配置 ANTHROPIC_API_KEY，无法调用 Claude');
  }
  if (!config.serpApi.key && !config.ciDemoMode) errors.push('未配置 SERPAPI_KEY，无法启动监测');
  return {
    brief,
    ready: errors.length === 0,
    product_completeness: profile
      ? Math.round([profile.name, profile.website, profile.positioning, profile.target_market].filter(Boolean).length / 4 * 100)
      : 0,
    capabilities: {
      model: Boolean(config.anthropic.apiKey) || config.ciDemoMode,
      search: Boolean(config.serpApi.key) || config.ciDemoMode,
      review: Boolean(config.deepseek.apiKey) || config.ciDemoMode,
    },
    estimated_steps: brief.purpose === 'competitor_only'
      ? ['monitor', 'research', 'compare']
      : ['monitor', 'research', 'compare', 'battlecard', 'quality'],
    errors,
    warnings,
  };
}

export const analysisHandlers = {
  async createBrief(req: ApiRequest, res: ServerResponse): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const purpose = requiredString(body, 'purpose');
    if (!PURPOSES.includes(purpose)) throw new HttpError(400, 'invalid purpose');
    const competitorIds = stringArray(body.competitor_ids, 'competitor_ids');
    if (!competitorIds.length) throw new HttpError(400, 'competitor_ids is required');
    if (purpose === 'competitor_only' && competitorIds.length !== 2) throw new HttpError(400, 'competitor_only requires exactly 2 competitors');
    const ownId = typeof body.our_product_id === 'string' && body.our_product_id.trim()
      ? body.our_product_id.trim() : null;
    if (purpose !== 'competitor_only' && !ownId) {
      throw new HttpError(400, 'our_product_id is required for comparison');
    }
    const competitors = await Promise.all(competitorIds.map(getCompetitor));
    if (competitors.some((c) => !c)) throw new HttpError(400, 'competitor not found');
    const brief = await createAnalysisBrief({
      our_product_id: ownId,
      competitor_ids: competitorIds,
      purpose,
      market: requiredString(body, 'market'),
      time_range_start: typeof body.time_range_start === 'string' ? body.time_range_start : null,
      time_range_end: typeof body.time_range_end === 'string' ? body.time_range_end : null,
      included_sources: stringArray(body.included_sources, 'included_sources'),
      excluded_sources: stringArray(body.excluded_sources, 'excluded_sources'),
      max_runtime_seconds: positiveNumber(body.max_runtime_seconds, 3600, 'max_runtime_seconds', 86400),
      cost_budget: positiveNumber(body.cost_budget, 10, 'cost_budget', 100000),
      allow_unverified: body.allow_unverified === true,
      created_by: actor(req),
    });
    sendJson(res, 201, { brief });
  },

  async preflight(req: ApiRequest, res: ServerResponse): Promise<void> {
    sendJson(res, 200, await preflight(req.params!.id));
  },

  async createRun(req: ApiRequest, res: ServerResponse): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const idempotencyKey = typeof req.headers['idempotency-key'] === 'string'
      ? req.headers['idempotency-key'].trim() : '';
    const requestHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    if (idempotencyKey) {
      const existing = await getIdempotentResponse(actor(req), idempotencyKey, requestHash);
      if (existing) {
        sendJson(res, existing.statusCode, existing.body);
        return;
      }
    }
    const briefId = requiredString(body, 'brief_id');
    const projectId = typeof body.project_id === 'string' && body.project_id.trim() ? body.project_id.trim() : null;
    if (projectId && !await canAccessProject(projectId, actor(req), req.userRole === 'admin')) {
      throw new HttpError(403, 'PROJECT_ACCESS_DENIED');
    }
    const check = await preflight(briefId);
    if (!check.ready) throw new HttpError(409, `preflight failed: ${check.errors.join('；')}`);
    const brief = check.brief;
    const requestedCompetitor = typeof body.competitor_id === 'string' ? body.competitor_id : null;
    if (brief.competitor_ids.length > 1 && !requestedCompetitor) {
      throw new HttpError(400, 'competitor_id is required when brief has multiple competitors');
    }
    const competitorId = requestedCompetitor ?? brief.competitor_ids[0];
    if (!brief.competitor_ids.includes(competitorId)) throw new HttpError(400, 'competitor_id is outside brief scope');
    const [profile, competitor, comparisonCompetitors] = await Promise.all([
      getProfile(),
      getCompetitor(competitorId),
      brief.purpose === 'competitor_only'
        ? Promise.all(brief.competitor_ids.map(getCompetitor))
        : Promise.resolve([]),
    ]);
    if (!competitor) throw new HttpError(404, 'NOT_FOUND');
    const snapshot = {
      schema_version: 1,
      frozen_at: new Date().toISOString(),
      brief,
      ...(brief.purpose === 'competitor_only'
        ? {
          comparison_competitors: comparisonCompetitors
            .filter((item): item is NonNullable<typeof item> => Boolean(item))
            .map((item) => ({ id: item.id, name: item.name, website: item.website })),
        }
        : { our_product: profile ?? config.ourProduct }),
      competitor,
      source_policy: {
        included: brief.included_sources,
        excluded: brief.excluded_sources,
        allow_unverified: Boolean(brief.allow_unverified),
      },
      agent: { model: config.agentModel, quality_judges: config.ciJudgeCount },
      prompt_version: 'p1-v1',
    };
    const run = await createRun({
      brief, snapshot, actor: actor(req), modelVersion: config.agentModel, promptVersion: 'p1-v1',
    });
    if (projectId) await linkProjectRun(projectId, run.id);
    const response = { run };
    if (idempotencyKey) {
      await saveIdempotentResponse({
        actor: actor(req), key: idempotencyKey, method: 'POST', path: '/api/runs',
        requestHash, statusCode: 202, body: response,
      });
    }
    sendJson(res, 202, response);
  },

  async listRuns(req: ApiRequest, res: ServerResponse): Promise<void> {
    const q = req.query!;
    const status = (q.get('status') || undefined) as RunStatus | undefined;
    if (status && !RUN_STATUSES.includes(status)) throw new HttpError(400, 'invalid status');
    sendJson(res, 200, await listRuns({
      status, competitorId: q.get('competitor_id') || undefined,
      briefId: q.get('brief_id') || undefined,
      productId: q.get('our_product_id') || undefined, purpose: q.get('purpose') || undefined,
      from: q.get('from') || undefined, to: q.get('to') || undefined,
      page: q.get('page') ? Number(q.get('page')) : undefined,
      size: q.get('size') ? Number(q.get('size')) : undefined,
    }));
  },

  async runDetail(req: ApiRequest, res: ServerResponse): Promise<void> {
    const run = await getRun(req.params!.id);
    if (!run) throw new HttpError(404, 'NOT_FOUND');
    const [brief, stages, evidence, artifacts, gate] = await Promise.all([
      getAnalysisBrief(run.brief_id),
      listRunStages(run.id),
      listEvidence({ runId: run.id, page: 1, size: 20 }),
      getRunArtifacts(run.id),
      evidenceGate(run.id),
    ]);
    sendJson(res, 200, { run, brief, stages, evidence, artifacts, gate });
  },

  async cancelRun(req: ApiRequest, res: ServerResponse): Promise<void> {
    sendJson(res, 200, { run: await transitionRun(req.params!.id, 'cancelled', actor(req)) });
  },

  async retryRun(req: ApiRequest, res: ServerResponse): Promise<void> {
    const current = await getRun(req.params!.id);
    if (!current) throw new HttpError(404, 'NOT_FOUND');
    if (current.status === 'waiting_review') {
      const run = await requestRunResume(current.id, actor(req));
      sendJson(res, 202, { run });
      return;
    }
    const stage = await retryFailedStage(req.params!.id, actor(req));
    sendJson(res, 202, { run: await getRun(req.params!.id), stage });
  },

  async runEvidence(req: ApiRequest, res: ServerResponse): Promise<void> {
    if (!(await getRun(req.params!.id))) throw new HttpError(404, 'NOT_FOUND');
    const q = req.query!;
    sendJson(res, 200, await listEvidence({
      runId: req.params!.id,
      status: (q.get('status') || undefined) as ReviewStatus | undefined,
      page: q.get('page') ? Number(q.get('page')) : undefined,
      size: q.get('size') ? Number(q.get('size')) : undefined,
    }));
  },

  async evidenceList(req: ApiRequest, res: ServerResponse): Promise<void> {
    const q = req.query!;
    const status = (q.get('status') || 'pending') as ReviewStatus;
    if (!REVIEW_STATUSES.includes(status)) throw new HttpError(400, 'invalid status');
    sendJson(res, 200, await listEvidence({
      status, competitorId: q.get('competitor_id') || undefined,
      sourceType: q.get('source_type') || undefined, market: q.get('market') || undefined,
      from: q.get('from') || undefined, to: q.get('to') || undefined,
      page: q.get('page') ? Number(q.get('page')) : undefined,
      size: q.get('size') ? Number(q.get('size')) : undefined,
    }));
  },

  async createEvidence(req: ApiRequest, res: ServerResponse): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const runId = requiredString(body, 'run_id');
    if (!(await getRun(runId))) throw new HttpError(404, 'NOT_FOUND');
    const raw = typeof body.raw_content === 'string' ? body.raw_content : null;
    const hash = typeof body.body_hash === 'string' && body.body_hash
      ? body.body_hash : createHash('sha256').update(raw ?? '').digest('hex');
    const evidence = await insertEvidence({
      run_id: runId,
      competitor_id: typeof body.competitor_id === 'string' ? body.competitor_id : null,
      request_url: requiredString(body, 'request_url'),
      final_url: typeof body.final_url === 'string' ? body.final_url : undefined,
      title: typeof body.title === 'string' ? body.title : null,
      http_status: body.http_status === undefined ? null : Number(body.http_status),
      content_type: typeof body.content_type === 'string' ? body.content_type : null,
      body_hash: hash, snapshot_uri: typeof body.snapshot_uri === 'string' ? body.snapshot_uri : null,
      raw_content: raw, source_type: typeof body.source_type === 'string' ? body.source_type : 'website',
      market: typeof body.market === 'string' ? body.market : null,
      language: typeof body.language === 'string' ? body.language : null,
      published_at: typeof body.published_at === 'string' ? body.published_at : null,
    });
    sendJson(res, 201, { evidence });
  },

  async reviewEvidence(req: ApiRequest, res: ServerResponse): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const status = requiredString(body, 'status') as ReviewStatus;
    if (!REVIEW_STATUSES.includes(status) || status === 'pending') throw new HttpError(400, 'invalid review status');
    const reason = requiredString(body, 'reason');
    sendJson(res, 200, { evidence: await reviewEvidence(req.params!.id, status, actor(req), reason) });
  },

  async reviewEvidenceBatch(req: ApiRequest, res: ServerResponse): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ids = stringArray(body.ids, 'ids');
    if (!ids.length) throw new HttpError(400, 'ids is required');
    const status = requiredString(body, 'status') as ReviewStatus;
    if (!REVIEW_STATUSES.includes(status) || status === 'pending') throw new HttpError(400, 'invalid review status');
    const evidence = await reviewEvidenceBatch(ids, status, actor(req), requiredString(body, 'reason'));
    sendJson(res, 200, { evidence });
  },

  async createClaim(req: ApiRequest, res: ServerResponse): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const confidence = Number(body.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new HttpError(400, 'confidence must be 0-1');
    }
    const claim = await createClaim({
      run_id: requiredString(body, 'run_id'), statement: requiredString(body, 'statement'),
      subject: requiredString(body, 'subject'),
      claim_type: typeof body.claim_type === 'string' ? body.claim_type : undefined,
      market: typeof body.market === 'string' ? body.market : null,
      valid_at: typeof body.valid_at === 'string' ? body.valid_at : null,
      confidence, evidence_ids: stringArray(body.evidence_ids, 'evidence_ids'),
    });
    sendJson(res, 201, { claim });
  },

  async claimsList(req: ApiRequest, res: ServerResponse): Promise<void> {
    const q = req.query!;
    const status = (q.get('status') || 'pending') as ReviewStatus;
    if (!REVIEW_STATUSES.includes(status)) throw new HttpError(400, 'invalid status');
    sendJson(res, 200, await listClaims({
      status, runId: q.get('run_id') || undefined,
      page: q.get('page') ? Number(q.get('page')) : undefined,
      size: q.get('size') ? Number(q.get('size')) : undefined,
    }));
  },

  async reviewClaim(req: ApiRequest, res: ServerResponse): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const status = requiredString(body, 'status') as ReviewStatus;
    if (!REVIEW_STATUSES.includes(status) || status === 'pending') throw new HttpError(400, 'invalid review status');
    sendJson(res, 200, {
      claim: await reviewClaim(req.params!.id, status, actor(req), requiredString(body, 'reason')),
    });
  },

  async createReport(req: ApiRequest, res: ServerResponse): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const content = body.content;
    if (!content || typeof content !== 'object' || Array.isArray(content)) throw new HttpError(400, 'content object required');
    if (typeof (content as Record<string, unknown>).title !== 'string' ||
        typeof (content as Record<string, unknown>).summary !== 'string') {
      throw new HttpError(400, 'content.title and content.summary required');
    }
    const report = await createReport(
      requiredString(body, 'run_id'), content as Record<string, unknown>,
      stringArray(body.claim_ids, 'claim_ids'), actor(req)
    );
    sendJson(res, 201, { report });
  },

  async reportAction(req: ApiRequest, res: ServerResponse): Promise<void> {
    const action = req.params!.action as ReportStatus;
    const map: Record<string, ReportStatus> = {
      submit: 'reviewing', approve: 'approved', publish: 'published',
    };
    const to = map[action];
    if (!to) throw new HttpError(404, 'NOT_FOUND');
    if (['approved', 'published'].includes(to) && req.userRole !== 'admin') {
      throw new HttpError(403, 'APPROVER_ROLE_REQUIRED');
    }
    sendJson(res, 200, { report: await transitionReport(req.params!.id, to, actor(req)) });
  },

  async reportExport(req: ApiRequest, res: ServerResponse): Promise<void> {
    const report = await getReport(req.params!.id);
    if (!report) throw new HttpError(404, 'NOT_FOUND');
    const format = req.query!.get('format') || 'json';
    if (!['json', 'markdown', 'pdf'].includes(format)) throw new HttpError(400, 'invalid export format');
    const run = await getRun(String(report.run_id));
    const sources = (await listEvidence({ runId: String(report.run_id), page: 1, size: 100 })).evidence;
    const disclaimer = '本报告仅基于运行时冻结的数据范围与已核验证据，不构成投资或法律建议。';
    const bundle = { report, run_snapshot: run?.snapshot ?? null, sources, disclaimer };
    if (format === 'json') return sendJson(res, 200, bundle);
    const content = report.content as Record<string, unknown>;
    const markdown = [
      `# ${String(content.title ?? '竞品分析报告')}`,
      '', `报告时间：${String(report.created_at)}`, `运行：${String(report.run_id)}`,
      '', String(content.summary ?? ''), '', '## 来源',
      ...sources.map((source) => `- ${String(source.title ?? source.final_url)} — ${String(source.final_url)}`),
      '', '---', `免责声明：${disclaimer}`,
    ].join('\n');
    if (format === 'pdf') {
      const pdf = renderTextPdf(markdown.split('\n'));
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename=report-${report.id}.pdf`,
        'Content-Length': pdf.length,
      });
      res.end(pdf);
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename=report-${report.id}.md`,
    });
    res.end(markdown);
  },
};
