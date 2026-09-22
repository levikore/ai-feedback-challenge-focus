import {
  AnalysisSchema,
  formatValidationError,
  type Analysis,
} from '../domain/analysisSchema.js';
import type { AnalysisProvider } from './provider.js';
import { ProviderError } from './provider.js';

export interface AnalyzeOutcome {
  analysis: Analysis;
  raw: string;
  model: string;
  durationMs: number;
}

/**
 * Calls the provider and refuses to return anything that has not passed the
 * schema.
 *
 * This is the only place a raw provider payload becomes a typed `Analysis`.
 * Keeping that conversion in one function is what makes "the AI output is
 * always validated" a property of the code rather than a convention people
 * are expected to remember.
 */
export class Analyzer {
  constructor(private readonly provider: AnalysisProvider) {}

  get providerName(): string {
    return this.provider.name;
  }

  async analyze(content: string): Promise<AnalyzeOutcome> {
    const startedAt = Date.now();
    const { raw, model } = await this.provider.analyze(content);
    const durationMs = Date.now() - startedAt;

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (error) {
      throw new ProviderError(
        `Provider returned text that is not JSON: ${(error as Error).message}`,
        'malformed_output',
        raw,
      );
    }

    const validated = AnalysisSchema.safeParse(parsedJson);
    if (!validated.success) {
      // The raw payload rides along on the error so the caller can persist it.
      // A validation failure with no record of what actually came back is an
      // unfixable bug report.
      throw new ProviderError(
        `AI output failed schema validation — ${formatValidationError(validated.error)}`,
        'malformed_output',
        raw,
      );
    }

    return { analysis: validated.data, raw, model, durationMs };
  }
}
