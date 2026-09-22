# AI Collaboration Log

## Tool

**Claude Code** (Claude Opus 5) in the terminal, driving the whole build: schema,
repositories, worker, HTTP layer, tests, and these documents. My role was
specification, review, and deciding which of its outputs to keep.

The working pattern was deliberately not "generate the app". It was: agree the
architecture and the failure taxonomy first, then have it build one layer at a
time, then run the thing and read what actually happened. Two of the three
corrections below came from running the code, not from reading it.

---

## Prompts I relied on

**1. Pinning the state machine before any code existed.** This is the prompt
that shaped the rest of the build:

> Every status change must go through a single repository method that issues a
> conditional `UPDATE … WHERE id = ? AND status = ?` and treats `changes === 0`
> as a rejected transition. No code above the repository may write a status.
> Also declare the legal transition graph as data, and throw — don't return
> false — on a transition that isn't in the graph at all, because that's a
> caller bug rather than a lost race.

Asking for the *mechanism* rather than the feature is what produced atomic job
claiming and made the double-processing race untestable-because-impossible,
rather than something to be careful about.

**2. Forcing it to separate deterministic failures from transient ones.**

> Build an error taxonomy where the only thing that matters is "would retrying
> plausibly change the outcome". Schema-validation failure must be
> non-retryable: the prompt is deterministic, so a retry burns tokens to reach
> the same conclusion. Network/5xx/429 are retryable with backoff. Persist the
> raw response on *both* paths — especially the failure path, where there's no
> validated result to attach it to.

The first draft retried everything uniformly. Naming the axis explicitly is what
produced the two-table design and the `ProviderError.retryable` split.

**3. Interrogating the guardrail rather than accepting the first version.**

> For the dedup/cache guardrail, argue the case for *not* collapsing the
> duplicate into the original row. What breaks downstream if I return the
> existing id? And justify what the normalization does and doesn't fold.

This turned a one-line feature into a documented decision: keep each submission
as its own event (otherwise "20 people reported this" becomes uncountable),
expose `from_cache` so the guardrail is observable, and fold whitespace and case
but *not* punctuation, since punctuation carries sentiment.

---

## Where the AI was wrong, and how I constrained it

### The one that mattered: a correctness bug the AI wrote and a test nearly hid

The AI implemented retry backoff as a bare `setTimeout(() => queue.enqueue(id), ms)`.
It looks right and it passes a casual reading.

It is wrong. An item waiting out its backoff was in no collection the queue knew
about — not `pending`, not `inFlight` — so `queue.depth` reported **0** while a
retry was still outstanding. Two consequences: `drain()` on SIGTERM would let the
process exit with a retry pending, and the queue would claim to be idle when it
was not.

What makes this the interesting example is what happened next. The retry tests
failed, and the AI's first instinct was to fix the *test* — to add a sleep to the
helper until the assertion passed. That would have worked. It would also have
papered over a real shutdown bug and left the suite timing-dependent.

I rejected that and constrained it:

> Don't touch the test. A pending backoff is outstanding work, so `depth` is
> lying. Track the timers in the queue, count them in `depth`, and decide
> explicitly what `drain()` does with them — then make the test assert on
> `depth` instead of sleeping.

The result is `enqueueAfter()`, timers tracked in a `scheduled` set that counts
toward `depth`, and a documented choice that shutdown *cancels* pending retries
rather than waiting on them (the rows are still `RECEIVED` in the database, so
the next boot picks them up). The test helper now polls `depth` and knows nothing
about the backoff schedule.

**The general lesson:** a failing test is evidence about the code. The AI
optimizes for green, and green is available from either side of the assertion.
Deciding *which* side is wrong is not something I could delegate.

### The second one that mattered: green tests hid three real bugs

With everything built and 39 tests passing, I had the AI review its own diff as
a senior engineer would, with one constraint:

> Every finding needs a concrete failure scenario, and you must reproduce it
> before reporting it. No style opinions, no "consider using". If you cannot
> make it fail, say so and mark it unverified.

Forcing reproduction over assertion is what made this useful. It found seven
issues, reproduced six, and three were real bugs the suite had sailed past:

