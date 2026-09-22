# Feedback Insights API

A backend that accepts free-text product feedback, persists it immediately, and
extracts structured insights with an LLM **asynchronously** — with explicit
state, validated AI output, and failures that are visible and retriable.

Built for the AI-Assisted Engineering Challenge. Node.js + TypeScript.

---

## Demo:
https://drive.google.com/file/d/18FPcX4TP4-Z-1iUHPhDOJ2nrS5iRUEBp/view?usp=drive_web

## Setup

```bash
npm install
cp .env.example .env    # paste a key into GEMINI_API_KEY, or leave it blank
npm run dev
```

A `.env` file is loaded automatically. A **free** Gemini key takes about a
minute to get and needs no credit card: [aistudio.google.com](https://aistudio.google.com)
→ *Get API key* → *Create API key*. (Users in the EEA, UK or Switzerland must
enable billing even for free-tier models.) An inline env var also works and
overrides the file: `GEMINI_API_KEY=your-key npm run dev`.

### Providers

The LLM sits behind a two-method interface. `AI_PROVIDER` selects which
implementation is used:

| `AI_PROVIDER` | Key | Notes |
|---|---|---|
| `gemini` | `GEMINI_API_KEY` | Free tier. Structured output via a response schema. |
| `anthropic` | `ANTHROPIC_API_KEY` | Paid. Structured output via forced tool use. |
| `fake` | none | Deterministic stand-in. **Simulated, not a model.** |

`auto` (the default) uses Gemini if its key is present, then Anthropic, then the
fake provider — so `npm install && npm run dev` works with no credentials at
all. Naming a provider explicitly is honoured, and the app **refuses to start**
if that provider's key is missing, rather than silently downgrading to the fake
one. All configuration is documented in [`.env.example`](.env.example).

### See it work

```bash
npm run dev             # terminal 1
./scripts/demo.sh       # terminal 2
```

`scripts/demo.sh` detects which provider is running and adapts: a real model
shows genuine analyses; the fake provider also injects the failure and retry
paths a real model can't produce on demand. Run it both ways to see everything —
async submission, a cache hit, a schema-validation failure, a manual retry, an
automatic retry, and the read API.

```bash
npm test                # 67 tests, no key required
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
  "content": "The CSV export is painfully slow. I wish I could schedule it overnight.",
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

Every fact about a feedback item — status, attempt count, last error — lives in
SQLite. The queue holds ids and nothing else. A process crash loses no
information, and the queue can be swapped for SQS or Redis by changing two
files.

### Every state change is a guarded, atomic transition

`RECEIVED → ANALYZING → DONE | FAILED`, plus `FAILED → RECEIVED` on retry and
`ANALYZING → RECEIVED` for crash recovery. One method changes a status
([`FeedbackRepository.transition`](src/repositories/feedbackRepository.ts)),
via:

```sql
UPDATE feedback SET status = :to … WHERE id = :id AND status = :from
```

`changes === 0` means the caller lost the race or attempted an illegal move;
either way the right response is to do nothing. Two workers can never both
believe they own a row. Transitions outside the declared state graph throw
rather than return false — those are caller bugs, not race outcomes.

A row found in `ANALYZING` at boot has no live worker behind it (the previous
process died mid-analysis). It's returned to `RECEIVED` and re-queued, or a
restart would silently orphan the work.

### Two tables for AI output, not one

`analyses` holds validated results. `analysis_attempts` holds one row per LLM
call — raw response, error, duration — whether it succeeded or not. The raw
response matters most when validation *failed*, where there's no validated
result to attach it to, so it needs its own table.

### Forcing structure, then validating it anyway

Neither provider is asked for JSON in prose:

- **Anthropic** — forced tool use (`tool_choice: {type: "tool"}`) with the JSON
  Schema as the tool's `input_schema`.
- **Gemini** — `responseMimeType: "application/json"` plus `responseJsonSchema`.

Both consume the same hand-written JSON Schema, so one contract governs both
providers. The output is still validated with Zod afterwards — a constrained
decode is a strong prior, not a guarantee. The schema is `.strict()`, so an
unexpected key fails rather than gets silently dropped.

### Retry policy distinguishes "unlucky" from "wrong"

| Failure | Retried? | Why |
|---|---|---|
| 429, 5xx, timeout, connection reset | Yes, up to `MAX_ANALYSIS_ATTEMPTS` with backoff | A different outcome is plausible. |
| Schema validation failure | No — straight to `FAILED` | Same input, same bad shape. A retry burns tokens for the same result. |
| 401 / 403 / 400 / 404 | No | A human has to fix the credential or the request. |
| Output truncated by `max_tokens` | No | Retrying identically truncates identically; the fix is raising the token limit, not editing the prompt. |

A manual retry via the API resets the attempt counter, so it gets a full budget
rather than one shot — pressing "retry" is a deliberate act by someone who has
usually just fixed something. The full taxonomy lives in
[`src/ai/provider.ts`](src/ai/provider.ts).

### Guardrail: hash-based analysis cache

*(One guardrail, as the brief requires.)*

Content is normalized (trim, collapse whitespace, lowercase) and hashed. If an
earlier item with the same hash already has a validated analysis, the result is
copied onto the new row and it goes straight to `DONE` — no model call.

A cache keyed on `DONE` misses duplicates that arrive while the first analysis
is still running, which against a real model is a multi-second window — exactly
when a burst of identical feedback shows up. So submissions also check for an
in-flight identical item: the first copy is the **leader** and gets queued; later
copies become **followers**, persisted but left `RECEIVED` and never queued.
When the leader finishes, its result fans out to every follower. If the leader
fails, exactly one follower is promoted and retried, not all of them.

Measured: six identical submissions against a 300ms provider cost one model
call, not six.

The new submission row is still created rather than collapsed into the
original — each is a real event, and `from_cache` is exposed in the API so the
guardrail stays observable. Punctuation is not stripped during normalization
(it carries sentiment); whitespace and case are.

Its known limit: it only catches *exact* duplicates. "app is slow" vs "the app
is so slow" still costs a call — semantic dedup would need embeddings.

### Other choices

- **Fastify** over Express: `app.inject()` lets API tests run without binding a
  port.
- **`better-sqlite3`**'s synchronous API removes interleaving between a read
  and the write it depends on — the usual source of state-machine races.
- **Zod at every boundary** — requests, env vars, AI output — each gets its own
  schema, since they're separate contracts.
- **Analyses are re-validated on read.** The database isn't the schema
  authority; Zod is.
- **Composition root in [`src/app.ts`](src/app.ts)**: no module-level
  singletons, so a test can stand up a full isolated app in three lines.
- **Backoff timers are not `unref`'d.** A pending retry is outstanding work and
  keeps the process alive; `drain()` clears them on shutdown instead of waiting.

---

## Tradeoffs made for the timebox

Conscious omissions, not oversights:

| Not built | Why, and what I would do instead |
|---|---|
| Migration chain | One idempotent `schema.sql` applied at boot. A second schema change would justify numbered migrations; the first doesn't. |
| Durable queue | In-process, which the brief permits. DB-as-source-of-truth is what keeps the swap to SQS/Redis cheap. |
| Auth, rate limiting, deployment | Out of scope per the brief. |
| Structured log shipping, metrics | Fastify's logger only. `analysis_attempts` already holds what a dashboard would need. |
| Exhaustive tests | 67 tests aimed at the state machine, the schema gate, the failure taxonomy, the guardrail — the paths where a bug would be silent. |
| Dead-letter handling beyond `FAILED` | `FAILED` + retry covers the requirement; a real system would alert on the `FAILED` count. |

## What I would do with more time

1. **Load-shed the queue.** It's unbounded; a cap with backpressure (503 on
   submit) is the honest fix.
2. **Semantic dedup** via embeddings, to catch near-duplicate feedback the hash
   guardrail misses.
3. **Confidence calibration.** Live Gemini returned `confidence: 1.0` on every
   feature request extracted — the field is almost certainly uncalibrated and
   nothing should threshold on it yet.
4. **A golden-set eval** for the prompt — fixed feedback with expected results,
   run in CI, so prompt edits are measured rather than eyeballed.
5. **Prompt-injection hardening.** Feedback is wrapped in `<feedback>` tags with
   a system-prompt instruction to treat it as data. Tested against live Gemini
   with an injection attempt buried in real complaint text: the model ignored
   it and analysed the complaint. One passing case, not a guarantee — an output
   check that the analysis relates to its input would be the next layer.
6. **Per-item idempotency keys**, so a client retrying a failed HTTP request
   can't create a second row.

---

## AI Collaboration Log

See **[AI_COLLABORATION_LOG.md](AI_COLLABORATION_LOG.md)**.
