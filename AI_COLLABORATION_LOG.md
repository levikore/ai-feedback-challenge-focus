# AI Collaboration Log

## Tool

Claude Code, in the Claude desktop app. The assistant wrote the code, tests,
and first draft of these docs, using Claude Opus 5. Editing this document was
done with Claude Sonnet 5, after I switched models partway through. I made the
decisions and checked the work. Prompts below are quoted exactly.

---

## Prompts I relied on

### 1. "plan this first, create in a new and separate directory"

Sent before any code was written. It came back with four questions instead of
starting: which stack, how to call the LLM, which guardrail, where to put the
project. That's where the design actually got decided.

My answers:

- **TypeScript.** Required by the assignment; also the brief grades readability
  and maintainability.
- **A real LLM with a fake provider as a fallback.** The assistant suggested
  "Anthropic only" as simpler. I said no — someone should be able to clone this
  and run it, tests included, with no key. That put the LLM behind an interface,
  which is why adding Gemini later was cheap.
- **Hash-based dedup/cache** as the guardrail. Rate limiting only delays spend —
  the same feedback still costs a model call eventually. Caching removes it:
  identical feedback reuses the earlier result instead of paying for a new call.
  The result is also easy to check, since each response says whether it came
  from cache.
- **Local repo only, my approval before every commit.**

### 2. "validate code and run tests"

Sent after it reported the build done with 39 tests passing. Passing tests
don't mean the code is correct. This instruction found five real bugs.

### 3. "can we switch to a free llm open to overyone, like gemini?"

The project only had a paid key, so it ran on a simulated model the whole time —
no reviewer would see a real model working. Gemini's free tier needs no credit
card. The system has since been run end to end against it and works.

Adding it changed nothing above `src/ai/` — same queue, same service, no test
changes. The provider interface held. Gemini also fails differently from
Anthropic (a blocked prompt returns HTTP 200 with no result), which had to be
mapped onto the existing retry logic by hand.

---

## Where the AI was wrong

### 39 passing tests hid five real bugs

Told to validate, the assistant reviewed its own code under one rule: no finding
counts unless it's reproduced first. It found five bugs:

1. **The guardrail didn't work under load.** It only matched feedback that had
   already finished analysis, so six identical submissions sent close together
   cost six model calls instead of one.
2. **Bad JSON returned HTTP 500 instead of 400**, which would make a client
   retry forever.
3. **Manual retry didn't reset the attempt budget** — one try instead of three.
4. **Backoff timers were `unref`'d**, so a pending retry could silently get
   dropped.
5. **`stop_reason` was never checked**, so output cut off by the token limit was
   treated as complete.

All five have regression tests now. The suite went from 39 to 50 tests on this
pass, then to 67 once Gemini was added.

They were missed because the fake provider responds instantly, so in every test
the first item had already finished before a duplicate could arrive. The AI that
wrote the tests made the same assumption as the AI that wrote the code.

Asking an AI to review its own code gets vague comments. Requiring it to prove
each finding gets real bugs.

### One smaller bug

`scripts/demo.sh` printed "FAILED after ONE attempt" under a result that showed
`"status": "DONE"` — the script's commentary was written for the fake provider
and didn't check what actually happened when a real model was used. Caught by
running the app, not by reading the code.

---

## What I would improve with more time

- **Validate after every layer, not just at the end.** One instruction found
  five bugs; I only sent it once.
- **Choose a free provider from the start.** Starting with a paid-only key meant
  the project ran on a fake model until very late.

For the code itself, the list is in the README. First priority: a fixed set of
test feedback with expected results, run in CI. Right now the code around the
model is tested well, but the quality of the model's actual answers isn't
measured at all.
