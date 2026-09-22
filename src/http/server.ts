import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
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

  app.setErrorHandler((error: FastifyError, request, reply) => {
    // Not everything reaching here is a server fault. Fastify raises its own
    // errors for malformed JSON, unsupported content types and oversized bodies
    // and tags them with a 4xx statusCode. Flattening those to 500 tells a
    // client with a serialization bug that the server is broken, and makes any
    // retry-on-5xx policy retry a request that can never succeed.
    const status = error.statusCode ?? 500;

    if (status < 500) {
      request.log.info({ err: error }, 'Rejected malformed request');
      return reply.code(status).send({ error: 'bad_request', message: error.message });
    }

    // Anything else genuinely is a bug. Log the detail, return a generic body —
    // internals do not belong in a response.
    request.log.error({ err: error }, 'Unhandled error in request handler');
    return reply.code(500).send({ error: 'internal_error', message: 'Something went wrong.' });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: 'not_found', message: `No route for ${request.method} ${request.url}` });
  });

  return app;
}
