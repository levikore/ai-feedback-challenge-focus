import { afterEach, describe, expect, it } from 'vitest';
import {
  FakeProvider,
  FAKE_TRIGGER_MALFORMED,
  FAKE_TRIGGER_TRANSIENT,
} from '../src/ai/fakeProvider.js';
import { ProviderError, type AnalysisProvider } from '../src/ai/provider.js';
import type { App } from '../src/app.js';
import { makeApp, settle } from './helpers.js';

let app: App | undefined;
afterEach(async () => {
  await app?.shutdown();
  app = undefined;
});

describe('end-to-end analysis pipeline', () => {
  it('returns immediately as RECEIVED, then reaches DONE with a validated analysis', async () => {
    app = makeApp(new FakeProvider());

    const submitted = app.service.submit('The export is far too slow and it crashed twice today.');

    // The submit call did not wait for the model.
    expect(submitted.status).toBe('RECEIVED');
    expect(submitted.analysis).toBeNull();

    await settle(app);

    const done = app.service.get(submitted.id);
    expect(done.status).toBe('DONE');
    expect(done.analysis).not.toBeNull();
    expect(done.analysis!.sentiment).toBe('negative');
    expect(done.analysis!.from_cache).toBe(false);
    expect(typeof done.analysis!.actionable_insight).toBe('string');
  });

  it('marks output that fails schema validation as FAILED, without retrying it', async () => {
    const provider = new FakeProvider();
    app = makeApp(provider);

    const submitted = app.service.submit(`Please fix this ${FAKE_TRIGGER_MALFORMED}`);
    await settle(app);

    const failed = app.service.get(submitted.id);
    expect(failed.status).toBe('FAILED');
    expect(failed.analysis).toBeNull();
    expect(failed.error).toMatch(/malformed_output/);
    expect(failed.error).toMatch(/schema validation/);

    // The key assertion: a deterministic bad shape is not retried. One call,
    // one attempt, straight to FAILED.
    expect(provider.callCount).toBe(1);
    expect(failed.attempts).toBe(1);
  });

  it('retries a transient failure and succeeds on a later attempt', async () => {
    // Fails the first two calls, succeeds on the third — within the budget of 3.
    const provider = new FakeProvider(2);
    app = makeApp(provider);

    const submitted = app.service.submit('Loving the new dashboard, it is really fast.');
    await settle(app);

    const done = app.service.get(submitted.id);
    expect(done.status).toBe('DONE');
    expect(provider.callCount).toBe(3);
    expect(done.attempts).toBe(3);
  });

  it('gives up after the attempt budget is exhausted, and the item is then retriable', async () => {
    app = makeApp(new FakeProvider());

    const submitted = app.service.submit(`Everything is broken ${FAKE_TRIGGER_TRANSIENT}`);
    await settle(app);

    const failed = app.service.get(submitted.id);
    expect(failed.status).toBe('FAILED');
    expect(failed.attempts).toBe(3); // MAX_ANALYSIS_ATTEMPTS
    expect(failed.error).toMatch(/transient/);

    // Retry puts it straight back on the queue.
    const retried = app.service.retry(submitted.id);
    expect(retried.status).toBe('RECEIVED');
    expect(retried.error).toBeNull();
  });

  it('rejects a retry on anything that is not FAILED', async () => {
    app = makeApp(new FakeProvider());

    const submitted = app.service.submit('This is fine.');
    await settle(app);
    expect(app.service.get(submitted.id).status).toBe('DONE');

    expect(() => app!.service.retry(submitted.id)).toThrow(/Only FAILED feedback can be retried/);
  });

  it('persists the raw response on both the success and the validation-failure path', async () => {
    app = makeApp(new FakeProvider());

    const ok = app.service.submit('Great product, thanks!');
    const bad = app.service.submit(`Nope ${FAKE_TRIGGER_MALFORMED}`);
    await settle(app);

    const rows = app.db
      .prepare('SELECT feedback_id, raw_response, error, error_kind FROM analysis_attempts')
      .all() as Array<{ feedback_id: string; raw_response: string | null; error: string | null; error_kind: string | null }>;

    const okAttempt = rows.find((r) => r.feedback_id === ok.id)!;
    expect(okAttempt.raw_response).toContain('sentiment');
    expect(okAttempt.error).toBeNull();

    // The raw payload survives even though there is no validated result to
    // attach it to — which is the entire reason attempts is its own table.
    const badAttempt = rows.find((r) => r.feedback_id === bad.id)!;
    expect(badAttempt.raw_response).toContain('mildly annoyed');
    expect(badAttempt.error_kind).toBe('malformed_output');
  });

  it('surfaces an unexpected non-ProviderError as a failure rather than crashing the worker', async () => {
    const exploding: AnalysisProvider = {
      name: 'exploding',
      analyze: async () => {
        throw new TypeError('something nobody anticipated');
      },
    };
    app = makeApp(exploding, { MAX_ANALYSIS_ATTEMPTS: '1' });

    const submitted = app.service.submit('anything');
    await settle(app);

    expect(app.service.get(submitted.id).status).toBe('FAILED');

    // The pool is still alive and processing after the surprise.
    const next = app.service.submit('a different comment');
    await settle(app);
    expect(app.service.get(next.id).status).toBe('FAILED');
    expect(ProviderError).toBeDefined();
  });
});
