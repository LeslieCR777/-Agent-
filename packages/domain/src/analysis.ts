import type { CiStage } from '@contracts/types.js';

export type RunStatus = 'draft' | 'queued' | 'running' | 'waiting_review' | 'published' | 'failed' | 'cancelled';
export type StageStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type ReviewStatus = 'pending' | 'verified' | 'rejected' | 'disputed' | 'expired';
export type ReportStatus = 'draft' | 'reviewing' | 'approved' | 'published' | 'superseded' | 'rejected';

export const RUN_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  draft: ['queued', 'cancelled'],
  queued: ['running', 'failed', 'cancelled'],
  running: ['waiting_review', 'failed', 'cancelled'],
  waiting_review: ['running', 'published', 'failed', 'cancelled'],
  published: [],
  failed: ['queued', 'cancelled'],
  cancelled: [],
};

export const REPORT_TRANSITIONS: Record<ReportStatus, ReportStatus[]> = {
  draft: ['reviewing'],
  reviewing: ['approved', 'rejected'],
  approved: ['published', 'rejected'],
  published: ['superseded'],
  superseded: [],
  rejected: ['reviewing'],
};

export const RUN_STAGE_PROGRESS: Record<Exclude<CiStage, 'daily_monitor'>, number> = {
  monitor: 20,
  research: 40,
  compare: 60,
  battlecard: 80,
  quality: 100,
};

export function assertTransition<T extends string>(map: Record<T, T[]>, from: T, to: T): void {
  if (!map[from]?.includes(to)) throw new Error(`INVALID_TRANSITION: ${from} -> ${to}`);
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return (value as T) ?? fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}
