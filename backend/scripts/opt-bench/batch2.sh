#!/usr/bin/env bash
# Round 2: replay one trip on A and the new version (N) at several Duffel
# window phases. N runs with the chat's pre-search 10 s and 25 s before the
# plan, without it, and ranking on the full rail search.
#   batch2.sh <trip> ["0 20 40"]
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SP=/tmp/claude-0/-home-user-Voyza/fcd77c15-ce26-520c-b102-770800c34da6/scratchpad/optbench
A_DIR=$SP/A/backend
N_DIR="$(cd "$HERE/../.." && pwd)"
TRIP=$1
PHASES=${2:-"0 20 40"}
TAG=${TAG:-r1}

run() { node "$HERE/bench.mjs" --trip "$TRIP" --mode replay --tapes "$SP/tapes2" --out "$SP/replays2" --tag "$TAG" "$@" 2>&1 | tail -1; }

for p in $PHASES; do
  run --version A --dir "$A_DIR" --port 4100 --phase "$p" &
  run --version N --dir "$N_DIR" --port 4200 --phase "$p" --prewarm 10
  wait
  run --version N --dir "$N_DIR" --port 4100 --phase "$p" --prewarm 25 &
  run --version N --dir "$N_DIR" --port 4200 --phase "$p"
  wait
  run --version N --dir "$N_DIR" --port 4200 --phase "$p" --prewarm 10 --ranking-rail full
done
