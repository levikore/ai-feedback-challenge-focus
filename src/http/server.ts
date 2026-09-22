import Fastify, { type FastifyInstance } from 'fastify';
import type { AnalysisQueue } from '../queue/analysisQueue.js';
import type { FeedbackService } from '../services/feedbackService.js';
import { registerFeedbackRoutes } from './routes/feedback.js';

export interface ServerOptions {
  service: FeedbackService;
  queue: AnalysisQueue;
  maxFeedbackLength: number;
  providerName: string;
  logLevel?: string;
}

export async function buildServer(opts: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: opts.logLevel ?? 'info' },
  });

  app.get('/health', async () => ({
    status: 'ok',
    provider: opts.providerName,
    queue_depth: opts.queue.depth,
  }));

  await registerFeedbackRoutes(app, {
    service: opts.service,
    maxFeedbackLength: opts.maxFeedbackLength,
  });

  // Anything that escapes a handler is a bug, not a client error. Log the
  // detail, return a generic body — internals do not belong in a response.
  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, 'Unhandled error in request handler');
    reply.code(500).send({ error: 'internal_error', message: 'Something went wrong.' });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: 'not_found', message: `No route for ${request.method} ${request.url}` });
  });

  return app;
}
