import { describe, expect, it } from 'vitest';
import { AnalysisSchema } from '../src/domain/analysisSchema.js';

const VALID = {
  sentiment: 'negative',
  feature_requests: [{ title: 'Add CSV export', confidence: 0.8 }],
  actionable_insight: 'Users want bulk export; prioritise it for next sprint.',
};

describe('AnalysisSchema — the gate on AI output', () => {
  it('accepts a well-formed payload', () => {
    const result = AnalysisSchema.safeParse(VALID);
    expect(result.success).toBe(true);
  });

  it('accepts an empty feature_requests array', () => {
    expect(AnalysisSchema.safeParse({ ...VALID, feature_requests: [] }).success).toBe(true);
  });

  // Each case below is a real failure mode observed from a model, not a
  // hypothetical. See AI_COLLABORATION_LOG.md.
  it.each([
    ['sentiment outside the enum', { ...VALID, sentiment: 'mildly annoyed' }],
    ['sentiment as a score', { ...VALID, sentiment: 0.2 }],
    ['confidence above 1', { ...VALID, feature_requests: [{ title: 'X', confidence: 3.7 }] }],
    ['confidence as a percentage string', { ...VALID, feature_requests: [{ title: 'X', confidence: '80%' }] }],
    ['empty title', { ...VALID, feature_requests: [{ title: '', confidence: 0.5 }] }],
    ['empty actionable_insight', { ...VALID, actionable_insight: '' }],
    ['missing actionable_insight', { sentiment: 'neutral', feature_requests: [] }],
    ['an extra top-level key', { ...VALID, summary: 'bonus field the model invented' }],
    ['an extra key inside a feature request', {
      ...VALID,
      feature_requests: [{ title: 'X', confidence: 0.5, priority: 'high' }],
    }],
    ['feature_requests as an object instead of an array', { ...VALID, feature_requests: { title: 'X' } }],
  ])('rejects %s', (_label, payload) => {
    expect(AnalysisSchema.safeParse(payload).success).toBe(false);
  });
});
