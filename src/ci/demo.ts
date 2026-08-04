import { config } from '../shared/config.js';
import type { CiStage } from '../shared/types.js';

/**
 * Demo 模式：无任何 API key 也能跑通全链路（镜像参考项目 demo mode）。
 * - fetch 返回确定性桩 HTML（含 ¥299/月、招聘链接）
 * - search 返回 2-3 条桩结果
 * - agent 返回各 stage 可解析的样例 JSON（替代 claude CLI 输出）
 */

export function isDemo(): boolean {
  return config.ciDemoMode || (!config.serpApi.key && !config.smtp.host);
}

// ── 桩数据 ─────────────────────────────────────────────

const STUB_HTML = `<!doctype html><html><head><title>Demo Competitor Pricing</title></head><body>
  <h1>Demo 竞品 A 定价</h1>
  <div class="plan">Starter 方案 ¥299/月，含 3 个席位</div>
  <div class="plan">Pro 方案 ¥699/月，含 10 个席位</div>
  <div class="plan">Enterprise 方案 联系我们</div>
  <a href="/careers">加入我们</a><a href="/jobs/senior-engineer">高级工程师</a>
  <p>本季度推出全新 AI 助手功能，主打企业客户市场。</p>
</body></html>`;

export function stubFetch(_url: string): { html: string } {
  return { html: STUB_HTML };
}

export function stubSearch(query: string): { title: string; link: string; snippet: string }[] {
  return [
    { title: `【Demo】${query} —— 竞品动态汇总`, link: 'https://example.com/stub/1', snippet: `关于「${query}」的模拟搜索结果，demo 模式下返回固定数据。` },
    { title: 'Demo 竞品 A 完成新一轮融资', link: 'https://example.com/stub/2', snippet: '据 demo 数据，竞品 A 融资 X 元，用于扩展市场。' },
    { title: 'Demo 竞品 A 发布新功能公告', link: 'https://example.com/stub/3', snippet: '新功能聚焦企业客户，与既有产品线形成互补。' },
  ];
}

// ── 各 stage 的 demo agent 输出（可解析的样例 JSON）───

export function demoAgentOutput(stage: CiStage, _context: unknown): string {
  switch (stage) {
    case 'monitor':
      return JSON.stringify([
        {
          competitor: 'Demo 竞品 A',
          change_type: 'pricing',
          title: 'Starter 方案价格调整',
          summary: 'demo 数据：Starter 方案由 ¥299/月 调整为 ¥329/月',
          url: 'https://example.com/pricing',
          severity: 'high',
          raw_data: { plan: 'Starter', old: '¥299/月', now: '¥329/月' },
        },
        {
          competitor: 'Demo 竞品 A',
          change_type: 'hiring',
          title: '新增高级工程师岗位',
          summary: 'demo 数据：招聘 3 名高级工程师，扩招信号',
          url: 'https://example.com/careers',
          severity: 'medium',
          raw_data: { roles: ['senior-engineer'] },
        },
      ]);
    case 'research':
      return JSON.stringify([
        {
          topic: '财务状况',
          summary: 'demo 数据：竞品 A 最近完成融资，现金流健康，用于扩张',
          key_findings: ['新一轮融资到账', '招聘规模扩大'],
          sources: [{ title: 'Demo 融资报道', url: 'https://example.com/stub/2' }],
          confidence: 0.8,
        },
        {
          topic: '产品与技术',
          summary: 'demo 数据：推出 AI 助手新功能，聚焦企业客户',
          key_findings: ['AI 能力补强', '企业市场导向'],
          sources: [{ title: 'Demo 产品公告', url: 'https://example.com/stub/3' }],
          confidence: 0.75,
        },
      ]);
    case 'compare':
      return JSON.stringify({
        dimensions: [
          { dimension: 'Product Features', our_score: 7, competitor_score: 7, notes: 'demo 数据：双方功能接近' },
          { dimension: 'Pricing & Value', our_score: 8, competitor_score: 6, notes: 'demo 数据：我方定价更具性价比' },
          { dimension: 'User Experience', our_score: 7, competitor_score: 7, notes: '' },
          { dimension: 'Market Share & Momentum', our_score: 6, competitor_score: 8, notes: 'demo 数据：竞品增长更快' },
          { dimension: 'Customer Sentiment', our_score: 7, competitor_score: 6, notes: '' },
          { dimension: 'Technology & Innovation', our_score: 7, competitor_score: 8, notes: 'demo 数据：竞品 AI 领先' },
          { dimension: 'Ecosystem & Integrations', our_score: 6, competitor_score: 7, notes: '' },
          { dimension: 'Support & Documentation', our_score: 8, competitor_score: 7, notes: '' },
        ],
        overall_assessment: 'demo 数据：竞品整体略领先，但定价与支持是我方优势，可针对性突破。',
      });
    case 'battlecard':
      return JSON.stringify({
        our_strengths: ['定价更具性价比', '支持与文档完善'],
        our_weaknesses: ['市场声量较弱', 'AI 能力待补强'],
        competitor_strengths: ['市场增长快', 'AI 创新领先'],
        competitor_weaknesses: ['定价偏高', '企业服务支持一般'],
        key_differentiators: ['性价比', '服务支持'],
        objection_handling: { '竞品功能更多，为什么选我们？': 'demo 数据：我们的核心场景覆盖已足够，且总拥有成本低 30%。' },
        elevator_pitch: 'demo 数据：以更低成本获得企业级支持与稳定交付。',
      });
    case 'quality':
      return JSON.stringify({ score: 8, feedback: 'demo 数据：战卡结构完整、要点清晰，符合销售可用标准。' });
    default:
      return '{}';
  }
}
