export type JobHandler = (feedbackId: string) => Promise<void>;

export interface QueueLogger {
  info(msg: string): void;
  error(msg: string): void;
}

/**
 * A minimal in-process work queue with bounded concurrency.
 *
 * The brief permits an in-process queue, so this is deliberately about 70 lines
 * rather than a broker integration. The important design choice is what it is
 * NOT responsible for: the queue holds no state that matters. Every fact about
 * a feedback item — its status, its attempt count, its error — lives in the
 * database. This object is a scheduling hint and nothing more.
 *
 * That is what makes the production swap cheap: replacing it with SQS or a
 * Redis-backed worker changes this file and `index.ts`, and nothing else.
 * It is also what makes a process crash survivable, since the DB still knows
 * exactly what was in flight (see FeedbackRepository.recoverStranded).
 */
export class AnalysisQueue {
  private readonly pending: string[] = [];
  private readonly inFlight = new Set<Promise<void>>();
  /** Retries waiting out their backoff. Counted in `depth` — see below. */
  private readonly scheduled = new Set<NodeJS.Timeout>();
  private running = false;
  private idleResolvers: Array<() => void> = [];

  constructor(
    private readonly handler: JobHandler,
    private readonly concurrency: number,
    private readonly logger: QueueLogger,
  ) {}

  start(): void {
    this.running = true;
    this.pump();
  }

  enqueue(feedbackId: string): void {
    this.pending.push(feedbackId);
    this.pump();
  }

  enqueueAll(feedbackIds: string[]): void {
    this.pending.push(...feedbackIds);
    this.pump();
  }

  /**
   * Enqueues after a delay, for retry backoff.
   *
   * The timer is tracked rather than fired and forgotten. An item waiting out
   * its backoff is still outstanding work: if it did not count towards `depth`,
   * the queue would report itself idle while a retry was pending, and `drain()`
   * would let the process exit with that retry never having run.
   */
  enqueueAfter(feedbackId: string, delayMs: number): void {
    const timer = setTimeout(() => {
      this.scheduled.delete(timer);
      if (this.running) {
        this.enqueue(feedbackId);
      } else {
        // Shut down while waiting. The row is still RECEIVED in the database,
        // so the next boot picks it up.
        this.settleIdleWaiters();
      }
    }, delayMs);

    // Deliberately NOT unref'd. An unref'd timer lets the event loop drain
    // while a retry is still pending, so the process exits and the retry is
    // silently dropped. In the HTTP server that was masked by the listening
    // socket; anywhere else (a CLI drain, a batch job, a future worker process)
    // it lost work. A pending retry is real outstanding work and should keep
    // the process alive exactly like an in-flight job does.
    //
    // This cannot delay shutdown, because drain() clears these timers rather
    // than awaiting them.
    this.scheduled.add(timer);
  }

  /** Everything outstanding: queued, running, or waiting on a backoff timer. */
  get depth(): number {
    return this.pending.length + this.inFlight.size + this.scheduled.size;
  }

  /** Resolves when nothing is queued or running. Used by tests and shutdown. */
  async onIdle(): Promise<void> {
    if (this.depth === 0) return;
    await new Promise<void>((resolve) => this.idleResolvers.push(resolve));
  }

  /**
   * Stops accepting new work and waits for in-flight jobs to finish.
   *
   * Pending backoff timers are cancelled rather than awaited: those rows are
   * still RECEIVED in the database, so the next boot re-queues them. Blocking
   * shutdown on a backoff that might be seconds away buys nothing.
   */
  async drain(): Promise<void> {
    this.running = false;
    for (const timer of this.scheduled) clearTimeout(timer);
    this.scheduled.clear();
    await Promise.allSettled([...this.inFlight]);
  }

  private pump(): void {
    if (!this.running) return;

    while (this.inFlight.size < this.concurrency && this.pending.length > 0) {
      const id = this.pending.shift()!;

      const job = this.handler(id)
        .catch((error: unknown) => {
          // The handler is expected to persist its own failures. Reaching here
          // means a bug in the handler itself, so it must not kill the worker
          // pool — it gets logged and the loop continues.
          this.logger.error(
            `Unhandled error while analysing ${id}: ${
              error instanceof Error ? error.stack ?? error.message : String(error)
            }`,
          );
        })
        .finally(() => {
          this.inFlight.delete(job);
          this.pump();
          this.settleIdleWaiters();
        });

      this.inFlight.add(job);
    }

    this.settleIdleWaiters();
  }

  private settleIdleWaiters(): void {
    if (this.depth > 0 || this.idleResolvers.length === 0) return;
    const waiters = this.idleResolvers;
    this.idleResolvers = [];
    for (const resolve of waiters) resolve();
  }
}
