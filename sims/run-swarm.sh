#!/bin/bash
# Swarm balance sim runner. Drives games/swarm.html's real update(dt) headlessly
# with a kiting AI (PROFILE=mid). 5 naked + 5 mid-tree + 5 near-full-tree runs.
# Usage: bash sims/run-swarm.sh   (run from repo root; ~4-6 min wall)
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
GAME="$HERE/../games/swarm.html"
MID_TREE="o1,o2,o3,o4,v1,v2,v3,v4,f1"          # 9 nodes (~440 coins)
FULL_TREE="o1,o2,o3,o4,o5,o6,o7,v1,v2,v3,v4,v5,v6,v7,f1,f2,f3,f4,f5,f6,f7"  # all 21 (2240 coins)
OUT="${1:-$HERE/swarm-results.jsonl}"
: > "$OUT"
for i in 1 2 3 4 5; do
  echo "naked $i" >&2
  echo "{\"tier\":\"naked\",\"run\":$i,\"data\":$(PROFILE=mid node "$HERE/swarm-sim.js" "$GAME" 400 2>/dev/null | head -1)}" >> "$OUT"
done
for i in 1 2 3 4 5; do
  echo "mid $i" >&2
  echo "{\"tier\":\"mid\",\"run\":$i,\"data\":$(PROFILE=mid TREE="$MID_TREE" node "$HERE/swarm-sim.js" "$GAME" 900 2>/dev/null | head -1)}" >> "$OUT"
done
for i in 1 2 3 4 5; do
  echo "full $i" >&2
  echo "{\"tier\":\"full\",\"run\":$i,\"data\":$(PROFILE=mid TREE="$FULL_TREE" node "$HERE/swarm-sim.js" "$GAME" 1850 2>/dev/null | head -1)}" >> "$OUT"
done
echo "DONE -> $OUT" >&2
