import type { Analyzer } from '../ai/analyzer.js';
import { ProviderError } from '../ai/provider.js';
import type { Analysis } from '../domain/analysisSchema.js';
import type { AnalysisRow, FeedbackRow, FeedbackStatus } from '../domain/feedback.js';
import type { AnalysisQueue } from '../queue/analysisQueue.js';
import type { AnalysisRepository } from '../repositories/analysisRepository.js';
import type { FeedbackRepository } from '../repositories/feedbackRepository.js';

export interface FeedbackView {
  id: string;
  content: string;
  status: FeedbackStatus;
  attempts: number;
  error: string | null;
  analysis: (Analysis & { model: string; from_cache: boolean }) | null;
  created_at: string;
  updated_at: string;
}

export interface ServiceLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export class FeedbackNotFoundError extends Error {
  constructor(id: string) {
    super(`No feedback with id ${id}`);
    this.name = 'FeedbackNotFoundError';
  }
}

export class InvalidRetryError extends Error {
  constructor(readonly status: FeedbackStatus) {
    super(`Only FAILED feedback can be retried; this item is ${status}.`);
    this.name = 'InvalidRetryError';
  }
}

export interface FeedbackServiceDeps {
  feedback: FeedbackRepository;
  analyses: AnalysisRepository;
  analyzer: Analyzer;
  queue: AnalysisQueue;
  logger: ServiceLogger;
  maxAttempts: number;
}

export class FeedbackService {
  constructor(private readonly deps: FeedbackServiceDeps) {}

  /**
   * Accepts feedback and returns immediately.
   *
   * Nothing here awaits the model. The row is written, the id is handed to the
   * queue, and the caller gets a response — the whole point of the async
   * requirement.
   */
  submit(content: string): FeedbackView {
    const { feedback, analyses, queue, logger } = this.deps;

    const row = feedback.create(content);

    // ---- Guardrail: hash-based analysis cache -------------------------------
    // If identical feedback has already been analysed, reuse the result instead
    // of paying for the same answer twice. See the README for why the new row
    // is still created rather than collapsed into the original.
    const cacheSource = feedback.findCacheSource(row.content_hash);
    if (cacheSource) {
      const sourceRow = analyses.findByFeedbackId(cacheSource.id);
      const cached = sourceRow ? analyses.toAnalysis(sourceRow) : null;

      if (cached && sourceRow) {
        analyses.saveAnalysis(row.id, cached, sourceRow.model, true);
        // RECEIVED -> DONE without passing through ANALYZING: no analysis ran.
        // Claiming otherwise would put a lie in the audit trail.
        feedback.transition(row.id, 'RECEIVED', 'DONE');
        logger.info(`Cache hit for ${row.id} (source ${cacheSource.id}); skipped AI call.`);
        return this.view(feedback.findById(row.id)!);
      }
      // A DONE row whose stored analysis no longer validates. Fall through and
      // re-analyse rather than propagate a payload the schema has rejected.
      logger.warn(
        `Cache source ${cacheSource.id} holds an analysis that failed re-validation; re-analysing ${row.id}.`,
      );
    }

    // No finished analysis to copy — but an identical submission may already be
    // on its way through. If so this row becomes a *follower*: it is created
    // and left RECEIVED, and deliberately NOT queued. The in-flight leader's
    // result is fanned out to it on completion.
    //
    // Without this, the cache only helps once the first analysis has landed,
    // so a burst of identical feedback — the case the guardrail exists for —
    // would buy one LLM call per submission.
    const leader = feedback.findInFlightByHash(row.content_hash, row.id);
    if (leader) {
      logger.info(`${row.id} is a duplicate of in-flight ${leader.id}; awaiting its result.`);
      return this.view(row);
    }
    // ------------------------------------------------------------------------

    queue.enqueue(row.id);
    return this.view(row);
  }

  get(id: string): FeedbackView {
    const row = this.deps.feedback.findById(id);
    if (!row) throw new FeedbackNotFoundError(id);
    return this.view(row);
  }

  list(opts: { status?: FeedbackStatus; limit: number; offset: number }): {
    items: FeedbackView[];
    total: number;
    limit: number;
    offset: number;
  } {
    const rows = this.deps.feedback.list(opts);
    // One query for all analyses rather than one per row. The map is passed
    // down whole rather than per-row: a row with no analysis yields `undefined`
    // from .get(), which is indistinguishable from "nothing was preloaded" and
    // used to send view() back to the database for every RECEIVED or FAILED
    // item — turning this into limit+1 queries for exactly those pages.
    const analysisRows = this.deps.analyses.findByFeedbackIds(rows.map((r) => r.id));

    return {
      items: rows.map((row) => this.view(row, analysisRows)),
      total: this.deps.feedback.count(opts.status),
      limit: opts.limit,
      offset: opts.offset,
    };
  }

  /** Puts a FAILED item back on the queue. Anything else is a 409. */
  retry(id: string): FeedbackView {
    const { feedback, queue } = this.deps;

    const row = feedback.findById(id);
    if (!row) throw new FeedbackNotFoundError(id);
    if (row.status !== 'FAILED') throw new InvalidRetryError(row.status);

    // If this loses the race, another retry already requeued the item and
    // there is nothing left to do.
    // resetAttempts: a manual retry is a deliberate act by an operator who has
    // usually just fixed something — waited out a rate-limit window, restored a
    // credential. Carrying the exhausted counter over would give that retry a
    // single attempt and no backoff, which is not what "retry" means to anyone
    // pressing the button.
    const claimed = feedback.transition(id, 'FAILED', 'RECEIVED', {
      resetAttempts: true,
      lastError: null,
    });

    // Snapshot before enqueueing. A worker can claim the item the instant it
    // is queued, and a response that says ANALYZING or even DONE depending on
    // scheduling is a response the client cannot reason about. What this call
    // is reporting is that the retry was accepted.
    const view = this.view(feedback.findById(id)!);

    if (claimed) queue.enqueue(id);

    return view;
  }

