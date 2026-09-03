import type { StageKind } from './models.js';

// 展示常量：与 packages/domain/src/analysis.ts、packages/contracts/src/constants.ts 对齐。

// run / stage / review 状态 → Badge tone（全部落在已有 badge--* class 内）
export const STATUS_TONE: Record<string, string> = {
  published: 'success', verified: 'success', completed: 'success',
  running: 'info', queued: 'info',
  waiting_review: 'warning', pending: 'warning', disputed: 'warning',
  failed: 'danger', rejected: 'danger',
  expired: 'neutral', cancelled: 'neutral', draft: 'neutral',
};

export const RUN_LABELS: Record<string, string> = {
  draft: '草稿', queued: '排队中', running: '运行中', waiting_review: '等待人工核验',
  published: '已完成', failed: '失败', cancelled: '已取消',
};

export const STAGE_LABELS: Record<string, string> = {
  monitor: '监测', research: '研究', compare: '对比', battlecard: '战卡', quality: '质检',
  daily_monitor: '每日监控',
};

export const REVIEW_LABELS: Record<string, string> = {
  pending: '待核验', verified: '已通过', rejected: '已驳回', disputed: '争议', expired: '已过期',
};

export const PROJECT_STATUS_LABELS: Record<string, string> = {
  active: '进行中', paused: '已暂停', archived: '已归档', draft: '草稿', completed: '已完成',
};

export const PURPOSE_LABELS: Record<string, string> = {
  pricing: '定价', product: '产品', battlecard: '战卡', market_entry: '市场进入',
  comprehensive: '综合', competitor_only: '竞品专项',
};

export const CLAIM_TYPE_LABELS: Record<string, string> = {
  general: '一般', pricing: '价格', market_share: '市占率', sales: '销量', product: '产品',
};

export const STAGE_ORDER: StageKind[] = ['monitor', 'research', 'compare', 'battlecard', 'quality'];

export const STAGE_PROGRESS: Record<StageKind, number> = {
  monitor: 20, research: 40, compare: 60, battlecard: 80, quality: 100,
};

export const SOURCE_LABELS: Record<string, string> = {
  official: '官方', news: '新闻', website: '网站', social: '社交', forum: '论坛', review: '评测',
};
