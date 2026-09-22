# Feedback Insights API

A backend that accepts free-text product feedback, persists it immediately, and
extracts structured insights with an LLM **asynchronously** — with explicit
state, validated AI output, and failures that are visible and retriable.

Built for the AI-Assisted Engineering Challenge. Node.js + TypeScript.

---

## Setup

```bash
npm install
npm run dev
```

That is the whole setup. **No API key is required.** With `ANTHROPIC_API_KEY`
unset the app runs on a deterministic `FakeProvider` and every path in the
system — analysis, caching, validation failure, retry — works and is
demonstrable. Set the key to use the real model:

```bash
cp .env.example .env    # then fill in ANTHROPIC_API_KEY
```

Environment variables are documented in [`.env.example`](.env.example).

### See it work

```bash
npm run dev             # terminal 1
./scripts/demo.sh       # terminal 2
```

`scripts/demo.sh` walks the entire system end to end: async submission, a cache
hit, a schema-validation failure, a manual retry, automatic retry of a transient
failure, and the read API. It is the intended script for the screen recording.

```bash
npm test                # 50 tests, no key required
npm run typecheck
```

---

## API

| Method | Path | Notes |
|---|---|---|
| `GET` | `/health` | Also reports the active provider and queue depth. |
| `POST` | `/api/feedback` | `{"content": "..."}` → **201**, returns immediately as `RECEIVED`. |
| `GET` | `/api/feedback` | `?status=` `?limit=` `?offset=`. Includes the analysis where available. |
| `GET` | `/api/feedback/:id` | 404 if unknown. |
| `POST` | `/api/feedback/:id/retry` | **409** unless the item is `FAILED`. |

```bash
curl -X POST localhost:3000/api/feedback \
  -H 'content-type: application/json' \
  -d '{"content":"The CSV export is painfully slow. I wish I could schedule it overnight."}'
```

```jsonc
{
  "id": "3e1e50f4-…",
  "status": "RECEIVED",        // the request did not wait for the model
  "attempts": 0,
  "error": null,
  "analysis": null,            // …and is populated once the worker finishes
  "created_at": "2026-09-22T10:34:22.338Z",
  "updated_at": "2026-09-22T10:34:22.338Z"
}
```

---

## Design decisions

### State is in the database; the queue is only a scheduling hint

Every fact about a feedback item — its status, attempt count, last error — lives
in SQLite. The in-process queue holds ids and nothing else.

This is the decision the rest of the design hangs off. It means a process crash
loses no information, the queue can be swapped for SQS or Redis by changing two
files, and correctness never depends on an in-memory structure staying in sync
with a row.

### Every state change is a guarded, atomic transition

`RECEIVED → ANALYZING → DONE | FAILED`, plus `FAILED → RECEIVED` on retry and
`ANALYZING → RECEIVED` for crash recovery. There is exactly one method that
changes a status ([`FeedbackRepository.transition`](src/repositories/feedbackRepository.ts)),
and it issues:

```sql
UPDATE feedback SET status = :to … WHERE id = :id AND status = :from
```

`changes === 0` means the caller lost the race or attempted an illegal move; in
both cases the correct response is to do nothing. Claiming an item is therefore
a single atomic statement, and two workers cannot both believe they own a row.
Transitions outside the declared state graph throw rather than return false —
those are caller bugs, not race outcomes.

### Crash recovery

A row found in `ANALYZING` at boot cannot have a live worker behind it. Those
rows are returned to `RECEIVED` and re-queued, with the reason recorded in
`last_error`. Without this, a restart silently orphans work — the failure mode
you only discover in production.

### Two tables for AI output, not one

`analyses` holds validated results. `analysis_attempts` holds one row per LLM
call — raw response, error, error kind, duration — whether it succeeded or not.

The brief asks for both the raw response and the validated result to be
persisted. They cannot share a table, because the raw response matters *most*
when validation failed, and in that case there is no validated result to attach
it to. Splitting them is what makes a schema failure debuggable: you can see
exactly what the model returned and exactly why it was rejected.

### Forcing structure, then validating it anyway

The request uses **forced tool use** (`tool_choice: {type: "tool"}`) with the
JSON schema as the tool's `input_schema`, rather than asking for JSON in prose.
That removes markdown fences, preambles and trailing commentary as failure
modes at the source.

The output is **still** validated with Zod afterwards. A constrained decode is a
strong prior, not a guarantee, and the brief requires explicit validation.
The Zod schema is `.strict()`: an unexpected key means the model answered a
different question than the one asked, and silently dropping it would hide that.

The tool's JSON Schema is written by hand rather than generated from the Zod
schema — deliberately. They serve different purposes: one shapes generation, the
other decides what gets stored. Deriving the gate from the hint would let a
single conversion bug weaken both at once.

### Retry policy distinguishes "unlucky" from "wrong"

| Failure | Retried? | Why |
|---|---|---|
| 429, 5xx, timeout, connection reset | Yes, up to `MAX_ANALYSIS_ATTEMPTS` with exponential backoff | A different outcome is plausible. |
| Output fails schema validation | **No** — straight to `FAILED` | The prompt is deterministic. The same input yields the same bad shape; a retry burns tokens to reach the same conclusion more slowly. Fixing it needs a prompt or schema change, which is a deploy. |
| 401 / 403 / 400 / 404 | No | A human has to fix the credential or the request. |
| Output truncated by `max_tokens` | No | Retrying the identical request truncates identically. Kept distinct from a schema failure because the fix is different: raise `ANTHROPIC_MAX_TOKENS`, rather than go hunting for a bug in the prompt. |

