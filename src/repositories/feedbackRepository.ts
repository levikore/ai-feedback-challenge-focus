import { randomUUID } from 'node:crypto';
import type { Db } from '../db/connection.js';
import {
  hashContent,
  isLegalTransition,
  nowIso,
  type FeedbackRow,
  type FeedbackStatus,
} from '../domain/feedback.js';

export interface ListOptions {
  status?: FeedbackStatus;
  limit: number;
  offset: number;
}

/**
 * All feedback SQL lives here. Nothing above this layer writes a query.
 */
export class FeedbackRepository {
  constructor(private readonly db: Db) {}

  create(content: string): FeedbackRow {
    const row: FeedbackRow = {
      id: randomUUID(),
      content,
      content_hash: hashContent(content),
      status: 'RECEIVED',
      attempts: 0,
      last_error: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    };

    this.db
      .prepare(
        `INSERT INTO feedback
           (id, content, content_hash, status, attempts, last_error, created_at, updated_at)
         VALUES
           (@id, @content, @content_hash, @status, @attempts, @last_error, @created_at, @updated_at)`,
      )
      .run(row);

    return row;
  }

  findById(id: string): FeedbackRow | undefined {
    return this.db.prepare('SELECT * FROM feedback WHERE id = ?').get(id) as
      | FeedbackRow
      | undefined;
  }

  /**
   * The most recent feedback with this content hash that already has a
   * validated analysis. Backs the dedup/cache guardrail.
   */
  findCacheSource(contentHash: string): FeedbackRow | undefined {
    return this.db
      .prepare(
        `SELECT f.* FROM feedback f
           JOIN analyses a ON a.feedback_id = f.id
          WHERE f.content_hash = ? AND f.status = 'DONE'
          ORDER BY f.created_at ASC
          LIMIT 1`,
      )
      .get(contentHash) as FeedbackRow | undefined;
  }

  list({ status, limit, offset }: ListOptions): FeedbackRow[] {
    const where = status ? 'WHERE status = ?' : '';
    const params = status ? [status, limit, offset] : [limit, offset];

    return this.db
      .prepare(
        `SELECT * FROM feedback ${where}
          ORDER BY created_at DESC, id DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...params) as FeedbackRow[];
  }

  count(status?: FeedbackStatus): number {
    const where = status ? 'WHERE status = ?' : '';
    const params = status ? [status] : [];
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM feedback ${where}`)
      .get(...params) as { n: number };
    return row.n;
  }

  /**
   * The only way a status ever changes.
   *
   * The `AND status = @from` clause makes the read-check-write a single atomic
   * statement: two workers racing for the same row cannot both win, because the
   * loser's UPDATE matches zero rows. `changes === 0` therefore means either
   * "someone else got there first" or "that transition is not legal from the
   * row's current state" — both of which the caller must treat as "not mine".
   *
   * Returns true only if this call is the one that performed the transition.
   */
  transition(
    id: string,
    from: FeedbackStatus,
    to: FeedbackStatus,
    opts: { incrementAttempts?: boolean; lastError?: string | null } = {},
  ): boolean {
    if (!isLegalTransition(from, to)) {
      throw new Error(`Illegal state transition requested: ${from} -> ${to}`);
    }

    const result = this.db
      .prepare(
        `UPDATE feedback
            SET status     = @to,
                updated_at = @updated_at,
                attempts   = attempts + @attemptDelta,
                last_error = @lastError
          WHERE id = @id AND status = @from`,
      )
      .run({
        id,
        from,
        to,
        updated_at: nowIso(),
        attemptDelta: opts.incrementAttempts ? 1 : 0,
        lastError: opts.lastError ?? null,
      });

    return result.changes === 1;
  }

  /**
   * Crash recovery. A row in ANALYZING when the process starts cannot have a
   * live worker behind it — the previous process died mid-analysis. Return
   * those rows to the queue rather than leaving the work orphaned.
   *
   * Returns the ids that were reset, so they can be logged.
   */
  recoverStranded(): string[] {
    const stranded = this.db
      .prepare(`SELECT id FROM feedback WHERE status = 'ANALYZING'`)
      .all() as Array<{ id: string }>;

    for (const { id } of stranded) {
      this.transition(id, 'ANALYZING', 'RECEIVED', {
        lastError: 'Recovered at startup: process exited during analysis.',
      });
    }

    return stranded.map((r) => r.id);
  }

  /** Every item still awaiting analysis, oldest first. Used to refill the queue at boot. */
  findPendingIds(): string[] {
    const rows = this.db
      .prepare(`SELECT id FROM feedback WHERE status = 'RECEIVED' ORDER BY created_at ASC`)
      .all() as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }
}
