import { wireApp } from './app.js';
import { loadConfig } from './config.js';
import { buildServer } from './http/server.js';

async function main(): Promise<void> {
  const config = loadConfig();

  // Bootstrap logger: plain console until Fastify's logger exists. Swapped for
  // the Fastify child logger immediately after the server is built.
  const logger = {
    info: (m: string) => console.log(`[info] ${m}`),
    warn: (m: string) => console.warn(`[warn] ${m}`),
    error: (m: string) => console.error(`[error] ${m}`),
  };

  const app = wireApp({ config, logger });

  if (app.recoveredIds.length > 0) {
    logger.warn(
      `Recovered ${app.recoveredIds.length} item(s) stranded in ANALYZING by a previous run: ` +
        app.recoveredIds.join(', '),
    );
  }

  const server = await buildServer({
    service: app.service,
    queue: app.queue,
    maxFeedbackLength: config.MAX_FEEDBACK_LENGTH,
    providerName: app.providerName,
    logLevel: config.LOG_LEVEL,
  });

  await server.listen({ port: config.PORT, host: '0.0.0.0' });
  server.log.info(
    `Analysis provider: ${app.providerName} | concurrency: ${config.WORKER_CONCURRENCY} | db: ${config.DATABASE_PATH}`,
  );

  // Drain in-flight analyses before exiting, so nothing is left ANALYZING
  // unnecessarily. Anything that does get stranded is recovered at next boot.
  const shutdown = async (signal: string) => {
    server.log.info(`${signal} received — draining in-flight analyses.`);
    await server.close();
    await app.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('[fatal] Failed to start:', error);
  process.exit(1);
});
