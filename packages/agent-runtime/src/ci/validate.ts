import type { Battlecard, ComparisonMatrix, ResearchInsight } from '@contracts/types.js';

export class ArtifactValidationError extends Error {
  constructor(public readonly details: string[]) {
    super(`ARTIFACT_VALIDATION_FAILED: ${details.join('; ')}`);
  }
}

function assertHttpUrl(value: string, field: string, errors: string[]): void {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) errors.push(`${field} must be HTTP/HTTPS`);
  } catch {
    errors.push(`${field} is not a valid URL`);
  }
}

export function validateInsights(value: ResearchInsight[]): ResearchInsight[] {
  const errors: string[] = [];
  if (!Array.isArray(value) || value.length === 0) errors.push('insights must be a non-empty array');
  const statements = new Set<string>();
  value.forEach((item, i) => {
    if (!item || typeof item.topic !== 'string' || !item.topic.trim()) errors.push(`[${i}].topic required`);
    if (typeof item.summary !== 'string' || !item.summary.trim()) errors.push(`[${i}].summary required`);
    if (!Array.isArray(item.key_findings) || item.key_findings.length === 0) errors.push(`[${i}].key_findings required`);
    if (!Array.isArray(item.sources) || item.sources.length === 0) errors.push(`[${i}].sources required`);
    item.sources?.forEach((source, j) => assertHttpUrl(source.url, `[${i}].sources[${j}].url`, errors));
    if (!Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) {
      errors.push(`[${i}].confidence must be 0-1`);
    }
    const normalized = item.summary?.trim().toLowerCase();
    if (normalized && statements.has(normalized)) errors.push(`[${i}] duplicate insight`);
    if (normalized) statements.add(normalized);
  });
  if (errors.length) throw new ArtifactValidationError(errors);
  return value;
}

const EXPECTED_DIMENSIONS = [
  'Product Features', 'Pricing & Value', 'User Experience', 'Market Share & Momentum',
  'Customer Sentiment', 'Technology & Innovation', 'Ecosystem & Integrations',
  'Support & Documentation',
];

export function validateMatrix(value: ComparisonMatrix): ComparisonMatrix {
  const errors: string[] = [];
  if (!value || !Array.isArray(value.dimensions)) errors.push('dimensions required');
  if (value?.dimensions?.length !== EXPECTED_DIMENSIONS.length) errors.push('exactly 8 dimensions required');
  const names = new Set(value?.dimensions?.map((d) => d.dimension));
  for (const expected of EXPECTED_DIMENSIONS) if (!names.has(expected)) errors.push(`missing dimension: ${expected}`);
  value?.dimensions?.forEach((d, i) => {
    const leftScore = Number(d.left_score ?? d.our_score);
    const rightScore = Number(d.right_score ?? d.competitor_score);
    if (!Number.isFinite(leftScore) || leftScore < 0 || leftScore > 10) errors.push(`[${i}].left_score invalid`);
    if (!Number.isFinite(rightScore) || rightScore < 0 || rightScore > 10) errors.push(`[${i}].right_score invalid`);
    if (typeof d.notes !== 'string' || !d.notes.trim()) errors.push(`[${i}].notes required`);
  });
  if (typeof value?.overall_assessment !== 'string' || !value.overall_assessment.trim()) errors.push('overall_assessment required');
  if (errors.length) throw new ArtifactValidationError(errors);
  return value;
}

export function validateBattlecard(value: Battlecard): Battlecard {
  const errors: string[] = [];
  const arrays: (keyof Battlecard)[] = [
    'our_strengths', 'our_weaknesses', 'competitor_strengths',
    'competitor_weaknesses', 'key_differentiators',
  ];
  for (const key of arrays) {
    const list = value?.[key];
    if (!Array.isArray(list) || list.length === 0 || !list.every((v) => typeof v === 'string' && v.trim())) {
      errors.push(`${String(key)} must be a non-empty string array`);
    }
  }
  if (!value?.objection_handling || typeof value.objection_handling !== 'object') errors.push('objection_handling required');
  if (typeof value?.elevator_pitch !== 'string' || !value.elevator_pitch.trim()) errors.push('elevator_pitch required');
  if (errors.length) throw new ArtifactValidationError(errors);
  return value;
}
