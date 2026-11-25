#!/usr/bin/env bash
# Replay one trip on every version, at several Duffel window phases.
#   batch.sh <trip> <phases, e.g. "0 20 40"> [extra configs...]
# A and B run side by side on ports 4100 and 4200; each run is a fresh backend.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SP=/tmp/claude-0/-home-user-Voyza/fcd77c15-ce26-520c-b102-770800c34da6/scratchpad/optbench
A_DIR=$SP/A/backend
B_DIR="$(cd "$HERE/../.." && pwd)"
TRIP=$1
PHASES=${2:-"0 20 40"}
TAG=${TAG:-r1}

run() { node "$HERE/bench.mjs" --trip "$TRIP" --mode replay --tapes "$SP/tapes" --out "$SP/replays" --tag "$TAG" "$@" 2>&1 | tail -1; }

for p in $PHASES; do
  if [ "${SKIP_A:-0}" != "1" ]; then
    run --version A --dir "$A_DIR" --port 4100 --phase "$p" &
  fi
  run --version B --dir "$B_DIR" --port 4200 --phase "$p" --two-phase
  wait
  run --version B --dir "$B_DIR" --port 4100 --phase "$p" &
  run --version B --variant C --dir "$B_DIR" --port 4200 --phase "$p" --two-phase
  wait
  if [ "${SLOTS8:-0}" = "1" ]; then
    run --version B --slots 8 --dir "$B_DIR" --port 4200 --phase "$p" --two-phase
  fi
done
