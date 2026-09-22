#!/usr/bin/env bash
#
# End-to-end walkthrough against a running server. One command, so the whole
# system can be demonstrated (or screen-recorded) without typing curl by hand.
#
#   Terminal 1:  npm run dev
#   Terminal 2:  ./scripts/demo.sh
#
# Works with or without ANTHROPIC_API_KEY. Without one the server runs the
# deterministic FakeProvider, and the two "__fail_*__" markers below force the
# failure paths on demand so they can actually be shown rather than described.

set -euo pipefail

BASE="${BASE:-http://localhost:3000}"

# Which provider is the server actually running? The failure-injection markers
# below are understood only by the deterministic FakeProvider — a real model
# analyses them as ordinary text. Rather than narrate results that did not
# happen, the failure sections adapt.
PROVIDER=$(curl -sS "$BASE/health" | python3 -c 'import json,sys; print(json.load(sys.stdin)["provider"])' 2>/dev/null || echo unknown)
if [ "$PROVIDER" = "fake" ]; then CAN_INJECT=1; else CAN_INJECT=0; fi

# Every run tags its feedback with a unique marker. Without it, a second run of
# this script hits the cache guardrail from the first one and section 1 shows a
# cached DONE instead of the async RECEIVED it is supposed to demonstrate.
# Section 3 deliberately omits the marker change, because there the cache IS
# the point.
RUN=$(date +%s)

bold() { printf '\n\033[1m%s\033[0m\n' "$1"; }
step() { printf '\n\033[1;36m▸ %s\033[0m\n' "$1"; }

if command -v jq >/dev/null 2>&1; then
  show() { jq "${1:-.}"; }
else
  echo "(jq not found — printing raw JSON)" >&2
  show() { cat; echo; }
fi

submit() {
  curl -sS -X POST "$BASE/api/feedback" \
    -H 'content-type: application/json' \
    -d "$(printf '{"content":%s}' "$(printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")"
}

get() { curl -sS "$BASE/api/feedback/$1"; }

wait_for_terminal() {
  local id="$1"
  for _ in $(seq 1 40); do
    local status
    status=$(get "$id" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')
    if [ "$status" = "DONE" ] || [ "$status" = "FAILED" ]; then return 0; fi
    sleep 0.25
  done
  echo "timed out waiting for $id" >&2
}

bold "0. Health — which provider is actually running?"
curl -sS "$BASE/health" | show
if [ "$CAN_INJECT" = "1" ]; then
  echo "NOTE: provider is 'fake' — analyses below are SIMULATED, not from a model."
  echo "      Set GEMINI_API_KEY (free: https://aistudio.google.com/apikey) for real ones."
else
  echo "Provider is '$PROVIDER' — the analyses below come from a real model."
fi

# ---------------------------------------------------------------------------
bold "1. Submit feedback — returns immediately, does NOT wait for the AI"
step "POST /api/feedback"
NEG=$(submit "The CSV export is painfully slow and it crashed twice today (ref $RUN). I wish I could schedule exports overnight.")
echo "$NEG" | show
NEG_ID=$(echo "$NEG" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')

echo "→ The response above came back as RECEIVED with analysis: null. The HTTP"
echo "  call never waited for the model — that is the asynchrony requirement."

step "Once the worker has picked it up"
wait_for_terminal "$NEG_ID"
get "$NEG_ID" | show

# ---------------------------------------------------------------------------
bold "2. A second, different piece of feedback"
POS=$(submit "Love the new dashboard, it is genuinely fast (ref $RUN). Please add dark mode.")
POS_ID=$(echo "$POS" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
wait_for_terminal "$POS_ID"
get "$POS_ID" | show '{status, analysis}'

# ---------------------------------------------------------------------------
bold "3. GUARDRAIL — resubmitting identical feedback skips the AI call entirely"
step "Same text as #2, but differently spaced and cased"
DUP=$(submit "  LOVE the new dashboard, it is genuinely FAST (REF $RUN).   please add dark mode. ")
echo "$DUP" | show '{id, status, analysis}'
echo "→ status is DONE on the spot and analysis.from_cache is true: no model call, no spend."

# ---------------------------------------------------------------------------
bold "4. FAILURE — AI output that does not match the schema is rejected, not stored"
if [ "$CAN_INJECT" = "1" ]; then
  step "The marker below makes the deterministic provider return an invalid payload"
  BAD=$(submit "This response will not validate __fail_malformed__")
  BAD_ID=$(echo "$BAD" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
  wait_for_terminal "$BAD_ID"
  get "$BAD_ID" | show '{status, attempts, error, analysis}'
  echo "→ FAILED after ONE attempt. A deterministic bad shape is not worth retrying."

  step "The raw response is still persisted, which is the whole point"
  sqlite3 "${DATABASE_PATH:-./data/feedback.db}" \
    "SELECT attempt_no, error_kind, raw_response FROM analysis_attempts WHERE feedback_id='$BAD_ID';" \
    2>/dev/null || echo "(install sqlite3 to inspect analysis_attempts directly)"
else
  echo "Skipped: the server is running the real provider ($PROVIDER), which cannot be"
  echo "made to emit invalid JSON on demand. The validation gate, the FAILED state and"
  echo "the raw-response audit trail are provider-agnostic — they live above the"
  echo "provider interface. To watch them work:"
  echo
  echo "    AI_PROVIDER=fake npm run dev     # then re-run this script"
  echo
  echo "They are also covered by tests: npm test"
fi

# ---------------------------------------------------------------------------
bold "5. RETRY — failures are explicitly retriable"
if [ "$CAN_INJECT" = "1" ]; then
  step "POST /api/feedback/:id/retry"
  curl -sS -X POST "$BASE/api/feedback/$BAD_ID/retry" | show '{id, status, attempts, error}'
  echo "→ back to RECEIVED with a fresh attempt budget and the error cleared."
  wait_for_terminal "$BAD_ID"
  echo "  It fails again, deterministically, because the input has not changed:"
  get "$BAD_ID" | show '{status, attempts}'
fi

step "Retrying something that is not FAILED is a 409, not a silent no-op"
curl -sS -o /dev/null -w 'HTTP %{http_code}\n' -X POST "$BASE/api/feedback/$POS_ID/retry"

# ---------------------------------------------------------------------------
bold "6. TRANSIENT failure — retried automatically until the budget runs out"
if [ "$CAN_INJECT" = "1" ]; then
  FLK=$(submit "Upstream keeps timing out __fail_transient__")
  FLK_ID=$(echo "$FLK" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
  wait_for_terminal "$FLK_ID"
  get "$FLK_ID" | show '{status, attempts, error}'
  echo "→ attempts reached MAX_ANALYSIS_ATTEMPTS before giving up. Compare with #4:"
  echo "  a transient fault is retried, a bad schema is not."
else
  echo "Skipped for the same reason as #4 — a real provider cannot be made to fail"
  echo "on demand. The retry budget and backoff are exercised by the test suite."
fi

# ---------------------------------------------------------------------------
bold "7. Read API — list, filter, paginate"
step "GET /api/feedback?limit=3"
curl -sS "$BASE/api/feedback?limit=3" | show '{total, limit, offset, items: [.items[] | {status, from_cache: .analysis.from_cache, content: .content[0:48]}]}'

step "GET /api/feedback?status=FAILED"
curl -sS "$BASE/api/feedback?status=FAILED" | show '{total, items: [.items[] | {status, attempts, error}]}'

step "Input validation: empty content is a 400 with a field-level reason"
curl -sS -X POST "$BASE/api/feedback" -H 'content-type: application/json' -d '{"content":"   "}' | show

bold "Done."
