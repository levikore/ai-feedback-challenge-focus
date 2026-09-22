import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeProvider } from '../src/ai/fakeProvider.js';
import type { App } from '../src/app.js';
import { buildServer } from '../src/http/server.js';
import { makeApp, settle } from './helpers.js';

let app: App | undefined;
let server: FastifyInstance | undefined;

async function start(): Promise<FastifyInstance> {
  app = makeApp(new FakeProvider());
  server = await buildServer({
    service: app.service,
    queue: app.queue,
    maxFeedbackLength: 5000,
    providerName: 'fake',
    logLevel: 'silent',
  });
  return server;
}

afterEach(async () => {
  await server?.close();
  await app?.shutdown();
  server = undefined;
  app = undefined;
});

describe('HTTP API', () => {
  it('reports health', async () => {
    const s = await start();
    const res = await s.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', provider: 'fake' });
  });

  it('accepts feedback with 201 and returns it as RECEIVED', async () => {
    const s = await start();
    const res = await s.inject({
      method: 'POST',
      url: '/api/feedback',
      payload: { content: 'The search results are irrelevant.' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: 'RECEIVED', analysis: null });
    expect(res.json().id).toBeTypeOf('string');
  });

  it.each([
    ['an empty body', {}],
    ['blank content', { content: '   ' }],
    ['content of the wrong type', { content: 42 }],
  ])('rejects %s with 400 and a field-level reason', async (_label, payload) => {
    const s = await start();
    const res = await s.inject({ method: 'POST', url: '/api/feedback', payload });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
    expect(res.json().details[0].field).toBe('content');
  });

  it('rejects content beyond the configured length limit', async () => {
    const s = await start();
    const res = await s.inject({
      method: 'POST',
      url: '/api/feedback',
      payload: { content: 'x'.repeat(5001) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('lists feedback with its analysis, newest first, and filters by status', async () => {
    const s = await start();

    await s.inject({ method: 'POST', url: '/api/feedback', payload: { content: 'Too slow.' } });
    await s.inject({ method: 'POST', url: '/api/feedback', payload: { content: 'Love it, thanks!' } });
    await settle(app!);

    const all = await s.inject({ method: 'GET', url: '/api/feedback' });
    expect(all.statusCode).toBe(200);
    expect(all.json().total).toBe(2);
    expect(all.json().items).toHaveLength(2);
    expect(all.json().items[0].analysis).not.toBeNull();

    const done = await s.inject({ method: 'GET', url: '/api/feedback?status=DONE' });
    expect(done.json().total).toBe(2);

    const failed = await s.inject({ method: 'GET', url: '/api/feedback?status=FAILED' });
    expect(failed.json().items).toHaveLength(0);
  });

  it('paginates', async () => {
    const s = await start();
    for (let i = 0; i < 5; i += 1) {
      await s.inject({ method: 'POST', url: '/api/feedback', payload: { content: `comment ${i}` } });
    }
    await settle(app!);

    const page = await s.inject({ method: 'GET', url: '/api/feedback?limit=2&offset=2' });
    expect(page.json().items).toHaveLength(2);
    expect(page.json().total).toBe(5);
  });

  it('rejects a nonsense status filter with 400', async () => {
    const s = await start();
    const res = await s.inject({ method: 'GET', url: '/api/feedback?status=BANANA' });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for an unknown id, on both read and retry', async () => {
    const s = await start();
    expect((await s.inject({ method: 'GET', url: '/api/feedback/nope' })).statusCode).toBe(404);
    expect((await s.inject({ method: 'POST', url: '/api/feedback/nope/retry' })).statusCode).toBe(404);
  });

  it('returns 409 when retrying an item that is not FAILED', async () => {
    const s = await start();
    const created = await s.inject({
      method: 'POST',
      url: '/api/feedback',
      payload: { content: 'perfectly fine feedback' },
    });
    await settle(app!);

    const res = await s.inject({ method: 'POST', url: `/api/feedback/${created.json().id}/retry` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('invalid_state');
  });
});
