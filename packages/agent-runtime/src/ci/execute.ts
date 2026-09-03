import { config } from '@platform/config.js';
import { logger } from '@platform/logger.js';
import { api, apiAsAgent } from '@runtime/client.js';
import { runAgent } from '@runtime/runner.js';
import { isDemo, demoAgentOutput } from './demo.js';
import { parseCiTags } from '@contracts/ci-tags.js';
import { parseJsonArray, parseJsonBlock } from './parse.js';
import { buildStagePrompt, buildQualityPrompt, type ExtractedPage } from './prompts.js';
import { contentHash } from './tools/hash.js';
import { monitorSearch, webSearch } from './tools/search.js';
import { judgeWithDeepSeek, aggregateVotes, demoJudgeVotes, JUDGE_ROLES } from './judge.js';
import type {
  Battlecard,
  CiStage,
  Competitor,
  CompetitorChange,
  CompetitorChangeRow,
  ComparisonMatrix,
  ResearchInsight,
  ResearchInsightRow,
  Task,
} from '@contracts/types.js';
import { validateBattlecard, validateInsights, validateMatrix } from './validate.js';

/**
 * Worker 侧 CI stage 执行器（依赖规则：只 import worker/client.ts，DB 全走 HTTP）。
 *
 * 每个 CI 任务（tags[0]==='ci'）由本模块按 stage 执行：
 *   parseCiTags → fetchContext(HTTP) → runStageTools(确定性工具)
 *   → buildStagePrompt → ciRunAgent(真 claude 或 demo 桩)
 *   → parseStageOutput → postArtifact(HTTP 上报) → 上报 completed
 */

export function isCiTask(tags: string[] | null): boolean {
  if (!tags || tags.length === 0) return false;
  if (tags[0] === 'ci') return true;
  // daily_monitor 任务：prompt 是模板标记（scheduler 用 tags ['ci','daily_monitor'] 已覆盖，
  // 这里兜底处理直接调用 daily-monitor 的任务）
  return false;
}

interface CiContext {
  competitor: Competitor;
  ourProfile: typeof config.ourProduct;
  competitorOnly: boolean;
  comparisonCompetitors: Competitor[];
  comparisonInsights: Record<string, ResearchInsightRow[]>;
  latestChanges: CompetitorChangeRow[];
  latestInsights: ResearchInsightRow[];
  matrix: ComparisonMatrix | null;
  battlecard: Battlecard | null;
  feedback: string | null;
  sourcePolicy: { included: string[]; excluded: string[] };
}

type ResearchSearchGroup = {
  query: string;
  results: { title: string; link: string; snippet: string }[];
};

