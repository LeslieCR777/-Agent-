import { createEvalCase } from '@api/db/queries/eval.js';
import type { EvalCase, EvalStage } from '@contracts/types.js';

/**
 * 黄金测试集生成器：模板批量生成 eval_cases。
 * 确定性种子 RNG（mulberry32）保证可复现；变体池 × count 乘数 → 100-500 条可达。
 */

// ── 确定性 RNG ────────────────────────────────────────

function hashSeed(seed: string): number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

export function mulberry32(seed: string): () => number {
  let a = hashSeed(seed);
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── 变体池 ────────────────────────────────────────────

const COMPETITORS = ['智云SaaS', 'CloudNova', '飞雁科技', '星链数据', '天穹软件', '云帆智能'];
const PRICES = ['¥399/月', '¥599/月', '¥649/月', '¥1299/月', '¥1999/月', '¥4999/年', '¥2999/年', '¥899/月'];
const FEATURES = ['AI 助手', '多代理协作', '实时看板', '智能预警', '数据中台', '低代码平台'];
const MARKETS = ['东南亚市场', '欧洲市场', '北美市场', '国内下沉市场', '日韩市场'];
const CHANGES = ['定价调整', '新功能发布', '招聘扩招', '专利申请', '融资完成', '市场扩张'];

export interface TemplateCtx {
  idx: number;          // 全局序号（第几条）
  rng: () => number;    // [0,1) 随机
  seed: string;
  pick: <T>(arr: readonly T[]) => T; // 随机取一个
  pickN: <T>(arr: readonly T[], n: number) => T[];
  int: (min: number, max: number) => number;
}

export interface GeneratedCase {
  category: string;
  stage: EvalStage;
  scenario: string;
  prompt: string;       // 机器可读输入（JSON）
  ground_truth: string; // 期望输出
  competitor?: { name: string; notes?: string; monitor_urls?: string[] }; // pipeline 竞品 seed
}

export interface ScenarioTemplate {
  category: string;
  stages: EvalStage[];
  build(ctx: TemplateCtx): GeneratedCase;
}

function makeCtx(seed: string, idx: number): TemplateCtx {
  const rng = mulberry32(`${seed}:${idx}`);
  return {
    idx, rng, seed,
    pick: <T,>(arr: readonly T[]) => arr[Math.floor(rng() * arr.length)],
    pickN: <T,>(arr: readonly T[], n: number) => {
      const copy = [...arr];
      const out: T[] = [];
      while (out.length < n && copy.length) {
        out.push(copy.splice(Math.floor(rng() * copy.length), 1)[0]);
      }
      return out;
    },
    int: (min: number, max: number) => Math.floor(rng() * (max - min + 1)) + min,
  };
}

// ── 场景模板 ──────────────────────────────────────────

export const SCENARIO_TEMPLATES: ScenarioTemplate[] = [
  {
    category: 'pricing_change', stages: ['monitor', 'pipeline'],
    build: (ctx) => {
      const comp = ctx.pick(COMPETITORS);
      const oldPrice = ctx.pick(PRICES);
      const newPrice = ctx.pick(PRICES.filter((p) => p !== oldPrice));
      const pct = ctx.int(3, 30);
      const scenario = `SaaS 竞品「${comp}」Pro 方案月费从 ${oldPrice} 涨到 ${newPrice}（+${pct}%）`;
      const groundTruth = `应输出 pricing 变化，severity=${pct >= 10 ? 'high' : 'medium'}（涨幅${pct >= 10 ? '≥10%' : '<10%'}），raw_data.pricing_change 含 old/new，摘要准确提及 ${pct}% 涨幅`;
      return {
        category: 'pricing_change', stage: ctx.pick(['monitor', 'pipeline']),
        scenario, ground_truth: groundTruth,
        prompt: JSON.stringify({
          competitor: { name: comp, notes: `用户自填：${oldPrice} → ${newPrice}，涨幅 ${pct}%` },
          monitor_urls: ['https://eval.example/pricing'],
          changes: [{ severity: pct >= 10 ? 'high' : 'medium', change_type: 'pricing', title: '价格调整', summary: `月费从 ${oldPrice} 涨到 ${newPrice}` }],
        }),
        competitor: { name: comp, notes: `用户自填：${oldPrice} → ${newPrice}，涨幅 ${pct}%`, monitor_urls: ['https://eval.example/pricing'] },
      };
    },
  },
  {
    category: 'new_product', stages: ['monitor', 'pipeline'],
    build: (ctx) => {
      const comp = ctx.pick(COMPETITORS);
      const feat = ctx.pick(FEATURES);
      const scenario = `竞品「${comp}」发布${feat}新功能，主打企业客户`;
      return {
        category: 'new_product', stage: ctx.pick(['monitor', 'pipeline']),
        scenario,
        ground_truth: `输出 product 变化，severity 按影响判断（威胁我方定位→high），摘要点明「面向企业客户的${feat}」`,
        prompt: JSON.stringify({
          competitor: { name: comp, notes: `发布${feat}新功能` },
          monitor_urls: ['https://eval.example/product'],
          changes: [{ severity: 'high', change_type: 'product', title: `发布${feat}`, summary: `面向企业客户推出${feat}` }],
        }),
        competitor: { name: comp, notes: `发布${feat}新功能`, monitor_urls: ['https://eval.example/product'] },
      };
    },
  },
  {
    category: 'hiring_signal', stages: ['monitor', 'research'],
    build: (ctx) => {
      const comp = ctx.pick(COMPETITORS);
      const n = ctx.int(5, 12);
      const scenario = `「${comp}」一周内挂出 ${n} 个岗位（含 ${ctx.int(2, 5)} 高级工程师），扩招信号`;
      return {
        category: 'hiring_signal', stage: ctx.pick(['monitor', 'research']),
        scenario,
        ground_truth: `输出 hiring 变化 severity=high（批量≥5），raw_data.hiring_count=${n}；research 阶段应在「组织与人才」主题点出扩张意图`,
        prompt: JSON.stringify({
          competitor: { name: comp },
          changes: [{ severity: 'high', change_type: 'hiring', title: '批量扩招', summary: `${n} 个岗位` }],
          searchResults: [{ query: `${comp} 招聘`, results: [{ title: `${comp} 扩招`, link: 'https://eval.example/jobs', snippet: `${n} 个岗位` }] }],
        }),
        competitor: { name: comp, notes: `一周内挂出 ${n} 个岗位`, monitor_urls: ['https://eval.example/careers'] },
      };
    },
  },
  {
    category: 'patent_move', stages: ['research'],
    build: (ctx) => {
      const comp = ctx.pick(COMPETITORS);
      const tech = ctx.pick(['基于大模型的多代理协作', '边缘计算实时推理', '联邦学习数据中台']);
      const scenario = `竞品「${comp}」申请「${tech}」专利`;
      return {
        category: 'patent_move', stage: 'research',
        scenario,
        ground_truth: `research 覆盖 4 主题，产品与技术主题至少一条命中专利，confidence 0.7+，sources 含来源 URL`,
        prompt: JSON.stringify({
          competitor: { name: comp },
          changes: [{ severity: 'medium', change_type: 'patent', title: `申请${tech}专利`, summary: `专利动向` }],
          searchResults: [{ query: `${comp} 专利`, results: [{ title: `${comp} ${tech}专利`, link: 'https://eval.example/patent', snippet: '专利公开' }] }],
        }),
        competitor: { name: comp, notes: `申请${tech}专利` },
      };
    },
  },
  {
    category: 'funding_event', stages: ['research'],
    build: (ctx) => {
      const comp = ctx.pick(COMPETITORS);
      const amount = ctx.pick(['5000 万美元 B 轮', '1 亿人民币 A 轮', '2 亿美元 C 轮']);
      const purpose = ctx.pick(['全球化扩张', '技术研发', '市场推广']);
      const scenario = `「${comp}」完成 ${amount}，用于${purpose}`;
      return {
        category: 'funding_event', stage: 'research',
        scenario,
        ground_truth: `财务状况主题有结论：金额、轮次、用途、对我方影响方向（威胁/机会）一句话`,
        prompt: JSON.stringify({
          competitor: { name: comp },
          changes: [{ severity: 'high', change_type: 'news', title: `完成${amount}`, summary: `${purpose}` }],
          searchResults: [{ query: `${comp} 融资`, results: [{ title: `${comp} 完成 ${amount}`, link: 'https://eval.example/funding', snippet: `${purpose}` }] }],
        }),
        competitor: { name: comp, notes: `完成 ${amount}，用于${purpose}` },
      };
    },
  },
  {
    category: 'market_research', stages: ['research'],
    build: (ctx) => {
      const comp = ctx.pick(COMPETITORS);
      const market = ctx.pick(MARKETS);
      const discount = ctx.int(20, 40);
      const scenario = `竞品「${comp}」进入${market}，定价低于国内 ${discount}%`;
      return {
        category: 'market_research', stage: 'research',
        scenario,
        ground_truth: `4 主题全覆盖，市场与竞争主题命中${market}/低价策略，impact 含对我方目标客群重叠度判断`,
        prompt: JSON.stringify({
          competitor: { name: comp },
          changes: [{ severity: 'medium', change_type: 'news', title: `进入${market}`, summary: `定价低于国内 ${discount}%` }],
          searchResults: [{ query: `${comp} ${market}`, results: [{ title: `${comp} 进军${market}`, link: 'https://eval.example/market', snippet: `低价 ${discount}%` }] }],
        }),
        competitor: { name: comp, notes: `进入${market}，定价低 ${discount}%` },
      };
    },
  },
  {
    category: 'compare_matrix', stages: ['compare'],
    build: (ctx) => {
      const comp = ctx.pick(COMPETITORS);
      const insightTopic = ctx.pick(FEATURES);
      return {
        category: 'compare_matrix', stage: 'compare',
        scenario: `我方「我们的产品」vs 竞品「${comp}」在 8 维打分`,
        ground_truth: `dimensions 恰 8 个且维度名匹配模板，评分合理（有证据），overall_assessment 3 句话`,
        prompt: JSON.stringify({
          competitor: { name: comp },
          insights: [{ topic: insightTopic, summary: '竞品在此维度有进展', confidence: 0.8 }],
        }),
      };
    },
  },
  {
    category: 'battlecard_gen', stages: ['battlecard'],
    build: (ctx) => {
      const comp = ctx.pick(COMPETITORS);
      const differentiator = ctx.pick(['TCO 低 30%', '本地化支持', '交付快一倍', '免费迁移']);
      return {
        category: 'battlecard_gen', stage: 'battlecard',
        scenario: `基于矩阵+洞察为「${comp}」生成销售战卡`,
        ground_truth: `字段齐全（our/competitor strengths+weaknesses、key_differentiators、objection_handling、elevator_pitch），差异化可验证、引用矩阵分差，话术 3 段式`,
        prompt: JSON.stringify({
          competitor: { name: comp },
          matrix: { dimensions: [{ dimension: 'Pricing & Value', our_score: 8, competitor_score: 6, notes: `${differentiator}` }], overall_assessment: '我方在定价维度领先' },
          insights: [{ topic: '市场', summary: '竞品主打大客户' }],
        }),
      };
    },
  },
  {
    category: 'quality_check', stages: ['quality'],
    build: (ctx) => {
      const comp = ctx.pick(COMPETITORS);
      const weakness = ctx.pick(['差异化不明确', '缺数据支撑', '话术生硬']);
      return {
        category: 'quality_check', stage: 'quality',
        scenario: `评审一份针对「${comp}」的战卡质量`,
        ground_truth: `score 1-10 且按准确性/完整性/可执行性给出 ≥1 条具体改进建议`,
        prompt: JSON.stringify({
          competitor: { name: comp },
          battlecard: { our_strengths: ['性价比高'], our_weaknesses: ['品牌弱'], competitor_strengths: ['市场大'], competitor_weaknesses: ['价格高'], key_differentiators: ['TCO低'], objection_handling: { '太贵': '我们更省' }, elevator_pitch: '更低成本' },
        }),
      };
    },
  },
];

// ── 生成入口 ──────────────────────────────────────────

export interface GenerateOptions {
  categories?: string[];
  count?: number;
  seed?: string;
}

/** 生成（不入库）GeneratedCase 列表 */
export function generateCases(opts: GenerateOptions = {}): GeneratedCase[] {
  const count = opts.count ?? 20;
  const seed = opts.seed ?? 'eval-seed';
  const categories = opts.categories?.length
    ? SCENARIO_TEMPLATES.filter((t) => opts.categories!.includes(t.category))
    : SCENARIO_TEMPLATES;
  const out: GeneratedCase[] = [];
  // 轮转每个模板，保证类别均衡
  let t = 0;
  for (let i = 0; i < count; i++) {
    const template = categories[t % categories.length];
    t++;
    out.push(template.build(makeCtx(seed, i)));
  }
  return out;
}

/** 生成并入库为 EvalCase 行 */
export async function generateCaseRows(opts: GenerateOptions = {}): Promise<EvalCase[]> {
  const cases = generateCases(opts);
  const rows: EvalCase[] = [];
  for (const c of cases) {
    rows.push(await createEvalCase({
      scenario: c.scenario,
      stage: c.stage,
      prompt: c.prompt,
      ground_truth: c.ground_truth,
      category: c.category,
    }));
  }
  return rows;
}
