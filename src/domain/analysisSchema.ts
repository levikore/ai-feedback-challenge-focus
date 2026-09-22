import { z } from 'zod';

/**
 * The contract with the AI, and the single source of truth for it.
 *
 * This one object is used three ways:
 *   1. converted to JSON Schema and sent as the tool definition, so the model
 *      is constrained at generation time;
 *   2. used to validate whatever actually comes back, because a constrained
 *      decode is a strong prior, not a guarantee;
 *   3. as the TypeScript type for everything downstream.
 *
 * `.strict()` matters: an unexpected key means the model answered a different
 * question than the one we asked, and silently dropping it would hide that.
 */
export const FeatureRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export const AnalysisSchema = z
  .object({
    sentiment: z.enum(['positive', 'neutral', 'negative']),
    feature_requests: z.array(FeatureRequestSchema).max(20),
    actionable_insight: z.string().trim().min(1).max(1000),
  })
  .strict();

export type Analysis = z.infer<typeof AnalysisSchema>;
export type FeatureRequest = z.infer<typeof FeatureRequestSchema>;

/**
 * Hand-written JSON Schema for the tool definition.
 *
 * Deliberately not generated from the Zod schema. The two serve different
 * purposes and drifting them apart is the point: the JSON Schema is a hint that
 * shapes generation, the Zod schema is the gate that decides what we store. If
 * the tool schema were derived from the validator, a bug in the conversion
 * would weaken both at once.
 */
export const ANALYSIS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    sentiment: {
      type: 'string',
      enum: ['positive', 'neutral', 'negative'],
      description: 'Overall sentiment of the feedback.',
    },
    feature_requests: {
      type: 'array',
      description:
        'Concrete capabilities the user is asking for. Empty array if none are expressed.',
      items: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Short imperative summary of the request, under 200 characters.',
          },
          confidence: {
            type: 'number',
            description:
              'How confident you are that this is a genuine feature request, from 0.0 to 1.0.',
          },
        },
        required: ['title', 'confidence'],
        additionalProperties: false,
      },
    },
    actionable_insight: {
      type: 'string',
      description: 'One sentence a product owner could act on.',
    },
  },
  required: ['sentiment', 'feature_requests', 'actionable_insight'],
  additionalProperties: false,
} as const;

/** Flattens a ZodError into a single line suitable for `feedback.last_error`. */
export function formatValidationError(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}
