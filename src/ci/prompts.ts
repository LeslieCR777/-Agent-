import type { Config } from '../shared/config.js';
import type { Battlecard, CiStage, Competitor, CompetitorChangeRow, ComparisonMatrix, ResearchInsightRow } from '../shared/types.js';

/**
 * CI stage 提示词（中文，输出 JSON）。风格对齐 Lead 的 decompose。
 * 末句固定「只输出 JSON，不要任何其他文字。」（monitor 无变化输出 []）。
 */

const JSON_ONLY = '只输出 JSON，不要任何其他文字。';

// ── monitor ────────────────────────────────────────────

export interface ExtractedPage {
  url: string;
  changed: boolean;
  text: string;
  pricing: { plan: string; price: string }[];
  jobs: { title: string; url: string }[];
}

export function buildMonitorPrompt(competitor: Competitor, pages: ExtractedPage[]): string {
  const changedPages = pages.filter((p) => p.changed);
  if (changedPages.length === 0) {
    return '本次监控所有页面无变化，输出空数组：[]';
  }
  const pageText = changedPages
    .map(
      (p, i) => `## 页面 ${i + 1}: ${p.url}\n--- 纯文本(前4000字) ---\n${p.text.slice(0, 4000)}\n--- 定价线索 ---\n${JSON.stringify(p.pricing, null, 2)}\n--- 招聘线索 ---\n${JSON.stringify(p.jobs, null, 2)}`
    )
    .join('\n\n');
  return [
    `你是一名竞品监控分析师。以下是「${competitor.name}」最近发生变化的页面内容，请识别其中的竞品动态并分类。`,
    ``,
    `变化类型 change_type 取值：pricing(定价) | product(产品/功能) | hiring(招聘/组织) | news(新闻动态) | patent(专利) | blog(技术博客) | open_source(开源动态)。`,
    `严重度 severity 取值：low | medium | high | critical。判断依据：是否直接影响我方销售、威胁产品定位、或反映重大战略动向（融资/并购/大规模扩招 → high 以上）。`,
    ``,
    pageText,
    ``,
    `输出 JSON 数组，每个元素：{"competitor":"${competitor.name}","change_type":"...","title":"一句话标题","summary":"两句话摘要","url":"相关URL","severity":"...","raw_data":{...}}。`,
    `没有值得记录的变化就输出 []。`,
    JSON_ONLY,
  ].join('\n');
}

// ── research ───────────────────────────────────────────

export function buildResearchPrompt(
  competitor: Competitor,
  latestChanges: CompetitorChangeRow[],
  searchResults: { query: string; results: { title: string; link: string; snippet: string }[] }[],
  feedback?: string
): string {
  const changesText =
    latestChanges.length > 0
      ? latestChanges.map((c) => `- [${c.severity}] ${c.title}（${c.change_type}）: ${c.summary ?? ''}`).join('\n')
      : '（无已记录的变化）';
  const searchText = searchResults
    .map((s) => `### 搜索「${s.query}」\n` + s.results.map((r) => `- ${r.title} | ${r.link} | ${r.snippet}`).join('\n'))
    .join('\n\n');
  const feedbackBlock = feedback ? `\n上轮质检反馈（必须优先回应）：${feedback}\n` : '';
  return [
    `你是一名竞品市场研究分析师。请基于已检测到的竞品变化和搜索结果，对「${competitor.name}」做深度调研。`,
    ``,
    `已检测到的变化：\n${changesText}`,
    ``,
    `搜索结果：\n${searchText}${feedbackBlock}`,
    ``,
    `输出 JSON 数组，每个元素：{"topic":"调研主题","summary":"两到三句话摘要","key_findings":["要点1","要点2"],"sources":[{"title":"来源标题","url":"URL"}],"confidence":0到1之间的数字}。`,
    `覆盖至少 3 个主题：财务状况 / 产品与技术 / 市场与竞争 / 组织与人才 等。`,
    JSON_ONLY,
  ].join('\n');
}

// ── compare ────────────────────────────────────────────

const DIMENSIONS = [
  'Product Features',
  'Pricing & Value',
  'User Experience',
  'Market Share & Momentum',
  'Customer Sentiment',
  'Technology & Innovation',
  'Ecosystem & Integrations',
  'Support & Documentation',
];

