#!/usr/bin/env bash
# Round 2, one trip live: A records the tape, then the new version (N) tops it
# up with what only it asks (its quick NON_STOP rail searches, its retries),
# with the chat's pre-search 10 s before the plan, without it, and ranking on
# the lighter (B2, NON_STOP) rail search. All Aboard quota read after each run; stops when a
# rail answer says rate-limited or the hour's timetable quota runs low.
#   record3.sh <trip>
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SP=/tmp/claude-0/-home-user-Voyza/fcd77c15-ce26-520c-b102-770800c34da6/scratchpad/optbench
A_DIR=$SP/A/backend
N_DIR="$(cd "$HERE/../.." && pwd)"
TRIP=$1
quota() { NODE_USE_ENV_PROXY=1 timeout 30 node "$HERE/aaquota.mjs" 2>/dev/null | head -1; }
stop_if_limited() {
  local log="$SP/runs2/$1.req.jsonl"
  if grep '"op":"aa\.' "$log" 2>/dev/null | grep -qiE 'RATE_?LIMIT|TOO_MANY|QUOTA|"status":429'; then
    echo "STOP: rate-limit answer in $1"; exit 1
  fi
  local left
  left=$(quota | python3 -c 'import json,sys; t=sys.stdin.read().strip(); print(json.loads(t).get("remaining", 0) if t else 0)')
  echo "timetable/hour remaining after $1: $left"
  if [ "${left:-0}" -lt 250 ]; then echo "STOP: hour quota low"; exit 1; fi
}
date -u +%H:%M:%S; quota
node "$HERE/bench.mjs" --version A --dir "$A_DIR" --trip "$TRIP" --mode record --port 4100 --tapes "$SP/tapes2" --out "$SP/runs2" --settle 30000 2>&1 | tail -1
stop_if_limited "$TRIP-A-record-r1"
node "$HERE/bench.mjs" --version N --dir "$N_DIR" --trip "$TRIP" --mode topup --prewarm 10 --port 4200 --tapes "$SP/tapes2" --out "$SP/runs2" --settle 30000 2>&1 | tail -1
stop_if_limited "$TRIP-N-g10-topup-r1"
node "$HERE/bench.mjs" --version N --dir "$N_DIR" --trip "$TRIP" --mode topup --port 4200 --tapes "$SP/tapes2" --out "$SP/runs2" --settle 30000 2>&1 | tail -1
stop_if_limited "$TRIP-N-topup-r1"
node "$HERE/bench.mjs" --version N --ranking-rail quick --dir "$N_DIR" --trip "$TRIP" --mode topup --prewarm 10 --port 4200 --tapes "$SP/tapes2" --out "$SP/runs2" --settle 30000 2>&1 | tail -1
stop_if_limited "$TRIP-N-rrquick-g10-topup-r1"
date -u +%H:%M:%S; quota
