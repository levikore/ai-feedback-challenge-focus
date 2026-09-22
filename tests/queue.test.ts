import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

describe('backoff timers keep the process alive', () => {
  it('completes a retry in a process with nothing else holding the event loop', async () => {
    // Regression: enqueueAfter() unref'd its timer, so a process whose only
    // outstanding work was a pending retry exited before the retry fired. The
    // HTTP server masked it via the listening socket; any other consumer of
    // AnalysisQueue silently lost the work.
    const { stdout } = await run(
      'npx',
      ['tsx', join(here, 'fixtures', 'retryOutlivesEventLoop.ts')],
      { cwd: join(here, '..'), timeout: 60_000 },
    );

    const result = JSON.parse(stdout.trim().split('\n').pop()!);

    // Reaching DONE at all proves the process stayed alive through the backoff.
    expect(result).toEqual({ status: 'DONE', calls: 2 });
  }, 90_000);
});
