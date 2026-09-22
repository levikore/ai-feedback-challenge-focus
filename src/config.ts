/**
 * Environment configuration, parsed and validated once at boot.
 *
 * Config is read here and nowhere else. Modules receive what they need as
 * constructor arguments, which is what keeps them testable without stubbing
 * `process.env`.
 */
import { z } from 'zod';

const numeric = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const EnvSchema = z.object({
  PORT: numeric(3000, 1, 65535),
  DATABASE_PATH: z.string().min(1).default('./data/feedback.db'),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_MODEL: z.string().min(1).default('claude-opus-5'),
  ANTHROPIC_MAX_TOKENS: numeric(4096, 256, 64_000),
  WORKER_CONCURRENCY: numeric(2, 1, 32),
  MAX_ANALYSIS_ATTEMPTS: numeric(3, 1, 10),
  MAX_FEEDBACK_LENGTH: numeric(5000, 1, 100_000),
  AI_PROVIDER: z.enum(['auto', 'fake', 'anthropic']).default('auto'),
  LOG_LEVEL: z.string().default('info'),
});

export type Config = z.infer<typeof EnvSchema> & {
  /** Resolved from AI_PROVIDER + whether a key is actually present. */
  readonly useFakeProvider: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);

  if (!parsed.success) {
    // Fail loudly at boot rather than at the first request that touches a
    // misconfigured value.
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }

  const cfg = parsed.data;
  const hasKey = Boolean(cfg.ANTHROPIC_API_KEY);

  if (cfg.AI_PROVIDER === 'anthropic' && !hasKey) {
    throw new Error('AI_PROVIDER=anthropic requires ANTHROPIC_API_KEY to be set.');
  }

  return { ...cfg, useFakeProvider: cfg.AI_PROVIDER === 'fake' || !hasKey };
}
