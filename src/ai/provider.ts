/**
 * The seam between the application and whatever is producing the analysis.
 *
 * Everything above this file is provider-agnostic: the queue, the services and
 * the tests only know that something returns raw text for a piece of feedback.
 */
export interface ProviderResult {
  /** The raw payload exactly as the provider produced it, before validation. */
  raw: string;
  /** Identifier recorded alongside the result, e.g. the model name. */
  model: string;
}

export interface AnalysisProvider {
  readonly name: string;
  analyze(content: string): Promise<ProviderResult>;
}

/**
 * Failure taxonomy.
 *
 * The distinction that matters is not "what went wrong" but "is trying again
 * likely to produce a different outcome". Everything the worker does with a
 * failure hangs off this one boolean.
 */
export type ProviderErrorKind =
  | 'rate_limit' // 429 — retry after a pause
  | 'transient' // 5xx, timeout, connection reset — retry
  | 'auth' // 401/403 — a human must fix the credentials
  | 'invalid_request' // 400/404 — our request or model id is wrong
  | 'truncated' // the model was cut off by max_tokens mid-answer
  | 'malformed_output'; // the model answered, but not in the agreed shape

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: ProviderErrorKind,
    /** Present when the model responded but the response was unusable. */
    readonly raw: string | null = null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ProviderError';
  }

  /**
   * Whether re-issuing the same request could plausibly succeed.
   *
   * `malformed_output` is explicitly NOT retryable: the prompt is deterministic,
   * so the same input produces the same bad shape and a retry only burns tokens
   * to reach the same conclusion more slowly. Fixing it requires a prompt or
   * schema change, which is a deploy, not a retry.
   *
   * `truncated` is not retryable for the same reason, and is kept distinct from
   * `malformed_output` because the fix is completely different: raise the token
   * ceiling, rather than go looking for a bug in the prompt or the schema.
   */
  get retryable(): boolean {
    return this.kind === 'rate_limit' || this.kind === 'transient';
  }
}