A **manual** retry via the API resets the attempt counter, so it gets a full
budget rather than a single shot. Pressing "retry" is a deliberate act by someone
who has usually just fixed something — waited out a rate-limit window, restored a
credential — and carrying the exhausted counter across would make that retry mean
something different from what the operator intends.

That distinction is the point of the error taxonomy in
[`src/ai/provider.ts`](src/ai/provider.ts), and it is why `ProviderError` carries
a `kind` rather than just a message.

The SDK client is constructed with `maxRetries: 0`. Retry policy belongs to the
worker, which owns the persisted attempt counter; two independent retry loops
stacked on each other multiply rather than add.

### Guardrail: hash-based analysis cache

*(One guardrail, as the brief requires.)*

On submit, the content is normalized (trim, collapse whitespace, lowercase) and
hashed with SHA-256. If an earlier item with the same hash already has a
validated analysis, the result is copied onto the new row, which goes straight to
`DONE` — **no model call, no spend**.

**A cache alone is not enough.** The lookup above only matches items that have
already reached `DONE`, so duplicates arriving *while the first analysis is
still running* would each buy their own call — and against a real model that
window is seconds wide, which is exactly when a burst of identical feedback
turns up. So submissions also check for an in-flight identical item:

- the first copy is the **leader** and is queued normally;
- later copies become **followers** — persisted, left `RECEIVED`, deliberately
  *not* queued;
- when the leader finishes, its analysis is fanned out to every follower, which
  go straight to `DONE` with `from_cache = 1`;
- if the leader *fails*, exactly one follower is promoted to leader and requeued.
  One at a time, not all of them, so a bad input degrades attempt by attempt
  instead of stampeding the provider.

Measured: six identical submissions against a 300ms provider cost **one** model
call. Before the fan-out they cost six.

Three further judgment calls worth naming:

- **The new submission row is still created**, not collapsed into the original.
  Each submission is a real event with its own identity and timestamp; returning
  someone else's id would corrupt the audit trail and break "20 people reported
  this" analytics. The guardrail exists to avoid redundant *spend*, and copying
  the result achieves that completely.
- **`from_cache` is persisted and exposed in the API.** A guardrail you cannot
  observe is a guardrail you cannot debug or measure.
- **Punctuation is not stripped during normalization.** It carries sentiment,
  and collapsing it would risk serving an analysis for text the user did not
  write. Whitespace and case are safe to fold; punctuation is not.

Chosen over rate-limiting because it removes work rather than deferring it, and
because it is directly observable in a demo. Its weakness is honest: it only
catches *exact* duplicates. Near-duplicates ("app is slow" vs "the app is so
slow") still cost a call — semantic dedup would need embeddings, which is a
different project.

### Other choices

- **Fastify** over Express: better TypeScript types, and `app.inject()` lets the
  API tests run without binding a port.
- **`better-sqlite3`** and its synchronous API: for a single-process service
  that is a feature. It removes interleaving between a read and the write that
  depends on it — the usual source of state-machine races in a worker.
- **Zod at every boundary**: request bodies, query strings, environment
  variables, and AI output each get their own schema. They are separate
  contracts and should not share a definition.
- **Analyses are re-validated on read.** The database is not the schema
  authority; the Zod schema is. A row written by an older build or edited by
  hand cannot silently serve a shape the API contract no longer allows.
- **Composition root in [`src/app.ts`](src/app.ts)**: no module-level
  singletons, which is exactly why a test can stand up a complete isolated
  application against an in-memory database in three lines.
- **Backoff timers are not `unref`'d.** A pending retry is real outstanding work
  and keeps the process alive, exactly as an in-flight job does. It cannot delay
  shutdown, because `drain()` clears those timers rather than awaiting them.

---

## Tradeoffs made for the timebox

Conscious omissions, not oversights:

| Not built | Why, and what I would do instead |
|---|---|
| Migration chain | One idempotent `schema.sql` applied at boot. A second schema change would justify numbered migrations; the first does not. |
| Durable queue | In-process, which the brief permits. The DB-as-source-of-truth design is what keeps the swap to SQS/Redis cheap. |
| Auth, rate limiting, deployment | Explicitly out of scope per the brief. |
| Structured log shipping, metrics | Fastify's logger only. `analysis_attempts` already holds the latency and failure data a dashboard would need. |
| Exhaustive tests | 50 tests aimed at what carries risk — the state machine, the schema gate, the failure taxonomy, the guardrail. The brief says coverage is not graded, so I spent the budget on the paths where a bug would be silent. |
| Dead-letter handling beyond `FAILED` | `FAILED` + an explicit retry endpoint covers the requirement. A real system would alert on the `FAILED` count. |

## What I would do with more time

1. **Load-shed the queue.** It is unbounded; a burst of submissions grows it
   without limit. A cap with backpressure (503 on submit) is the honest fix.
2. **Semantic dedup** via embeddings, to catch near-duplicate feedback the hash
   guardrail misses.
3. **Confidence calibration.** Nothing currently checks whether the model's
   `confidence` numbers mean anything. I would sample a few hundred analyses and
   measure before letting any downstream logic threshold on them.
4. **A golden-set eval** for the prompt — a fixed set of feedback with expected
   sentiment and feature requests, run in CI, so prompt edits are measured
   rather than eyeballed.
5. **Prompt-injection hardening.** Feedback is already wrapped in `<feedback>`
   tags and the system prompt says to treat it as data, but that is a mitigation,
   not a guarantee. A separate output check that the analysis actually relates to
   the input would be the next layer.
6. **Per-item idempotency keys** on submit, so a client retrying a failed HTTP
   request cannot create a second row.

---

## AI Collaboration Log

See **[AI_COLLABORATION_LOG.md](AI_COLLABORATION_LOG.md)**.
