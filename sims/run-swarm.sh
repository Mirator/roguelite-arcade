#!/bin/bash
# Swarm balance sim runner. Drives games/swarm.html's real update(dt) headlessly
# with a kiting AI (PROFILE=mid). 5 naked + 5 mid-tree + 5 near-full-tree runs.
# Usage: bash sims/run-swarm.sh   (run from repo root; ~4-6 min wall)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
GAME="${SWARM_GAME:-$HERE/../games/swarm.html}"
MID_TREE="o1,o2,o3,o4,v1,v2,v3,v4,f1"          # 9 nodes (~440 coins)
FULL_TREE="o1,o2,o3,o4,o5,o6,o7,v1,v2,v3,v4,v5,v6,v7,f1,f2,f3,f4,f5,f6,f7"  # all 21 (2240 coins)
OUT="${1:-$HERE/swarm-results.jsonl}"
: > "$OUT"

run_one() {
  local tier="$1"
  local run="$2"
  local duration="$3"
  local tree="${4-}"
  local sim_output
  local first_line

  echo "$tier $run" >&2
  if ! sim_output=$(PROFILE=mid TREE="$tree" node "$HERE/swarm-sim.js" "$GAME" "$duration"); then
    echo "ERROR: Swarm simulator failed for $tier run $run" >&2
    return 1
  fi

  first_line=${sim_output%%$'\n'*}
  if [[ -z "$first_line" ]]; then
    echo "ERROR: Swarm simulator returned no JSON for $tier run $run" >&2
    return 1
  fi
  if ! node -e 'JSON.parse(process.argv[1])' "$first_line"; then
    echo "ERROR: Swarm simulator returned invalid JSON for $tier run $run" >&2
    return 1
  fi

  printf '{"tier":"%s","run":%d,"data":%s}\n' "$tier" "$run" "$first_line" >> "$OUT"
}

for i in 1 2 3 4 5; do
  run_one "naked" "$i" 400
done
for i in 1 2 3 4 5; do
  run_one "mid" "$i" 900 "$MID_TREE"
done
for i in 1 2 3 4 5; do
  run_one "full" "$i" 1850 "$FULL_TREE"
done
echo "DONE -> $OUT" >&2