/** 拉取该 stage 需要的上下文（HTTP GET，服务端产品接口是普通查询不需要 agent） */
async function fetchContext(competitorId: string, runId: string | null): Promise<CiContext> {
  const [comp, changes, insights, matrix, battlecard, profile, runDetail] = await Promise.all([
    api<{ competitor: Competitor }>(`/api/competitors/${competitorId}`).catch(() => null),
    api<{ changes: CompetitorChangeRow[] }>(`/api/ci/competitors/${competitorId}/changes?limit=20`).catch(() => ({ changes: [] })),
    api<{ insights: ResearchInsightRow[] }>(`/api/ci/competitors/${competitorId}/insights`).catch(() => ({ insights: [] })),
    api<{ matrix: ComparisonMatrix | null }>(`/api/ci/competitors/${competitorId}/matrices`).catch(() => ({ matrix: null })),
    api<{ battlecards: Battlecard[] }>(`/api/ci/competitors/${competitorId}/battlecards?limit=1`).catch(() => ({ battlecards: [] })),
    // 我方画像：优先取用户在看板注册的（DB），失败回退 .env 默认
    api<{ profile: typeof config.ourProduct }>(`/api/ci/profile`).catch(() => null),
    runId ? api<{ run: { snapshot?: { source_policy?: { included?: string[]; excluded?: string[] }; brief?: { purpose?: string; competitor_ids?: string[] } } }; brief?: { purpose?: string; competitor_ids?: string[] } }>(`/api/runs/${runId}`).catch(() => null) : null,
  ]);

  if (!comp?.competitor) throw new Error('competitor not found');
  const dbProfile = profile?.profile;
  const ourProfile = dbProfile?.name
    ? { name: dbProfile.name, website: dbProfile.website ?? '', positioning: dbProfile.positioning ?? '', targetMarket: dbProfile.targetMarket ?? '' }
    : config.ourProduct;
  const brief = runDetail?.brief ?? runDetail?.run.snapshot?.brief;
  const competitorOnly = brief?.purpose === 'competitor_only';
  const comparisonIds = brief?.competitor_ids?.length ? brief.competitor_ids : [competitorId];
  const comparisonCompetitors = (await Promise.all(comparisonIds.slice(0, 2).map((id) =>
    id === comp.competitor.id
      ? Promise.resolve(comp.competitor)
      : api<{ competitor: Competitor }>(`/api/competitors/${id}`).then((result) => result.competitor).catch(() => null)
  ))).filter((item): item is Competitor => Boolean(item));
  const comparisonInsights = Object.fromEntries(await Promise.all(comparisonCompetitors.map(async (peer) => [
    peer.id,
    peer.id === comp.competitor.id
      ? insights.insights
      : (await api<{ insights: ResearchInsightRow[] }>(`/api/ci/competitors/${peer.id}/insights`).catch(() => ({ insights: [] }))).insights,
  ] as const)));
  return {
    competitor: comp.competitor,
    ourProfile,
    competitorOnly,
    comparisonCompetitors,
    comparisonInsights,
    latestChanges: changes.changes,
    latestInsights: insights.insights,
    matrix: matrix?.matrix ?? null,
    battlecard: battlecard?.battlecards?.[0] ?? null,
    feedback: null,
    sourcePolicy: {
      included: runDetail?.run.snapshot?.source_policy?.included ?? [],
      excluded: runDetail?.run.snapshot?.source_policy?.excluded ?? [],
    },
  };
}

/** monitor 阶段：通过 SerpAPI 获取公开摘要，不直接请求高反爬目标站。 */
async function runMonitorTools(
  agentId: string,
  competitor: Competitor,
  runId: string | null,
  policy: { included: string[]; excluded: string[] }
): Promise<ExtractedPage[]> {
  const safeHosts = parseMonitorUrls(competitor)
    .filter((url) => !isAntiBotUrl(url))
    .map((url) => {
      try { return new URL(url).hostname; } catch { return ''; }
    })
    .filter(Boolean);
  const queries = [...new Set([
    `${competitor.name} 最新 产品 价格 参数 发布`,
    `${competitor.name} 官方 新闻 新品 评测`,
    ...safeHosts.map((host) => `site:${host} ${competitor.name}`),
  ])];
  const seen = new Set<string>();
  const pages: ExtractedPage[] = [];
  for (const query of queries) {
    const results = await monitorSearch(query, 8);
    for (const result of results) {
      if (!result.link || seen.has(result.link) || isAntiBotUrl(result.link) || !sourceAllowed(result.link, policy)) continue;
      seen.add(result.link);
      const text = [result.title, result.snippet].filter(Boolean).join('\n');
      if (!text.trim()) continue;
      const hash = contentHash(text);
      const { changed } = await apiAsAgent<{ changed: boolean }>(agentId, '/api/ci/pages/check', {
        method: 'POST',
        body: { competitor_id: competitor.id, url: result.link, sha256: hash, title: result.title.slice(0, 120) },
      });
      let evidenceId: string | undefined;
      if (runId && changed) {
        const saved = await apiAsAgent<{ evidence: { id: string } }>(agentId, '/api/evidence', {
          method: 'POST',
          body: {
            run_id: runId, competitor_id: competitor.id, request_url: result.link,
            final_url: result.link, title: result.title.slice(0, 120),
            content_type: 'text/plain', body_hash: hash,
            raw_content: text, source_type: 'search',
          },
        });
        evidenceId = saved.evidence.id;
      }
      pages.push({ url: result.link, changed, evidenceId, text: changed ? text : '', pricing: [], jobs: [] });
      logger.info('ci', `monitor SerpAPI ${result.link} ${changed ? 'CHANGED' : 'unchanged'}`);
    }
  }
  if (!pages.length) logger.warn('ci', `monitor SerpAPI returned no allowed results for ${competitor.name}`);
  return pages;
}

