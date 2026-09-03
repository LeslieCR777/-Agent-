import { CI_STAGE_ORDER, CI_TAG } from './constants.js';
import type { CiStage } from './types.js';

export interface CiTagInfo {
  stage: CiStage;
  competitorId: string;
  mode: 'full' | 'monitor';
  round: number;
  runId: string | null;
}

export function parseCiTags(tags: string[] | null): CiTagInfo | null {
  if (!tags || tags.length < 2 || tags[0] !== CI_TAG) return null;
  const stage = tags[1] as CiStage;
  if (!CI_STAGE_ORDER.includes(stage) && stage !== 'daily_monitor') return null;
  const competitorId = tags[2] ?? '';
  const [modeRaw, roundRaw] = (tags[3] ?? 'full:0').split(':');
  const runTag = tags.find((tag) => tag.startsWith('run:'));
  const round = Number.parseInt(roundRaw ?? '0', 10);
  return {
    stage,
    competitorId,
    mode: modeRaw === 'monitor' ? 'monitor' : 'full',
    round: Number.isFinite(round) ? round : 0,
    runId: runTag ? runTag.slice(4) : null,
  };
}
