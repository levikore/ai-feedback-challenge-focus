import { describe, expect, it } from 'vitest';
import { interpretResponse } from '../src/ai/geminiProvider.js';
import { ProviderError } from '../src/ai/provider.js';

const VALID = JSON.stringify({
  sentiment: 'negative',
  feature_requests: [{ title: 'Scheduled exports', confidence: 0.7 }],
  actionable_insight: 'Add scheduling to the export flow.',
});

describe('Gemini interpretResponse', () => {
  it('returns the JSON body as the raw payload', () => {
    const result = interpretResponse(
      { text: VALID, candidates: [{ finishReason: 'STOP' }] },
      'gemini-3-flash',
    );

    expect(result.model).toBe('gemini-3-flash');
    expect(JSON.parse(result.raw).sentiment).toBe('negative');
  });

  it('rejects output truncated by the token ceiling', () => {
    // Gemini returns the partial text with finishReason MAX_TOKENS rather than
    // failing, so without this check a half-written JSON body would reach the
    // validator and be reported as a schema problem.
    try {
      interpretResponse(
        { text: '{"sentiment":"negative","feature_requests":[{"title":"Sched', candidates: [{ finishReason: 'MAX_TOKENS' }] },
        'gemini-3-flash',
        512,
      );
      expect.unreachable('should have thrown');
    } catch (error) {
      const e = error as ProviderError;
      expect(e.kind).toBe('truncated');
      expect(e.retryable).toBe(false);
      expect(e.message).toContain('512');
      expect(e.message).toContain('GEMINI_MAX_TOKENS');
      expect(e.raw).toContain('Sched'); // partial payload kept for the audit trail
    }
  });

  it('treats a safety block as deterministic, not transient', () => {
    // A blocked prompt returns HTTP 200 with no candidate. Retrying the same
    // feedback gets blocked again, so it must not consume the retry budget.
    try {
      interpretResponse({ promptFeedback: { blockReason: 'SAFETY' }, candidates: [] }, 'gemini-3-flash');
      expect.unreachable('should have thrown');
    } catch (error) {
      const e = error as ProviderError;
      expect(e.kind).toBe('malformed_output');
      expect(e.retryable).toBe(false);
      expect(e.message).toContain('SAFETY');
    }
  });

  it('rejects an empty response', () => {
    expect(() =>
      interpretResponse({ text: '', candidates: [{ finishReason: 'STOP' }] }, 'gemini-3-flash'),
    ).toThrow(/returned no content/);
  });

  it('rejects a whitespace-only response', () => {
    expect(() => interpretResponse({ text: '   \n ' }, 'gemini-3-flash')).toThrow(
      /returned no content/,
    );
  });
});
