import { wireApp, type App } from '../src/app.js';
import type { AnalysisProvider } from '../src/ai/provider.js';
import { loadConfig, type Config } from '../src/config.js';

export const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * A complete application against an in-memory database.
 *
 * Every test gets its own — no shared fixtures, no cleanup between tests, no
 * ordering dependencies.
 */
export function makeApp(provider: AnalysisProvider, overrides: Partial<NodeJS.ProcessEnv> = {}): App {
  const config: Config = loadConfig({
    DATABASE_PATH: ':memory:',
    WORKER_CONCURRENCY: '1',
    MAX_ANALYSIS_ATTEMPTS: '3',
    AI_PROVIDER: 'fake',
    ...overrides,
  } as NodeJS.ProcessEnv);

  return wireApp({ config, logger: silentLogger, provider });
}

/**
 * Waits for the queue to reach zero outstanding work.
 *
 * `depth` counts retries waiting out their backoff, so this covers the retry
 * path without the test needing to know the backoff schedule.
 */
export async function settle(app: App, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await app.queue.onIdle();
    if (app.queue.depth === 0) return;
    await new Promise((r) => setTimeout(r, 10));
  }

  throw new Error(`Queue never settled (depth ${app.queue.depth}).`);
}
