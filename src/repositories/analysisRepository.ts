import { randomUUID } from 'node:crypto';
import type { Db } from '../db/connection.js';
import { AnalysisSchema, type Analysis } from '../domain/analysisSchema.js';
import { nowIso, type AnalysisRow } from '../domain/feedback.js';

export interface AttemptRecord {
  feedbackId: string;
  attemptNo: number;
  rawResponse: string | null;
  error: string | null;
  errorKind: string | null;
  durationMs: number;
}

export class AnalysisRepository {
  constructor(private readonly db: Db) {}

  /** Persists a validated result. `from_cache` records how it was obtained. */
  saveAnalysis(
    feedbackId: string,
    analysis: Analysis,
    model: string,
    fromCache = false,
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO analyses
           (feedback_id, sentiment, feature_requests, actionable_insight, model, from_cache, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        feedbackId,
        analysis.sentiment,
        JSON.stringify(analysis.feature_requests),
        analysis.actionable_insight,
        model,
        fromCache ? 1 : 0,
        nowIso(),
      );
  }

  /**
   * Every LLM call gets a row here, whether it succeeded or not. This is the
   * "persist the raw AI response" requirement, and it is the only record that
   * survives a validation failure.
   */
  recordAttempt(a: AttemptRecord): void {
    this.db
      .prepare(
        `INSERT INTO analysis_attempts
           (id, feedback_id, attempt_no, raw_response, error, error_kind, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        a.feedbackId,
        a.attemptNo,
        a.rawResponse,
        a.error,
        a.errorKind,
        a.durationMs,
        nowIso(),
      );
  }

  findByFeedbackId(feedbackId: string): AnalysisRow | undefined {
    return this.db.prepare('SELECT * FROM analyses WHERE feedback_id = ?').get(feedbackId) as
      | AnalysisRow
      | undefined;
  }

  /** Bulk lookup, so listing N items stays one query rather than N. */
  findByFeedbackIds(ids: string[]): Map<string, AnalysisRow> {
    if (ids.length === 0) return new Map();

    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT * FROM analyses WHERE feedback_id IN (${placeholders})`)
      .all(...ids) as AnalysisRow[];

    return new Map(rows.map((r) => [r.feedback_id, r]));
  }

  attemptCount(feedbackId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM analysis_attempts WHERE feedback_id = ?')
      .get(feedbackId) as { n: number };
    return row.n;
  }

  /**
   * Re-validates on the way out.
   *
   * The DB is not the schema authority — the Zod schema is. Re-parsing on read
   * means a row written by an older build, a migration, or a direct SQL edit
   * cannot silently serve a shape the API contract no longer allows.
   */
  toAnalysis(row: AnalysisRow): Analysis | null {
    const candidate = {
      sentiment: row.sentiment,
      feature_requests: safeParseJson(row.feature_requests),
      actionable_insight: row.actionable_insight,
    };

    const parsed = AnalysisSchema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
  }
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
