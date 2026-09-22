/**
 * Run as a standalone process by tests/queue.test.ts.
 *
 * Nothing here holds the event loop open except the queue itself — no server,
 * no listening socket, no interval. If a pending backoff timer is unref'd, Node
 * drains the loop, the process exits before the retry fires, and the final
 * status is never printed. That was the original bug, masked in the real app by
 * the HTTP server's socket.
 */
import { wireApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { ProviderError, type AnalysisProvider } from '../../src/ai/provider.js';

let calls = 0;
const failsOnce: AnalysisProvider = {
  name: 'fails-once',
  analyze: async () => {
    calls += 1;
    if (calls === 1) throw new ProviderError('transient blip', 'transient');
    return {
      raw: JSON.stringify({
        sentiment: 'neutral',
        feature_requests: [],
        actionable_insight: 'Recovered after a retry.',
      }),
      model: 'fails-once',
    };
  },
};

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const app = wireApp({
  config: loadConfig({ DATABASE_PATH: ':memory:', AI_PROVIDER: 'fake' } as NodeJS.ProcessEnv),
  logger: silent,
  provider: failsOnce,
});

const submitted = app.service.submit('this fails once, then succeeds on retry');

await app.queue.onIdle();
console.log(JSON.stringify({ status: app.service.get(submitted.id).status, calls }));
await app.shutdown();
