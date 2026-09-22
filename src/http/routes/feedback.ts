import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { FEEDBACK_STATUSES } from '../../domain/feedback.js';
import {
  FeedbackNotFoundError,
  InvalidRetryError,
  type FeedbackService,
} from '../../services/feedbackService.js';

export interface RouteOptions {
  service: FeedbackService;
  maxFeedbackLength: number;
}

export async function registerFeedbackRoutes(
  app: FastifyInstance,
  { service, maxFeedbackLength }: RouteOptions,
): Promise<void> {
  // Request schemas are separate from the AI schema on purpose: what a client
  // may send and what the model must return are different contracts.
  const SubmitBody = z.object({
    content: z
      .string({ required_error: 'content is required' })
      .trim()
      .min(1, 'content must not be empty')
      .max(maxFeedbackLength, `content must be at most ${maxFeedbackLength} characters`),
  });

  const ListQuery = z.object({
    status: z.enum(FEEDBACK_STATUSES).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
  });

  app.post('/api/feedback', async (request, reply) => {
    const parsed = SubmitBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(badRequest(parsed.error));
    }

    // Returns as soon as the row is durable. Analysis happens behind this.
    const view = service.submit(parsed.data.content);
    return reply.code(201).send(view);
  });

  app.get('/api/feedback', async (request, reply) => {
    const parsed = ListQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send(badRequest(parsed.error));
    }

    return reply.send(service.list(parsed.data));
  });

  app.get<{ Params: { id: string } }>('/api/feedback/:id', async (request, reply) => {
    try {
      return reply.send(service.get(request.params.id));
    } catch (error) {
      if (error instanceof FeedbackNotFoundError) {
        return reply.code(404).send({ error: 'not_found', message: error.message });
      }
      throw error;
    }
  });

  app.post<{ Params: { id: string } }>('/api/feedback/:id/retry', async (request, reply) => {
    try {
      return reply.send(service.retry(request.params.id));
    } catch (error) {
      if (error instanceof FeedbackNotFoundError) {
        return reply.code(404).send({ error: 'not_found', message: error.message });
      }
      if (error instanceof InvalidRetryError) {
        // 409, not 400: the request is well-formed, it just conflicts with the
        // resource's current state.
        return reply.code(409).send({ error: 'invalid_state', message: error.message });
      }
      throw error;
    }
  });
}

function badRequest(error: z.ZodError) {
  return {
    error: 'validation_error',
    message: 'Request body or query failed validation.',
    details: error.issues.map((i) => ({
      field: i.path.join('.') || '(root)',
      message: i.message,
    })),
  };
}