export function buildComparePrompt(
  ourProfile: Config['ourProduct'],
  competitor: Competitor,
  insights: ResearchInsightRow[]
): string {
  const insightText = insights
    .map((i) => `- ${i.topic}: ${i.summary}（置信度 ${i.confidence}）`)
    .join('\n');
  return [
    `你是一名竞品对比分析师。基于以下调研洞察，在 8 个维度上分别给「我方」和「${competitor.name}」打分（0-10）。`,
    ``,
    `我方产品：${ourProfile.name}${ourProfile.website ? ` (${ourProfile.website})` : ''}\n定位：${ourProfile.positioning || '（未配置）'}\n目标市场：${ourProfile.targetMarket || '（未配置）'}`,
    ``,
    `竞品：${competitor.name}${competitor.website ? ` (${competitor.website})` : ''}`,
    ``,
    `调研洞察：\n${insightText}`,
    ``,
    `8 个维度必须齐全：\n${DIMENSIONS.map((d, i) => `${i + 1}. ${d}`).join('\n')}`,
    ``,
    `输出 JSON：{"dimensions":[{"dimension":"维度名","our_score":0-10,"competitor_score":0-10,"notes":"一句话说明"}],"overall_assessment":"整体评估（3句话）"}。`,
    JSON_ONLY,
  ].join('\n');
}

// ── battlecard ─────────────────────────────────────────

export function buildBattlecardPrompt(
  ourProfile: Config['ourProduct'],
  competitor: Competitor,
  matrix: ComparisonMatrix,
  insights: ResearchInsightRow[]
): string {
  const matrixText = matrix.dimensions
    .map((d) => `- ${d.dimension}: 我方 ${d.our_score} vs 竞品 ${d.competitor_score} ${d.notes ? `(${d.notes})` : ''}`)
    .join('\n');
  const insightText = insights.map((i) => `- ${i.topic}: ${i.summary}`).join('\n');
  return [
    `你是一名销售战卡专家。请为销售团队生成针对「${competitor.name}」的 battlecard（销售作战卡）。`,
    ``,
    `我方产品：${ourProfile.name}（${ourProfile.positioning || '定位未配置'}）`,
    ``,
    `对比矩阵：\n${matrixText}`,
    ``,
    `调研洞察：\n${insightText}`,
    ``,
    `输出 JSON：{"our_strengths":["我方优势1"],"our_weaknesses":["我方劣势1"],"competitor_strengths":["竞品优势1"],"competitor_weaknesses":["竞品劣势1"],"key_differentiators":["关键差异化1"],"objection_handling":{"客户可能的顾虑":"具体应答话术"},"elevator_pitch":"30秒电梯陈述"}。`,
    `要求：每条 3-6 项；差异化要具体可验证；话术要销售能直接开口说。`,
    JSON_ONLY,
  ].join('\n');
}

// ── quality（Reflexion 质检）───────────────────────────

export function buildQualityPrompt(competitor: Competitor, battlecard: Battlecard): string {
  return [
    `你是一名竞品情报质检员。请评审下面针对「${competitor.name}」的 battlecard 质量。`,
    ``,
    JSON.stringify(battlecard, null, 2),
    ``,
    `从三个维度评审（各 0-10 再平均）：完整性（覆盖优势/劣势/差异化/异议处理/电梯陈述）、准确性（是否基于给定数据、无臆造）、可执行性（销售能否直接使用）。`,
    `输出 JSON：{"score":1-10,"feedback":"具体改进建议（指出缺失或可加强的要点）"}。`,
    JSON_ONLY,
  ].join('\n');
}

// ── stage → prompt 构建入口 ────────────────────────────

export function buildStagePrompt(
  stage: Exclude<CiStage, 'daily_monitor'>,
  ctx: { competitor: Competitor; ourProfile: Config['ourProduct']; latestChanges: CompetitorChangeRow[]; latestInsights: ResearchInsightRow[]; matrix: ComparisonMatrix | null; battlecard: Battlecard | null; feedback?: string; searchResults: { query: string; results: { title: string; link: string; snippet: string }[] }[]; pages?: ExtractedPage[] }
): string {
  switch (stage) {
    case 'monitor':
      return buildMonitorPrompt(ctx.competitor, ctx.pages ?? []);
    case 'research':
      return buildResearchPrompt(ctx.competitor, ctx.latestChanges, ctx.searchResults, ctx.feedback);
    case 'compare':
      return buildComparePrompt(ctx.ourProfile, ctx.competitor, ctx.latestInsights);
    case 'battlecard': {
      const matrix = ctx.matrix ?? { dimensions: [], overall_assessment: '（暂无对比矩阵）' };
      return buildBattlecardPrompt(ctx.ourProfile, ctx.competitor, matrix, ctx.latestInsights);
    }
    case 'quality': {
      const bc = ctx.battlecard ?? ({} as Battlecard);
      return buildQualityPrompt(ctx.competitor, bc);
    }
    default:
      throw new Error(`unknown stage: ${stage}`);
  }
}