  /**
   * The worker body. Runs one feedback item through the model.
   *
   * Every exit path leaves the row in a terminal state or back in the queue —
   * there is no branch that returns with the row still ANALYZING.
   */
  async processOne(feedbackId: string): Promise<void> {
    const { feedback, analyses, analyzer, queue, logger, maxAttempts } = this.deps;

    const row = feedback.findById(feedbackId);
    if (!row) {
      logger.warn(`Queued id ${feedbackId} no longer exists; dropping.`);
      return;
    }

    // Atomically claim the item. Losing this race means another worker owns it.
    if (!feedback.transition(feedbackId, 'RECEIVED', 'ANALYZING', { incrementAttempts: true })) {
      logger.info(`Skipping ${feedbackId}: already claimed by another worker.`);
      return;
    }

    const attemptNo = analyses.attemptCount(feedbackId) + 1;
    const startedAt = Date.now();

    try {
      const outcome = await analyzer.analyze(row.content);

      analyses.recordAttempt({
        feedbackId,
        attemptNo,
        rawResponse: outcome.raw,
        error: null,
        errorKind: null,
        durationMs: outcome.durationMs,
      });
      analyses.saveAnalysis(feedbackId, outcome.analysis, outcome.model, false);
      feedback.transition(feedbackId, 'ANALYZING', 'DONE', { lastError: null });

      logger.info(`Analysed ${feedbackId} in ${outcome.durationMs}ms (${outcome.model}).`);

      this.fanOutToFollowers(row, outcome.analysis, outcome.model);
    } catch (error) {
      const providerError =
        error instanceof ProviderError
          ? error
          : new ProviderError(
              error instanceof Error ? error.message : String(error),
              'transient',
              null,
              { cause: error },
            );

      analyses.recordAttempt({
        feedbackId,
        attemptNo,
        rawResponse: providerError.raw,
        error: providerError.message,
        errorKind: providerError.kind,
        durationMs: Date.now() - startedAt,
      });

      const current = feedback.findById(feedbackId)!;
      const budgetLeft = current.attempts < maxAttempts;

      if (providerError.retryable && budgetLeft) {
        // Back to RECEIVED and re-queued. The attempt counter is already
        // incremented and persisted, so the budget survives a crash here.
        feedback.transition(feedbackId, 'ANALYZING', 'RECEIVED', {
          lastError: `${providerError.kind}: ${providerError.message}`,
        });
        logger.warn(
          `Retrying ${feedbackId} after ${providerError.kind} ` +
            `(attempt ${current.attempts}/${maxAttempts}): ${providerError.message}`,
        );
        queue.enqueueAfter(feedbackId, backoffMs(current.attempts));
        return;
      }

      feedback.transition(feedbackId, 'ANALYZING', 'FAILED', {
        lastError: `${providerError.kind}: ${providerError.message}`,
      });

      logger.error(
        `Analysis of ${feedbackId} failed permanently (${providerError.kind}): ${providerError.message}`,
      );

      this.promoteFollower(row);
    }
  }

  /**
   * Copies a completed analysis onto every duplicate that was waiting on it.
   *
   * Followers were never queued, so no worker owns them and transitioning them
   * here cannot race anything. They are marked `from_cache` for the same reason
   * an ordinary cache hit is: the saving should be visible, not invisible.
   */
  private fanOutToFollowers(leader: FeedbackRow, analysis: Analysis, model: string): void {
    const { feedback, analyses, logger } = this.deps;

    const followers = feedback.findFollowers(leader.content_hash, leader.id);
    if (followers.length === 0) return;

    for (const follower of followers) {
      analyses.saveAnalysis(follower.id, analysis, model, true);
      // RECEIVED -> DONE directly: no analysis ran for this row.
      feedback.transition(follower.id, 'RECEIVED', 'DONE');
    }

    logger.info(
      `Fanned ${leader.id}'s analysis out to ${followers.length} waiting duplicate(s); ` +
        `${followers.length} LLM call(s) avoided.`,
    );
  }

  /**
   * Hands leadership to a waiting duplicate after the leader failed.
   *
   * Exactly one is promoted, not all of them: the rest stay followers behind
   * the new leader. If that one fails too, this runs again, so the chain
   * degrades one attempt at a time instead of stampeding the provider with the
   * very input that just failed.
   */
  private promoteFollower(failed: FeedbackRow): void {
    const { feedback, queue, logger } = this.deps;

    const next = feedback.findFollowers(failed.content_hash, failed.id)[0];
    if (!next) return;

    logger.info(`Promoting duplicate ${next.id} after ${failed.id} failed.`);
    queue.enqueue(next.id);
  }

  private view(row: FeedbackRow, preloaded?: Map<string, AnalysisRow>): FeedbackView {
    const analysisRow = preloaded ? preloaded.get(row.id) : this.deps.analyses.findByFeedbackId(row.id);
    const analysis = analysisRow ? this.deps.analyses.toAnalysis(analysisRow) : null;

    return {
      id: row.id,
      content: row.content,
      status: row.status,
      attempts: row.attempts,
      error: row.last_error,
      analysis:
        analysis && analysisRow
          ? { ...analysis, model: analysisRow.model, from_cache: analysisRow.from_cache === 1 }
          : null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}

/** 250ms, 500ms, 1s, ... capped. Short enough to demo, shaped like the real thing. */
function backoffMs(attempt: number): number {
  return Math.min(250 * 2 ** (attempt - 1), 8_000);
}