/** research 搜索阶段：5 类线索各 2 条搜索 */
async function runResearchTools(
  competitor: Competitor,
  policy: { included: string[]; excluded: string[] }
): Promise<{ query: string; results: { title: string; link: string; snippet: string }[] }[]> {
  const queries = [
    `${competitor.name} 融资 财务 营收`,
    `${competitor.name} 专利 知识产权`,
    `${competitor.name} 技术博客 产品发布`,
    `${competitor.name} github open source`,
    `${competitor.name} 合作 收购 并购 招聘`,
  ];
  const out: { query: string; results: { title: string; link: string; snippet: string }[] }[] = [];
  for (const q of queries) {
    try {
      const results = await webSearch(q, 6);
      out.push({ query: q, results: results.filter((result) => sourceAllowed(result.link, policy)) });
    } catch (err) {
      logger.warn('ci', `search "${q}" failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  return out;
}

/** 各 stage 的确定性工具 */
async function runStageTools(
  agentId: string,
  stage: Exclude<CiStage, 'daily_monitor'>,
  context: CiContext
  , runId: string | null
): Promise<{ pages?: ExtractedPage[]; searchResults?: { query: string; results: { title: string; link: string; snippet: string }[] }[] }> {
  switch (stage) {
    case 'monitor':
      return { pages: await runMonitorTools(agentId, context.competitor, runId, context.sourcePolicy) };
    case 'research':
      return { searchResults: await runResearchTools(context.competitor, context.sourcePolicy) };
    default:
      return {};
  }
}

/** 调用 LLM agent：demo 桩 或 真 claude CLI */
async function ciRunAgent(
  stage: Exclude<CiStage, 'daily_monitor'>,
  prompt: string,
  onLog: (line: string) => void,
  workdir: string,
  competitorOnly = false
): Promise<string> {
  if (isDemo()) {
    logger.info('ci', `demo mode: ${stage} stage uses stub output`);
    return demoAgentOutput(stage, { competitorOnly });
  }
  const result = await runAgent(prompt, { onLog }, { cwd: workdir });
  if (result.timedOut) throw new Error('agent timed out');
  if (result.exitCode !== 0) {
    const detail = result.errorOutput.trim();
    throw new Error(`agent exit ${result.exitCode}${detail ? ': ' + detail.slice(0, 1200) : ''}`);
  }
  return result.output;
}

/**
 * quality 阶段多 agent 测评：3 个评审视角（准确性/完整性/销售可用性）并行打分。
 * - 优先 DeepSeek API（低成本、3 路并行不贵）
 * - demo 模式 / 未配 DEEPSEEK_API_KEY → demo 桩投票
 * - 聚合：score = 三均值取整，feedback = 三反馈拼接
 */
async function runQualityJudges(competitor: Competitor, battlecard: Battlecard): Promise<{ score: number; feedback: string }> {
  // 评审只依赖 DEEPSEEK_API_KEY：配了就走真实 3 评审（评审不依赖 SERPAPI/SMTP）
  if (!config.deepseek.apiKey) {
    logger.info('ci', `no-DeepSeek: quality uses ${JUDGE_ROLES.length} stub judges`);
    const votes = demoJudgeVotes();
    return aggregateVotes(votes);
  }

  // 每个 judge 用各自视角的 prompt（多 agent 差异性）
  const results = await Promise.all(
    JUDGE_ROLES.map(async (role) => {
      try {
        const focusPrompt = buildQualityPrompt(competitor, battlecard, role.key);
        const out = await judgeWithDeepSeek(role.label, focusPrompt);
        const parsed = parseJsonBlock<Record<string, unknown>>(out);
        // 兼容多种 score 字段名：score / *_score / 评分；feedback 同理
        const score = extractScore(parsed);
        // 校验 score 合法（1-10），异常值视为该评审失败（避免污染聚合）
        if (score === null || score < 1 || score > 10) {
          throw new Error('parse judge failed or score out of range');
        }
        const feedback = (parsed?.feedback ?? parsed?.comments ?? parsed?.suggestions ?? '') as string;
        return { role: role.label, score, feedback: Array.isArray(feedback) ? feedback.join('；') : String(feedback) };
      } catch (err) {
        logger.warn('ci', `${role.key} judge failed: ${err instanceof Error ? err.message : err}`);
        return null;
      }
    })
  );
  const votes = results.filter((v): v is NonNullable<typeof v> => v !== null);
  // 全部失败则抛错（由调用方上报 failed）
  if (votes.length === 0) throw new Error('all judges failed');
  return aggregateVotes(votes);
}

/** 渲染并执行一个 stage 的完整流程（供 worker 调用） */

/** 解析各 stage 的 agent 输出；失败抛错（→ 上报 failed → orchestrator 标记 error） */
function parseStageOutput(
  stage: Exclude<CiStage, 'daily_monitor'>,
  output: string,
  competitor: Competitor,
  searchResults: ResearchSearchGroup[] = []
): unknown {
  switch (stage) {
    case 'monitor': {
      const changes = parseJsonArray<CompetitorChange>(output) ?? [];
      return changes;
    }
    case 'research': {
      const insights = parseResearchInsights(output, searchResults);
      return validateInsights(insights);
    }
    case 'compare': {
      const matrix = parseJsonBlock<ComparisonMatrix>(output);
      if (!matrix || !Array.isArray(matrix.dimensions)) throw new Error('parse compare matrix failed');
      return validateMatrix(matrix);
    }
    case 'battlecard': {
      const bc = parseJsonBlock<Battlecard>(output);
      if (!bc || !Array.isArray(bc.our_strengths)) throw new Error('parse battlecard failed');
      return validateBattlecard(bc);
    }
    case 'quality': {
      const q = parseJsonBlock<{ score: number; feedback: string }>(output);
      if (!q || typeof q.score !== 'number') throw new Error('parse quality failed');
      return q;
    }
    default:
      throw new Error(`unknown stage: ${stage}`);
  }
}

/** Accept the documented array and common model response envelopes. */
export function parseResearchInsights(
  output: string,
  searchResults: ResearchSearchGroup[] = []
): ResearchInsight[] {
  const parsed = parseJsonBlock<unknown>(output);
  let list: unknown[] = [];
  if (Array.isArray(parsed)) list = parsed;
  else if (parsed && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>;
    for (const key of ['insights', 'research_insights', 'researchInsights', 'items', 'data']) {
      if (Array.isArray(record[key])) {
        list = record[key] as unknown[];
        break;
      }
    }
    if (!list.length && (typeof record.topic === 'string' || typeof record.summary === 'string')) {
      list = [record];
    }
  }
  return list.map((item) => normalizeResearchInsight(item, searchResults)) as ResearchInsight[];
}

function normalizeResearchInsight(item: unknown, searchResults: ResearchSearchGroup[]): unknown {
  if (!item || typeof item !== 'object') return item;
  const record = item as Record<string, unknown>;
  const sourceValue = record.sources ?? record.references ?? record.citations
    ?? record.source_urls ?? record.sourceUrls ?? record.source;
  const sourceItems = Array.isArray(sourceValue)
    ? sourceValue
    : sourceValue === undefined || sourceValue === null ? [] : [sourceValue];
  let sources = sourceItems.map(normalizeResearchSource).filter((source): source is { title: string; url: string } => Boolean(source));
  if (!sources.length) sources = fallbackResearchSources(String(record.topic ?? ''), searchResults);
  return { ...record, sources };
}

function normalizeResearchSource(value: unknown): { title: string; url: string } | null {
  if (typeof value === 'string') {
    return isHttpUrl(value) ? { title: value, url: value } : null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const url = String(record.url ?? record.link ?? record.href ?? '').trim();
  if (!isHttpUrl(url)) return null;
  const title = String(record.title ?? record.name ?? record.label ?? url).trim();
  return { title: title || url, url };
}

function fallbackResearchSources(topic: string, groups: ResearchSearchGroup[]): { title: string; url: string }[] {
  const keywordGroups = topic.includes('财务')
    ? ['融资', '财务', '营收']
    : topic.includes('产品') || topic.includes('技术')
      ? ['专利', '技术', '产品', 'github', 'open source']
      : topic.includes('组织') || topic.includes('人才')
        ? ['招聘', '合作', '收购', '并购']
        : ['市场', '产品', '合作'];
  const relevant = groups.filter((group) => keywordGroups.some((keyword) => group.query.toLowerCase().includes(keyword.toLowerCase())));
  const pool = (relevant.length ? relevant : groups).flatMap((group) => group.results);
  const seen = new Set<string>();
  return pool
    .filter((result) => isHttpUrl(result.link) && !seen.has(result.link) && seen.add(result.link))
    .slice(0, 2)
    .map((result) => ({ title: result.title || result.link, url: result.link }));
}

function isHttpUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** 上报产物到服务端（带 X-Agent-ID） */
async function postArtifact(
  agentId: string,
  info: NonNullable<ReturnType<typeof parseCiTags>>,
  parsed: unknown,
  taskId: string,
  pages: ExtractedPage[] = []
): Promise<number> {
  const competitorId = info.competitorId;
  const base = { competitor_id: competitorId, task_id: taskId, round: info.round };
  switch (info.stage) {
    case 'monitor': {
      const changes = parsed as CompetitorChange[];
      const result = await apiAsAgent<{ inserted: number }>(agentId, '/api/ci/changes', {
        method: 'POST',
        body: { ...base, changes },
      });
      if (info.runId) {
        for (const change of changes) {
          const evidenceId = pages.find((p) => p.url === change.url)?.evidenceId;
          if (!evidenceId) continue;
          await apiAsAgent(agentId, '/api/claims', {
            method: 'POST',
            body: {
              run_id: info.runId,
              statement: [change.title, change.summary].filter(Boolean).join('：'),
              subject: change.competitor || competitorId,
              claim_type: change.change_type === 'pricing' ? 'price' : change.change_type,
              confidence: 0.7,
              evidence_ids: [evidenceId],
            },
          });
        }
      }
      return result.inserted;
    }
    case 'research': {
      const list = parsed as ResearchInsight[];
      for (const insight of list) {
        await apiAsAgent(agentId, '/api/ci/insights', {
          method: 'POST',
          body: { ...base, insight },
        });
      }
      return list.length;
    }
    case 'compare':
      await apiAsAgent(agentId, '/api/ci/matrices', {
        method: 'POST',
        body: { ...base, matrix: parsed },
      });
      return 1;
    case 'battlecard':
      await apiAsAgent(agentId, '/api/ci/battlecards', {
        method: 'POST',
        body: { ...base, battlecard: parsed },
      });
      return 1;
    case 'quality':
      await apiAsAgent(agentId, '/api/ci/quality', {
        method: 'POST',
        body: { ...base, quality: parsed },
      });
      return 1;
    default:
      return 0;
  }
}

/**
 * 执行一个 CI stage 任务。执行完上报 completed（monitor 阶段 result 带
 * CHANGES_INSERTED=... 供 orchestrator 判断是否续 research）。
 */
export async function executeCiStage(agentId: string, task: Task, workdir = '.'): Promise<void> {
  const tags = safeParseTags(task.tags);
  const info = parseCiTags(tags);

  // daily_monitor 任务：调服务端遍历 enabled 竞品建 monitor 任务
  if (tags?.includes('daily_monitor') || task.prompt.includes('CI_DAILY_MONITOR')) {
    await apiAsAgent(agentId, '/api/ci/daily-monitor', { method: 'POST' });
    return;
  }
  if (!info?.competitorId) throw new Error('invalid ci task tags');
  if (info.stage === 'daily_monitor') return; // 已在上面处理

  const stage = info.stage; // 窄化为 monitor|research|compare|battlecard|quality
  logger.info('ci', `▶ stage=${stage} competitor=${info.competitorId} round=${info.round}`);
  const context = await fetchContext(info.competitorId, info.runId);
  // 跨进程上下文：orchestrator 在任务 prompt 里写入的质检反馈（Reflexion 回炉用）
  const feedback = extractFeedback(task.prompt);
  const toolData = await runStageTools(agentId, stage, context, info.runId);
  const prompt = buildStagePrompt(stage, {
    competitor: context.competitor,
    ourProfile: context.competitorOnly ? undefined : context.ourProfile,
    latestChanges: context.latestChanges,
    latestInsights: context.latestInsights,
    matrix: context.matrix,
    battlecard: context.battlecard,
    comparisonCompetitors: context.comparisonCompetitors,
    comparisonInsights: context.comparisonInsights,
    competitorOnly: context.competitorOnly,
    feedback: feedback ?? context.feedback ?? undefined,
    searchResults: toolData.searchResults ?? [],
    pages: toolData.pages,
  });

  // quality 阶段：多 agent 测评（3 评审并行），不走单 agent 调用
  if (stage === 'quality') {
    const battlecard = context.battlecard;
    if (!battlecard) throw new Error('no battlecard to grade');
    const agg = await runQualityJudges(context.competitor, battlecard);
    // 直接上报聚合结果（不经过单 agent 的 postArtifact）
    await apiAsAgent(agentId, `/api/ci/quality`, {
      method: 'POST',
      body: { competitor_id: info.competitorId, round: info.round, task_id: task.id, quality: agg },
    });
    await apiAsAgent(agentId, `/api/tasks/${task.id}/status`, {
      method: 'PATCH',
      body: { status: 'completed', result: `[CI quality] 3 评审聚合分 ${agg.score}/10` },
    });
    return;
  }

  const output = await ciRunAgent(stage, prompt, () => {}, workdir, context.competitorOnly);
  const parsed = parseStageOutput(stage, output, context.competitor, toolData.searchResults ?? []);
  const count = await postArtifact(agentId, info, parsed, task.id, toolData.pages ?? []);

  // 上报 completed；monitor 阶段带 CHANGES_INSERTED
  const resultSuffix = stage === 'monitor' ? `\nCHANGES_INSERTED=${count}` : '';
  await apiAsAgent(agentId, `/api/tasks/${task.id}/status`, {
    method: 'PATCH',
    body: { status: 'completed', result: `[CI ${info.stage}] 已落库 ${count} 条${resultSuffix}` },
  });
}

function safeParseTags(tagsJson: string | null): string[] | null {
  if (!tagsJson) return null;
  try {
    const parsed = JSON.parse(tagsJson);
    return Array.isArray(parsed) ? parsed.map(String) : null;
  } catch {
    return null;
  }
}

function parseMonitorUrls(competitor: Competitor): string[] {
  if (competitor.monitor_urls) {
    try {
      const urls = JSON.parse(competitor.monitor_urls) as string[];
      if (Array.isArray(urls) && urls.length > 0) return urls;
    } catch { /* ignore */ }
  }
  return competitor.website ? [competitor.website] : [];
}

export function sourceAllowed(raw: string, policy: { included: string[]; excluded: string[] }): boolean {
  let host: string;
  try { host = new URL(raw).hostname.toLowerCase(); } catch { return false; }
  const matches = (rule: string) => {
    const normalized = rule.toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
    return host === normalized || host.endsWith(`.${normalized}`);
  };
  const domainRules = (rules: string[]) => rules.filter((rule) => /^https?:\/\//i.test(rule) || rule.includes('.'));
  const excludedDomains = domainRules(policy.excluded);
  const includedDomains = domainRules(policy.included);
  if (excludedDomains.some(matches)) return false;
  return includedDomains.length === 0 || includedDomains.some(matches);
}

const ANTI_BOT_DOMAINS = [
  'tmall.com', 'taobao.com', 'jd.com', 'pinduoduo.com', '1688.com',
  'xiaohongshu.com', 'douyin.com', 'weibo.com',
];

export function isAntiBotUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return ANTI_BOT_DOMAINS.some((domain) => host === domain || host.endsWith('.' + domain));
  } catch {
    return true;
  }
}

/** 从任务 prompt 占位说明中提取 [CI feedback=...]（Reflexion 回炉反馈） */
function extractFeedback(prompt: string): string | null {
  const m = prompt.match(/\[CI feedback=(.+)\]$/);
  return m ? m[1].trim() : null;
}

/**
 * 从评审输出 JSON 中提取分数。DeepSeek 输出字段名不稳定：
 * 可能是 score / *_score / 评分 / rating。返回合法 1-10 分或 null。
 */
function extractScore(parsed: Record<string, unknown> | null): number | null {
  if (!parsed) return null;
  const candidates: unknown[] = [
    parsed.score,
    parsed.rating,
    parsed['评分'],
    parsed.completeness_score,
    parsed.accuracy_score,
    parsed.actionable_score,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (!Number.isFinite(n)) continue;
    // 0-1 区间（如 0.2）→ 乘 10 换算到 1-10
    const score = n > 0 && n <= 1 ? Math.round(n * 10) : n;
    if (score >= 1 && score <= 10) return score;
  }
  return null;
}
