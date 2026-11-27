#!/usr/bin/env bash
# Round 2: replay one trip on A and the new version (N) at several Duffel
# window phases. N runs with the chat's pre-search 10 s and 25 s before the
# plan, without it, and (B2=1) ranking on the lighter NON_STOP rail search.
#   [OUT=dir PA=port PB=port B2=1] batch2.sh <trip> ["0 20 40"]
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SP=/tmp/claude-0/-home-user-Voyza/fcd77c15-ce26-520c-b102-770800c34da6/scratchpad/optbench
A_DIR=$SP/A/backend
N_DIR="$(cd "$HERE/../.." && pwd)"
TRIP=$1
PHASES=${2:-"0 20 40"}
TAG=${TAG:-r1}
OUT=${OUT:-$SP/replays2}
PA=${PA:-4100}
PB=${PB:-4200}

run() { node "$HERE/bench.mjs" --trip "$TRIP" --mode replay --tapes "$SP/tapes2" --out "$OUT" --tag "$TAG" "$@" 2>&1 | tail -1; }

for p in $PHASES; do
  run --version A --dir "$A_DIR" --port "$PA" --phase "$p" &
  run --version N --dir "$N_DIR" --port "$PB" --phase "$p" --prewarm 10
  wait
  run --version N --dir "$N_DIR" --port "$PA" --phase "$p" --prewarm 25 &
  run --version N --dir "$N_DIR" --port "$PB" --phase "$p"
  wait
  if [ "${B2:-0}" = 1 ]; then
    run --version N --dir "$N_DIR" --port "$PB" --phase "$p" --prewarm 10 --ranking-rail quick
  fi
done
