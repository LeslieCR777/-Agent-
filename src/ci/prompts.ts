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
    `严重度 severity 判断准则（从严，宁可高估不可漏报）：`,
    `- critical：整页下架/产品线停售、重大安全事件、核心服务中断`,
    `- high：定价变动≥10%、批量扩招(≥5个岗位)、融资/并购/战略合作、新市场进入、威胁我方产品定位的重大功能发布`,
    `- medium：单岗位招聘、常规功能更新、普通新闻、定价微调(<10%)`,
    `- low：博客文章、装饰性改动、无明显商业影响`,
    ``,
    `raw_data 结构：{"url":"...","text":"变化原文片段(50-200字)","pricing_change":{"old":"...","new":"..."},"hiring_count":N}（仅填检测到的字段）`,
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
  // 用户自填的已知信息（notes 里常含价格/规格/销量等一手数据）
  const knownBlock = competitor.notes ? `\n用户提供的已知信息（优先采信）：${competitor.notes}\n` : '';
  return [
    `你是一名竞品市场研究分析师。请基于已检测到的竞品变化、用户提供的已知信息、搜索结果，对「${competitor.name}」做深度调研。`,
    ``,
    `调研方法：对每个主题先推理再下结论——先列出关键证据（变化/搜索命中），再推断对我方的影响。每条结论必须能回溯到来源，禁止臆造。`,
    ``,
    `已检测到的变化：\n${changesText}`,
    `${knownBlock}`,
    `搜索结果：\n${searchText}${feedbackBlock}`,
    ``,
    `输出 JSON 数组，每个元素：{"topic":"调研主题","summary":"两到三句话摘要","key_findings":["要点1","要点2"],"impact":"对我方的影响评估（一句话，含影响方向与程度）","sources":[{"title":"来源标题","url":"URL"}],"confidence":0到1之间的数字}。`,
    `覆盖至少 4 个主题，每个主题聚焦一个子问题：`,
    `  1. 财务状况：近期融资/营收/估值信号？资金来源与用途？`,
    `  2. 产品与技术：新功能/技术栈/开源动态？对我方产品定位的威胁或机会？`,
    `  3. 市场与竞争：定价策略/市场份额/客户口碑？目标客群重合度？`,
    `  4. 组织与人才：招聘规模/高管变动/扩张信号？反映何种战略意图？`,
    `confidence 反映证据充分度：仅凭搜索摘要=0.5-0.6，有明确来源佐证=0.7-0.9。`,
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
    `输出 JSON：{"competitor_positioning":"竞品定位一句话概括（基于调研，不要臆造）","market_gap":"我方可切入的市场空白机会（一句话，基于对比矩阵中我方优势维度）","our_strengths":["我方优势1"],"our_weaknesses":["我方劣势1"],"competitor_strengths":["竞品优势1"],"competitor_weaknesses":["竞品劣势1"],"key_differentiators":["关键差异化1"],"objection_handling":{"客户可能的顾虑":"具体应答话术"},"elevator_pitch":"30秒电梯陈述"}。`,
    `要求：`,
    `- 每条 3-6 项；差异化要具体可验证（引用对比矩阵的分差或调研来源）`,
    `- 异议处理话术用 3 段式：先承认顾虑 → 再转译（把竞品优势转化为我方差异化场景）→ 最后给证据`,
    `- elevator_pitch 面向目标客户（${ourProfile.targetMarket || '未配置'}），30 秒内讲清"我们比竞品更适合你"`,
    `- competitor_positioning 与 market_gap 必须基于给定数据，禁止臆造`,
    JSON_ONLY,
  ].join('\n');
}

// ── quality（Reflexion 质检）───────────────────────────

/**
 * quality 阶段多 agent 评审 prompt。focus 指定评审视角（多 agent 测评时每个 judge 各执一视角）：
 *  - accuracy：准确性（是否基于给定数据、无臆造、数据可溯源）
 *  - completeness：完整性（8 维覆盖、字段齐全、场景完整）
 *  - actionable：销售可用性（话术可直接开口、差异化可验证、有说服力）
 * 多 agent 时各 judge 只评自己视角，聚合取均值 → 避免单评审偏见。
 */
export function buildQualityPrompt(
  competitor: Competitor,
  battlecard: Battlecard,
  focus?: 'accuracy' | 'completeness' | 'actionable'
): string {
  const focusRule: Record<string, string> = {
    accuracy: '本评审重点：准确性。核查战卡每一条是否基于给定数据、无臆造、可溯源；发现臆造/夸大记低分。',
    completeness: '本评审重点：完整性。核查是否覆盖我方/竞品优势劣势、关键差异化、异议处理、电梯陈述全部字段；缺项记低分。',
    actionable: '本评审重点：销售可用性。核查话术是否销售能直接开口说、差异化是否具体可验证、电梯陈述是否 30 秒可讲清。',
  };
  const rule = focus ? focusRule[focus] : focusRule.actionable;
  return [
    `你是一名竞品情报评审员。请评审下面针对「${competitor.name}」的 battlecard 质量。`,
    ``,
    `评审标准：`,
    `1. 完整性（0-10）：覆盖优势/劣势/差异化/异议处理/电梯陈述全部字段，场景完整`,
    `2. 准确性（0-10）：基于给定数据、无臆造、可溯源`,
    `3. 可执行性（0-10）：销售能否直接使用，话术可直接开口`,
    ``,
    `${rule}`,
    ``,
    `待评审 battlecard：`,
    JSON.stringify(battlecard, null, 2),
    ``,
    `输出 JSON：{"score":1-10,"feedback":"具体改进建议（指出缺失或可加强的要点，本视角优先）"}。`,
    `score 要从严：有明显缺陷 ≤6，达到销售可用标准 7-8，无可挑剔 9-10。`,
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
