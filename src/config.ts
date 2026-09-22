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

/**
 * Treats an empty or whitespace-only value as absent.
 *
 * A `.env` copied from `.env.example` contains `GEMINI_API_KEY=`, which arrives
 * as an empty string rather than as undefined. Without this the app refuses to
 * start on a blank key instead of falling back to the fake provider — a crash
 * on the very first run, before the user has done anything wrong.
 */
const blankAsAbsent = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema);

const optionalSecret = () => blankAsAbsent(z.string().min(1).optional());
const textWithDefault = (fallback: string) =>
  blankAsAbsent(z.string().min(1).default(fallback));

const EnvSchema = z.object({
  PORT: numeric(3000, 1, 65535),
  DATABASE_PATH: textWithDefault('./data/feedback.db'),
  ANTHROPIC_API_KEY: optionalSecret(),
  ANTHROPIC_MODEL: textWithDefault('claude-opus-5'),
  ANTHROPIC_MAX_TOKENS: numeric(4096, 256, 64_000),
  GEMINI_API_KEY: optionalSecret(),
  GEMINI_MODEL: textWithDefault('gemini-3-flash-preview'),
  GEMINI_MAX_TOKENS: numeric(4096, 256, 64_000),
  WORKER_CONCURRENCY: numeric(2, 1, 32),
  MAX_ANALYSIS_ATTEMPTS: numeric(3, 1, 10),
  MAX_FEEDBACK_LENGTH: numeric(5000, 1, 100_000),
  AI_PROVIDER: z.enum(['auto', 'fake', 'anthropic', 'gemini']).default('auto'),
  LOG_LEVEL: z.string().default('info'),
});

/** Which analysis backend the app will actually use this run. */
export type ResolvedProvider = 'anthropic' | 'gemini' | 'fake';

export type Config = z.infer<typeof EnvSchema> & {
  /** Resolved from AI_PROVIDER plus which keys are actually present. */
  readonly resolvedProvider: ResolvedProvider;
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

  return { ...cfg, resolvedProvider: resolveProvider(cfg) };
}

/**
 * Picks the backend.
 *
 * An explicit AI_PROVIDER is honoured or the app refuses to boot — asking for a
 * real model and silently getting a simulated one is the worst possible outcome,
 * so a missing key is a startup failure rather than a downgrade.
 *
 * `auto` (the default) prefers Gemini, then Anthropic, then falls back to the
 * fake provider so the project runs with no credentials at all. Gemini first
 * because its free tier means a reviewer is more likely to have that key.
 */
function resolveProvider(cfg: z.infer<typeof EnvSchema>): ResolvedProvider {
  if (cfg.AI_PROVIDER === 'fake') return 'fake';

  if (cfg.AI_PROVIDER === 'anthropic') {
    if (!cfg.ANTHROPIC_API_KEY) {
      throw new Error('AI_PROVIDER=anthropic requires ANTHROPIC_API_KEY to be set.');
    }
    return 'anthropic';
  }

  if (cfg.AI_PROVIDER === 'gemini') {
    if (!cfg.GEMINI_API_KEY) {
      throw new Error('AI_PROVIDER=gemini requires GEMINI_API_KEY to be set.');
    }
    return 'gemini';
  }

  if (cfg.GEMINI_API_KEY) return 'gemini';
  if (cfg.ANTHROPIC_API_KEY) return 'anthropic';
  return 'fake';
}
