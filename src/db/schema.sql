-- Applied idempotently at boot. For a 3-hour build this is deliberately a
-- single always-current schema file rather than a numbered migration chain;
-- the tradeoff is documented in the README.

CREATE TABLE IF NOT EXISTS feedback (
  id            TEXT PRIMARY KEY,
  content       TEXT NOT NULL,
  -- SHA-256 of the normalized content. Drives the dedup/cache guardrail.
  content_hash  TEXT NOT NULL,
  status        TEXT NOT NULL
                  CHECK (status IN ('RECEIVED', 'ANALYZING', 'DONE', 'FAILED')),
  -- Number of analysis attempts consumed so far, across retries.
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_content_hash ON feedback (content_hash);
CREATE INDEX IF NOT EXISTS idx_feedback_status       ON feedback (status);
CREATE INDEX IF NOT EXISTS idx_feedback_created_at   ON feedback (created_at DESC);

-- The VALIDATED result. One row per feedback item, written only after the AI
-- output has passed schema validation.
CREATE TABLE IF NOT EXISTS analyses (
  feedback_id        TEXT PRIMARY KEY
                       REFERENCES feedback (id) ON DELETE CASCADE,
  sentiment          TEXT NOT NULL
                       CHECK (sentiment IN ('positive', 'neutral', 'negative')),
  feature_requests   TEXT NOT NULL,  -- JSON array, validated before insert
  actionable_insight TEXT NOT NULL,
  model              TEXT NOT NULL,
  -- 1 when this result was copied from an earlier identical submission
  -- instead of costing a fresh LLM call. Keeps the guardrail observable.
  from_cache         INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL
);

-- The RAW audit trail. One row per LLM call, success or failure.
-- Separate from `analyses` because the raw response matters most precisely
-- when validation failed and there is no validated result to attach it to.
CREATE TABLE IF NOT EXISTS analysis_attempts (
  id           TEXT PRIMARY KEY,
  feedback_id  TEXT NOT NULL REFERENCES feedback (id) ON DELETE CASCADE,
  attempt_no   INTEGER NOT NULL,
  raw_response TEXT,
  error        TEXT,
  error_kind   TEXT,
  duration_ms  INTEGER NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attempts_feedback_id
  ON analysis_attempts (feedback_id, attempt_no);
