import { afterEach, describe, expect, it } from 'vitest';
import { FakeProvider } from '../src/ai/fakeProvider.js';
import { ProviderError, type AnalysisProvider } from '../src/ai/provider.js';
import type { App } from '../src/app.js';
import { makeApp, settle } from './helpers.js';

let app: App | undefined;
afterEach(async () => {
  await app?.shutdown();
  app = undefined;
});

describe('guardrail: hash-based analysis cache', () => {
  it('reuses a stored analysis for identical feedback instead of calling the model again', async () => {
    const provider = new FakeProvider();
    app = makeApp(provider);

    const first = app.service.submit('The mobile app crashes on startup.');
    await settle(app);
    expect(provider.callCount).toBe(1);

    const second = app.service.submit('The mobile app crashes on startup.');

    // Served synchronously from the cache — it never entered the queue.
    expect(second.status).toBe('DONE');
    expect(second.analysis).not.toBeNull();
    expect(second.analysis!.from_cache).toBe(true);
    expect(second.analysis!.sentiment).toBe(app.service.get(first.id).analysis!.sentiment);

    await settle(app);
    expect(provider.callCount).toBe(1); // the guardrail's whole purpose

    // The second submission is still its own record, with its own id.
    expect(second.id).not.toBe(first.id);
    expect(app.service.get(first.id).analysis!.from_cache).toBe(false);
  });

  it('treats whitespace and case differences as the same feedback', async () => {
    const provider = new FakeProvider();
    app = makeApp(provider);

    app.service.submit('Please add dark mode.');
    await settle(app);

    const variant = app.service.submit('  PLEASE   ADD    DARK MODE. ');
    expect(variant.status).toBe('DONE');
    expect(variant.analysis!.from_cache).toBe(true);
    expect(provider.callCount).toBe(1);
  });

  it('does not treat different feedback as a cache hit', async () => {
    const provider = new FakeProvider();
    app = makeApp(provider);

    app.service.submit('Please add dark mode.');
    await settle(app);

    const other = app.service.submit('Please add light mode.');
    expect(other.status).toBe('RECEIVED'); // queued, not served from cache
    await settle(app);

    expect(provider.callCount).toBe(2);
    expect(app.service.get(other.id).analysis!.from_cache).toBe(false);
  });

  it('collapses a burst of identical feedback into ONE model call', async () => {
    // The regression this exists for: findCacheSource only matches DONE rows,
    // so before the leader/follower fan-out every duplicate arriving while the
    // first analysis was still running bought its own LLM call. With a 150ms
    // provider this test saw 6 calls; it must see 1.
    let calls = 0;
    const slow: AnalysisProvider = {
      name: 'slow',
      analyze: async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 150));
        return {
          raw: JSON.stringify({
            sentiment: 'negative',
            feature_requests: [],
            actionable_insight: 'Investigate the outage.',
          }),
          model: 'slow',
        };
      },
    };

    app = makeApp(slow, { WORKER_CONCURRENCY: '4' });

    const burst = Array.from({ length: 6 }, () =>
      app!.service.submit('Everything is down right now!'),
    );
    await settle(app);

    expect(calls).toBe(1);

    const views = burst.map((b) => app!.service.get(b.id));
    expect(views.every((v) => v.status === 'DONE')).toBe(true);
    expect(views.every((v) => v.analysis!.sentiment === 'negative')).toBe(true);

    // Exactly one did the work; the other five inherited it.
    expect(views.filter((v) => v.analysis!.from_cache === false)).toHaveLength(1);
    expect(views.filter((v) => v.analysis!.from_cache === true)).toHaveLength(5);
  });

  it('promotes a waiting duplicate when the leader fails, one at a time', async () => {
    let calls = 0;
    const failsTwiceThenWorks: AnalysisProvider = {
      name: 'flaky',
      analyze: async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 50));
        if (calls <= 2) throw new ProviderError('bad shape', 'malformed_output');
        return {
          raw: JSON.stringify({
            sentiment: 'neutral',
            feature_requests: [],
            actionable_insight: 'Fine in the end.',
          }),
          model: 'flaky',
        };
      },
    };

    app = makeApp(failsTwiceThenWorks, { WORKER_CONCURRENCY: '4', MAX_ANALYSIS_ATTEMPTS: '1' });

    const burst = Array.from({ length: 4 }, () => app!.service.submit('same text, flaky backend'));
    await settle(app);

    // Leader fails, one follower is promoted and fails, the next succeeds and
    // fans out to whatever is left. Crucially NOT 4 simultaneous calls.
    expect(calls).toBe(3);

    const views = burst.map((b) => app!.service.get(b.id));
    expect(views.filter((v) => v.status === 'FAILED')).toHaveLength(2);
    expect(views.filter((v) => v.status === 'DONE')).toHaveLength(2);
  });

  it('does not serve a cache hit from feedback that failed analysis', async () => {
    const provider = new FakeProvider(99); // every call fails transiently
    app = makeApp(provider, { MAX_ANALYSIS_ATTEMPTS: '1' });

    const first = app.service.submit('Some feedback nobody could analyse.');
    await settle(app);
    expect(app.service.get(first.id).status).toBe('FAILED');

    // FAILED items have no analysis, so there is nothing to copy — the
    // duplicate is queued normally rather than inheriting the failure.
    const second = app.service.submit('Some feedback nobody could analyse.');
    expect(second.status).toBe('RECEIVED');
  });
});
