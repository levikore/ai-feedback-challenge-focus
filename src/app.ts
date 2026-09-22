import { Analyzer } from './ai/analyzer.js';
import { AnthropicProvider } from './ai/anthropicProvider.js';
import { FakeProvider } from './ai/fakeProvider.js';
import { GeminiProvider } from './ai/geminiProvider.js';
import type { AnalysisProvider } from './ai/provider.js';
import type { Config } from './config.js';
import { openDatabase, type Db } from './db/connection.js';
import { AnalysisQueue } from './queue/analysisQueue.js';
import { AnalysisRepository } from './repositories/analysisRepository.js';
import { FeedbackRepository } from './repositories/feedbackRepository.js';
import { FeedbackService, type ServiceLogger } from './services/feedbackService.js';

export interface App {
  db: Db;
  queue: AnalysisQueue;
  service: FeedbackService;
  providerName: string;
  /** Ids that were stranded mid-analysis by a previous process. */
  recoveredIds: string[];
  shutdown: () => Promise<void>;
}

export interface WireOptions {
  config: Config;
  logger: ServiceLogger;
  /** Injected by the tests to drive specific provider behaviour. */
  provider?: AnalysisProvider;
}

/**
 * Composition root.
 *
 * Every dependency is constructed here and passed down explicitly. There are no
 * module-level singletons, which is precisely why the tests can stand up a
 * complete, isolated application against an in-memory database in three lines.
 */
/**
 * Instantiates the configured analysis backend.
 *
 * The only place in the application that knows more than one provider exists.
 * Everything downstream sees an `AnalysisProvider` and nothing else.
 */
function buildProvider(config: Config, logger: ServiceLogger): AnalysisProvider {
  switch (config.resolvedProvider) {
    case 'gemini':
      return new GeminiProvider(
        config.GEMINI_API_KEY!,
        config.GEMINI_MODEL,
        config.GEMINI_MAX_TOKENS,
      );

    case 'anthropic':
      return new AnthropicProvider(
        config.ANTHROPIC_API_KEY!,
        config.ANTHROPIC_MODEL,
        config.ANTHROPIC_MAX_TOKENS,
      );

    case 'fake':
      logger.warn(
        'No GEMINI_API_KEY or ANTHROPIC_API_KEY found — running on the deterministic ' +
          'FakeProvider. Analyses are SIMULATED, not produced by a model.',
      );
      return new FakeProvider();
  }
}

export function wireApp({ config, logger, provider }: WireOptions): App {
  const db = openDatabase(config.DATABASE_PATH);

  const feedbackRepo = new FeedbackRepository(db);
  const analysisRepo = new AnalysisRepository(db);

  const resolvedProvider = provider ?? buildProvider(config, logger);

  const analyzer = new Analyzer(resolvedProvider);

  // Constructed before the service so the service can hold a reference, then
  // given the service's worker body. A small circularity, resolved with a
  // closure rather than by letting the queue know what a FeedbackService is.
  let service: FeedbackService;
  const queue = new AnalysisQueue(
    (id) => service.processOne(id),
    config.WORKER_CONCURRENCY,
    logger,
  );

  service = new FeedbackService({
    feedback: feedbackRepo,
    analyses: analysisRepo,
    analyzer,
    queue,
    logger,
    maxAttempts: config.MAX_ANALYSIS_ATTEMPTS,
  });

  // Crash recovery, before any new work is accepted: rows left ANALYZING by a
  // dead process go back to RECEIVED, then everything pending is re-queued.
  const recoveredIds = feedbackRepo.recoverStranded();
  queue.start();
  queue.enqueueAll(feedbackRepo.findPendingIds());

  return {
    db,
    queue,
    service,
    providerName: resolvedProvider.name,
    recoveredIds,
    shutdown: async () => {
      await queue.drain();
      db.close();
    },
  };
}
