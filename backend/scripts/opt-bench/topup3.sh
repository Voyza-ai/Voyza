#!/usr/bin/env bash
# Round 2, after a code change: top up each trip's tape with what the new
# version (N) now asks, with the chat's pre-search 10 s before the plan and
# without it. All Aboard quota read after each run; stops when a rail answer
# says rate-limited or the hour's timetable quota runs low.
#   topup3.sh <tag> <trip> [trip ...]
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SP=/tmp/claude-0/-home-user-Voyza/fcd77c15-ce26-520c-b102-770800c34da6/scratchpad/optbench
N_DIR="$(cd "$HERE/../.." && pwd)"
TAG=$1
shift
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
for TRIP in "$@"; do
  node "$HERE/bench.mjs" --version N --dir "$N_DIR" --trip "$TRIP" --mode topup --prewarm 10 --port 4200 --tapes "$SP/tapes2" --out "$SP/runs2" --tag "$TAG" --settle 30000 2>&1 | tail -1
  stop_if_limited "$TRIP-N-g10-topup-$TAG"
  node "$HERE/bench.mjs" --version N --dir "$N_DIR" --trip "$TRIP" --mode topup --port 4200 --tapes "$SP/tapes2" --out "$SP/runs2" --tag "$TAG" --settle 30000 2>&1 | tail -1
  stop_if_limited "$TRIP-N-topup-$TAG"
done
date -u +%H:%M:%S; quota