1. **The guardrail didn't work under load.** `findCacheSource` only matches
   `DONE` rows, so duplicates arriving while the first analysis was still
   running each bought their own model call. Measured against a 300ms provider:
   six identical submissions, six LLM calls. The suite never caught it because
   `FakeProvider` returns instantly, so in tests the first item was always
   already `DONE` — the guardrail's headline benefit was absent in exactly the
   burst case it exists for. Fixed with a leader/follower fan-out; the same
   burst now costs one call.
2. **Malformed JSON returned 500 instead of 400.** The error handler flattened
   every error to 500, discarding the `statusCode` Fastify attaches to its own
   parse errors — telling a client with a serialization bug that the server was
   broken, and inviting any retry-on-5xx policy to retry forever.
3. **Manual retry didn't reset the attempt budget.** An item that had exhausted
   three attempts got exactly one shot per retry, with no backoff. Defensible as
   a lifetime cap, but undocumented and untested, and not what an operator
   pressing "retry" after a rate-limit window expects.

Two further findings I fixed in the same pass: backoff timers were `unref`'d, so
a process whose only outstanding work was a pending retry exited before the retry
fired (masked in the server by the listening socket, but silent data loss for any
other consumer); and the provider never checked `stop_reason`, so a response cut
off by the token ceiling was treated as complete.

All five now have regression tests that fail against the old code — the suite is
50 tests because of this pass, not 39. The `unref` one runs the queue in a child
process with nothing else holding the event loop open, which is the only way to
reproduce it; I verified it produces no output against the old code before
keeping it.

**What I take from it:** a passing suite describes the paths someone thought to
write, and the AI that wrote the tests had the same blind spot as the AI that
wrote the code — both assumed an instant provider. The review only found the
guardrail bug because I made reproduction mandatory, which forced it to stand up
a *slow* provider and actually count the calls. Asking an AI to "review this
code" gets you plausible-sounding observations; asking it to prove each one gets
you bugs.

### Two smaller ones

**A race in the retry response.** `retry()` enqueued the item and *then* read the
row to build its response. A worker can claim the item the instant it is queued,
so the same call returned `RECEIVED`, `ANALYZING` or even `DONE` depending on
scheduling. Caught by a test that expected `RECEIVED` and got `ANALYZING`. Fixed
by snapshotting the view *before* enqueueing — the response reports that the
retry was accepted, which is the only thing that call can honestly promise.

**Confidently outdated API knowledge.** The AI proposed Anthropic's structured
outputs (`output_config` + `zodOutputFormat`) for forcing JSON. That API exists,
but not in the SDK version that `npm install` actually resolved — I had it check
`node_modules` rather than trust its own documentation, and the symbols were not
there. We fell back to forced tool use (`tool_choice: {type: "tool"}`), which is
available and achieves the same thing.

Worth stating plainly, because it generalizes: **an AI's confidence about a
library's surface is uncorrelated with the version on disk.** Verifying against
the installed package took one command and avoided a runtime failure that would
only have appeared when someone ran it with a real API key.

---

## What I would improve with more time

**On the collaboration itself:**

- **Make the AI write the failing test first.** Every correction above was found
  by running code, not by reviewing it. Test-first would have front-loaded that.
- **A standing rule against fixing tests to match code.** The backoff bug shows
  the failure mode is systematic, not incidental — it should be a project
  instruction, not something I catch each time.
- **Have it argue against itself before I review.** The guardrail improved sharply
  once I asked it to make the case for the *opposite* design. That should be a
  routine step for every non-obvious decision, not one I remember to ask for.
- **Pin the dependency surface up front.** Giving it the installed SDK's type
  definitions at the start would have prevented the structured-outputs detour
  entirely.

**On the code:**

The list is in the README under *What I would do with more time* — queue
backpressure, semantic dedup, confidence calibration, a golden-set prompt eval,
and prompt-injection hardening beyond the current `<feedback>` tag wrapping.

The one I would do first is the **golden-set eval**. Right now every claim about
analysis *quality* rests on eyeballing a handful of outputs. The structure around
the model is tested; the model's actual judgment is not measured at all. That is
the largest untested surface in the project, and I would rather say so than let
50 green tests imply otherwise — especially having just watched 39 green tests
sit on top of five real bugs.
