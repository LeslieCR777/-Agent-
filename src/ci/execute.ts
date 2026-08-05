import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { api, apiAsAgent } from '../worker/client.js';
import { runAgent } from '../worker/runner.js';
import { isDemo, demoAgentOutput } from './demo.js';
import { parseCiTags } from './orchestrator.js';
import { parseJsonArray, parseJsonBlock } from './parse.js';
import { buildStagePrompt, buildQualityPrompt, type ExtractedPage } from './prompts.js';
import { contentHash } from './tools/hash.js';
import { fetchPage } from './tools/http.js';
import { extractText, extractPricing, extractJobListings } from './tools/extract.js';
import { webSearch } from './tools/search.js';
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
} from '../shared/types.js';

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
  latestChanges: CompetitorChangeRow[];
  latestInsights: ResearchInsightRow[];
  matrix: ComparisonMatrix | null;
  battlecard: Battlecard | null;
  feedback: string | null;
}

/** 拉取该 stage 需要的上下文（HTTP GET，服务端产品接口是普通查询不需要 agent） */
async function fetchContext(competitorId: string): Promise<CiContext> {
  const [comp, changes, insights, matrix, battlecard] = await Promise.all([
    api<{ competitor: Competitor }>(`/api/competitors/${competitorId}`).catch(() => null),
    api<{ changes: CompetitorChangeRow[] }>(`/api/ci/competitors/${competitorId}/changes?limit=20`).catch(() => ({ changes: [] })),
    api<{ insights: ResearchInsightRow[] }>(`/api/ci/competitors/${competitorId}/insights`).catch(() => ({ insights: [] })),
    api<{ matrix: ComparisonMatrix | null }>(`/api/ci/competitors/${competitorId}/matrices`).catch(() => ({ matrix: null })),
    api<{ battlecards: Battlecard[] }>(`/api/ci/competitors/${competitorId}/battlecards?limit=1`).catch(() => ({ battlecards: [] })),
  ]);

  if (!comp?.competitor) throw new Error('competitor not found');
  return {
    competitor: comp.competitor,
    ourProfile: config.ourProduct,
    latestChanges: changes.changes,
    latestInsights: insights.insights,
    matrix: matrix?.matrix ?? null,
    battlecard: battlecard?.battlecards?.[0] ?? null,
    feedback: null,
  };
}

/** monitor 搜索阶段：从竞品监控 URL 抓取并哈希快筛（三级检测第一/二级） */
async function runMonitorTools(agentId: string, competitor: Competitor): Promise<ExtractedPage[]> {
  const urls = parseMonitorUrls(competitor);
  const pages: ExtractedPage[] = [];
  for (const url of urls) {
    try {
      const page = await fetchPage(url);
      const hash = contentHash(page.html);
      // 服务端哈希快筛：changed=true 才值得做结构化抽取 + LLM 分类
      const { changed } = await apiAsAgent<{ changed: boolean }>(agentId, '/api/ci/pages/check', {
        method: 'POST',
        body: { competitor_id: competitor.id, url, sha256: hash, title: extractText(page.html).slice(0, 120) },
      });
      pages.push({
        url,
        changed,
        text: changed ? extractText(page.html) : '',
        pricing: changed ? extractPricing(page.html) : [],
        jobs: changed ? extractJobListings(page.html) : [],
      });
      logger.info('ci', `monitor ${url} ${changed ? 'CHANGED' : 'unchanged'}`);
    } catch (err) {
      logger.warn('ci', `monitor ${url} failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  return pages;
}

/** research 搜索阶段：5 类线索各 2 条搜索 */
async function runResearchTools(competitor: Competitor): Promise<{ query: string; results: { title: string; link: string; snippet: string }[] }[]> {
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
      out.push({ query: q, results });
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
): Promise<{ pages?: ExtractedPage[]; searchResults?: { query: string; results: { title: string; link: string; snippet: string }[] }[] }> {
  switch (stage) {
    case 'monitor':
      return { pages: await runMonitorTools(agentId, context.competitor) };
    case 'research':
      return { searchResults: await runResearchTools(context.competitor) };
    default:
      return {};
  }
}

/** 调用 LLM agent：demo 桩 或 真 claude CLI */
async function ciRunAgent(
  stage: Exclude<CiStage, 'daily_monitor'>,
  prompt: string,
  onLog: (line: string) => void,
  workdir: string
): Promise<string> {
  if (isDemo()) {
    logger.info('ci', `demo mode: ${stage} stage uses stub output`);
    return demoAgentOutput(stage, null);
  }
  const result = await runAgent(prompt, { onLog }, { cwd: workdir });
  if (result.timedOut) throw new Error('agent timed out');
  if (result.exitCode !== 0) throw new Error(`agent exit ${result.exitCode}`);
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
  competitor: Competitor
): unknown {
  switch (stage) {
    case 'monitor': {
      const changes = parseJsonArray<CompetitorChange>(output) ?? [];
      return changes;
    }
    case 'research': {
      const insights = parseJsonArray<ResearchInsight>(output) ?? [];
      return insights;
    }
    case 'compare': {
      const matrix = parseJsonBlock<ComparisonMatrix>(output);
      if (!matrix || !Array.isArray(matrix.dimensions)) throw new Error('parse compare matrix failed');
      return matrix;
    }
    case 'battlecard': {
      const bc = parseJsonBlock<Battlecard>(output);
      if (!bc || !Array.isArray(bc.our_strengths)) throw new Error('parse battlecard failed');
      return bc;
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

/** 上报产物到服务端（带 X-Agent-ID） */
async function postArtifact(
  agentId: string,
  info: NonNullable<ReturnType<typeof parseCiTags>>,
  parsed: unknown,
  taskId: string
): Promise<number> {
  const competitorId = info.competitorId;
  const base = { competitor_id: competitorId, task_id: taskId, round: info.round };
  switch (info.stage) {
    case 'monitor':
      return (await apiAsAgent<{ inserted: number }>(agentId, '/api/ci/changes', {
        method: 'POST',
        body: { ...base, changes: parsed },
      })).inserted;
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
  const context = await fetchContext(info.competitorId);
  // 跨进程上下文：orchestrator 在任务 prompt 里写入的质检反馈（Reflexion 回炉用）
  const feedback = extractFeedback(task.prompt);
  const toolData = await runStageTools(agentId, stage, context);
  const prompt = buildStagePrompt(stage, {
    competitor: context.competitor,
    ourProfile: context.ourProfile,
    latestChanges: context.latestChanges,
    latestInsights: context.latestInsights,
    matrix: context.matrix,
    battlecard: context.battlecard,
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

  const output = await ciRunAgent(stage, prompt, () => {}, workdir);
  const parsed = parseStageOutput(stage, output, context.competitor);
  const count = await postArtifact(agentId, info, parsed, task.id);

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
