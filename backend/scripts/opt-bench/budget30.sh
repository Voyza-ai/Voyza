#!/usr/bin/env bash
# Round 2: the new version (N) with PLAN_SEARCH_BUDGET 30 instead of 32 (the
# plan's inter-city searches fit one Duffel window), pre-search 10 s and 25 s
# before the plan, at each window phase.
#   [OUT=dir PA=port PB=port] budget30.sh <trip> ["0 20 40"]
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SP=/tmp/claude-0/-home-user-Voyza/fcd77c15-ce26-520c-b102-770800c34da6/scratchpad/optbench
N_DIR="$(cd "$HERE/../.." && pwd)"
TRIP=$1
PHASES=${2:-"0 20 40"}
OUT=${OUT:-$SP/replays2}
PA=${PA:-4100}
PB=${PB:-4200}
run() { node "$HERE/bench.mjs" --trip "$TRIP" --mode replay --tapes "$SP/tapes2" --out "$OUT" --tag r1 --version N --dir "$N_DIR" --budget 30 "$@" 2>&1 | tail -1; }
for p in $PHASES; do
  run --port "$PA" --phase "$p" --prewarm 10 &
  run --port "$PB" --phase "$p" --prewarm 25
  wait
done
