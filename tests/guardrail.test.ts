import { afterEach, describe, expect, it } from 'vitest';
import { FakeProvider } from '../src/ai/fakeProvider.js';
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
