import type { AnalysisProvider, ProviderResult } from './provider.js';
import { ProviderError } from './provider.js';

/**
 * A deterministic stand-in for the real model.
 *
 * Two jobs:
 *   - let a reviewer clone the repo and run the whole system, tests included,
 *     without an API key or a cent of spend;
 *   - give the tests a way to drive every branch — success, transient failure,
 *     malformed output — without mocking the SDK's internals.
 *
 * Its output is intentionally crude. It is not pretending to be a model; it is
 * producing a valid payload so the machinery around the model can be exercised.
 */
const NEGATIVE_MARKERS = ['slow', 'crash', 'bug', 'broken', 'hate', 'terrible', 'awful', 'fail'];
const POSITIVE_MARKERS = ['love', 'great', 'excellent', 'amazing', 'fast', 'perfect', 'thanks'];
const REQUEST_MARKERS = ['wish', 'would like', 'please add', 'can you add', 'feature', 'support for', 'need'];

/**
 * Magic strings that force a specific failure. They exist so `scripts/demo.sh`
 * and the tests can demonstrate the FAILED path and the retry path on demand,
 * rather than waiting for a real failure to happen to occur during a demo.
 */
export const FAKE_TRIGGER_TRANSIENT = '__fail_transient__';
export const FAKE_TRIGGER_MALFORMED = '__fail_malformed__';

export class FakeProvider implements AnalysisProvider {
  readonly name = 'fake';

  /** Incremented on every call, so tests can assert the cache prevented one. */
  callCount = 0;

  /**
   * When set, the Nth call and earlier fail transiently, later calls succeed.
   * Lets a test prove that a retryable failure is in fact retried.
   */
  constructor(private readonly failTransientlyForFirstNCalls = 0) {}

  async analyze(content: string): Promise<ProviderResult> {
    this.callCount += 1;

    if (this.callCount <= this.failTransientlyForFirstNCalls) {
      throw new ProviderError('Simulated upstream timeout', 'transient');
    }

    if (content.includes(FAKE_TRIGGER_TRANSIENT)) {
      throw new ProviderError('Simulated upstream timeout', 'transient');
    }

    if (content.includes(FAKE_TRIGGER_MALFORMED)) {
      // Returns successfully but with a payload that will not validate:
      // sentiment is outside the enum and confidence is out of range. This is
      // the realistic failure mode, and the one the schema gate exists for.
      return {
        raw: JSON.stringify({
          sentiment: 'mildly annoyed',
          feature_requests: [{ title: 'Something', confidence: 3.7 }],
          actionable_insight: '',
        }),
        model: this.name,
      };
    }

    const lower = content.toLowerCase();
    const negative = NEGATIVE_MARKERS.filter((m) => lower.includes(m)).length;
    const positive = POSITIVE_MARKERS.filter((m) => lower.includes(m)).length;

    const sentiment = negative > positive ? 'negative' : positive > negative ? 'positive' : 'neutral';

    const featureRequests = REQUEST_MARKERS.some((m) => lower.includes(m))
      ? [{ title: firstSentence(content).slice(0, 200), confidence: 0.6 }]
      : [];

    return {
      raw: JSON.stringify({
        sentiment,
        feature_requests: featureRequests,
        actionable_insight: `Review ${sentiment} feedback about "${firstSentence(content).slice(0, 80)}".`,
      }),
      model: this.name,
    };
  }
}

function firstSentence(text: string): string {
  const trimmed = text.trim();
  const end = trimmed.search(/[.!?]/);
  return (end === -1 ? trimmed : trimmed.slice(0, end)).trim() || trimmed;
}
