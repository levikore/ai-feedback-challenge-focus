import { createHash } from 'node:crypto';

export const FEEDBACK_STATUSES = ['RECEIVED', 'ANALYZING', 'DONE', 'FAILED'] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/**
 * The legal state graph, declared once.
 *
 *   RECEIVED -> ANALYZING -> DONE
 *                         -> FAILED -> RECEIVED   (retry)
 *
 * ANALYZING -> RECEIVED also exists, but only for crash recovery at boot:
 * a row left mid-analysis by a dead process is returned to the queue.
 */
const LEGAL_TRANSITIONS: Record<FeedbackStatus, readonly FeedbackStatus[]> = {
  RECEIVED: ['ANALYZING', 'DONE'], // DONE directly = served from the cache
  ANALYZING: ['DONE', 'FAILED', 'RECEIVED'],
  FAILED: ['RECEIVED'],
  DONE: [],
};

export function isLegalTransition(from: FeedbackStatus, to: FeedbackStatus): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export function isTerminal(status: FeedbackStatus): boolean {
  return status === 'DONE' || status === 'FAILED';
}

/**
 * Normalize before hashing so that trivially different submissions of the same
 * complaint ("Too slow!" vs "  too   slow! ") share a cache entry. Punctuation
 * is deliberately NOT stripped: it can carry sentiment, and collapsing it would
 * make the cache return an analysis for text the user did not actually write.
 */
export function normalizeContent(content: string): string {
  return content.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function hashContent(content: string): string {
  return createHash('sha256').update(normalizeContent(content), 'utf8').digest('hex');
}

export interface FeedbackRow {
  id: string;
  content: string;
  content_hash: string;
  status: FeedbackStatus;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface AnalysisRow {
  feedback_id: string;
  sentiment: string;
  feature_requests: string;
  actionable_insight: string;
  model: string;
  from_cache: number;
  created_at: string;
}

export function nowIso(): string {
  return new Date().toISOString();
}
