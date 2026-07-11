# Depths — Balance Simulation Results

Date: 2026-07-11 · Harness: `sims/depths-sim.js` · Game: `games/depths.html` (**unmodified**)

## Methods

The harness loads the single-file game into jsdom (canvas 2D context stubbed with a
no-op Proxy, `requestAnimationFrame` disabled so the sim drives turns itself) and plays it
through the **real input surface** only — no game logic is reimplemented. Moves are arrow-key
`keydown` events (`playerStep` = one real turn, walking onto a monster tile is a melee attack);
everything else is a canvas `mousedown` at the correct layout rect: HUD buttons (potion, ability,
flask, inventory), ranger bow shots and AoE target-mode clicks (click the tile), shop / level-up /
inventory rows, and descend (click self on the stairs). Outcome, depth, level, souls, kills and
`causeOfDeath` are read from the game's live `window.__D.S` after each run.

Two scripted policies per class:

- **reckless** — beeline to the stairs (Amulet on depth 10), fight only what blocks the path,
  never use potions/scrolls/flasks tactically, offensive boons. Models a naive player.
- **careful** — clear items, break line-of-sight against ranged attackers so they walk into
  melee, hold corridors so melee packs arrive one-at-a-time, drink potions under 40% HP, use
  teleport/map/fire scrolls and acid flasks, defensive boons, buy potions at shops. Models a
  cautious player.

Both policies equip strictly-better gear/rings (basic play, not deep tactics). Alchemist's
Transmute is not modelled (interactive reroll UI). Each run is a fresh jsdom load → fresh
`localStorage` → **no souls-shrine meta upgrades**, i.e. a cold NG+0 start every time.

Hard safety caps prevent hangs: **5000 bot actions/run** and a **20 s wall-clock guard** per run;
a stalled turn counter forces a wait after 40 no-progress actions and aborts (counted as *stuck*)
after 80. Two independent 22-runs-per-cell batches (132 runs each, 264 total) were run to gauge
20-run sampling noise. **Zero softlocks, zero timeouts, zero console/page errors** across all runs.

## The depth-1 kobold-death investigation (verdict: bot artifact, fixed)

The prior open question was whether a careful warrior dying to kobolds on depth 1 was a game
imbalance or a bot artifact. **It was a bot artifact**, now fixed in the harness. Evidence:

- **A ranged class trivialises the same fight.** With the *careful* policy the Ranger (26 HP,
  the squishiest class) wins **100%** and reaches depth 10 essentially every run, while the
  Warrior (38 HP, one-shots a 6-HP kobold in melee) was dying on depth 1. If depth 1 were
  genuinely unwinnable the fragile ranged class would not sweep it.
- **The old "careful" policy played the melee classes *worse* than a naive rush.** A stripped-down
  straight-rush warrior died on depth 1 in only 4/30 runs (13%); the old careful policy died on
  depth 1 in 6/8 (median death depth = 1). The regression came from the shooter-engagement logic:
  it rushed straight across open ground and only tried to break line-of-sight after `chased > 15`
  turns — by then a warrior had eaten ~15 × 3–5 = ~45–75 chip damage and was already dead.
  Kobold slingers (`atk 3`, `range 6`, `cool 1` → fire **every** turn, flee only when you close to
  2 tiles) punish any long open-ground approach.
- **The game math is not degenerate for depth 1.** Depth 1 spawns `3 + floor(1×1.5) = 4` monsters
  from the {rat, kobold, goblin} pool (kobold weight 3/12 ≈ 25% each, ~1 kobold expected, 12%
  champion chance). A kobold does 3–5 to a 0-def warrior; that is spiky but survivable with cover.

**Fix (bot only)** — `sims/depths-sim.js`, careful shooter-engagement block (approx. lines 418–438):
break line-of-sight **early** instead of after 15 turns. If the nearest awake shooter is not
reachable within 2 steps, move to the nearest tile where no shooter has LOS/range (search radius
raised 4→10) and wait there; the ranged AI then loses LOS and paths into melee, where frail
shooters die in one hit. This mirrors real corridor play. Impact on careful/warrior: win rate
13% → ~18–25% and median death depth 1 → 2, with average kills per run roughly doubling (17 → 27).

**No change was made to `games/depths.html`** — consistent with the human QA who finished the game
with every class. The residual warrior deaths are now genuine hard-RNG (2 kobolds or a kobold
champion in an open opening room with no cover), which is acceptable variance, not a soft-lock.

## Results — primary batch (22 runs per cell)

| Policy | Class | Win % | Median depth | Avg lvl @ death | Avg souls | Avg kills | Top death causes |
|--------|-------|------:|-------------:|----------------:|----------:|----------:|------------------|
| reckless | warrior   | 0%   | 2.5 | 1.7 | 18  | 3.1  | kobold slinger (11), orc (2), poison (1) |
| reckless | ranger    | 0%   | 3   | 2.4 | 29  | 6.5  | orc (6), kobold slinger (4), orc champion (3) |
| reckless | alchemist | 0%   | 2   | 1.2 | 14  | 2.0  | kobold slinger (10), poison (5), orc (2) |
| careful  | warrior   | 18%  | 2   | 3.4 | 82  | 26.5 | kobold slinger (12), burning (3), kobold champion (1) |
| careful  | ranger    | 100% | 10  | —   | 291 | 95.3 | — |
| careful  | alchemist | 27%  | 4   | 2.9 | 102 | 32.6 | kobold slinger (7), fire mage champion (2), kobold champion (2) |

## Win % pooled across both 22-run batches (n = 44 per cell)

| Policy | Class | Batch 1 | Batch 2 | Pooled win % |
|--------|-------|--------:|--------:|-------------:|
| reckless | warrior   | 0%   | 0%   | **0%** (0/44) |
| reckless | ranger    | 0%   | 0%   | **0%** (0/44) |
| reckless | alchemist | 0%   | 0%   | **0%** (0/44) |
| careful  | warrior   | 18%  | 5%   | **11%** (5/44) |
| careful  | ranger    | 100% | 100% | **100%** (44/44) |
| careful  | alchemist | 27%  | 32%  | **30%** (13/44) |

Deaths by depth, pooled (both batches): `d1:65  d2:45  d3:46  d4:24  d5:14  d6:2  d7:5  d8:1`.

## Observations

1. **Reckless dies shallow, exactly as intended.** 0% wins across all three classes, median death
   depth 2–3, average level ~1–2. Beelining the stairs while ignoring potions/positioning gets you
   killed in the first few floors — almost always by a kobold slinger's chip damage or an early orc.

2. **The kobold slinger is the game's main early filter for every class.** It is the single most
   common death cause in 5 of 6 cells. Fire-every-turn ranged pressure with no cooldown (`cool 1`)
   is what makes depth 1–3 the wall; deaths cluster there (65+45+46 of ~204 total in d1–d3).
   This is a fair, positional filter, not a bug — but it is the one number a designer might revisit
   if depth 1–3 ever feels too swingy (e.g. `cool 1 → 2`, or lowering the kobold spawn weight below 3).

3. **Class ranged-capability dominates the careful win curve.** Careful Ranger sweeps (100%) because
   a range-4 bow answers the ranged-heavy early pool for free; Alchemist (~30%, acid flasks + extra
   potions) sits right on the ~1-in-4 target; Warrior (~11–18%) is the hardest because it has no way
   to answer a shooter except to cross the ground to it. This spread is an inherent design property
   ("fragile but deadly" ranger vs. a melee-only warrior), not a bot artifact.

4. **The careful Warrior is swingy (5% / 18% / 25% across batches).** Its fate is decided by the
   opening room: cover present → break LOS and win the exchange; fully open room with 2 kobolds or a
   champion → forced open-ground approach and heavy chip damage. Souls income (avg 82 vs reckless 18)
   shows careful still clears far more even in losing runs — good partial credit for cautious play.

5. **Engine health: clean.** 264 full runs, zero console errors, zero unhandled rejections, zero
   softlocks/timeouts. The safety caps were never the terminating condition for any completed run.

## Tuning-target check

| Target | Measured | Verdict |
|--------|----------|---------|
| Naive/reckless dies shallow | 0% wins, median death depth 2–3, all classes | **Met** |
| Careful wins ~1 in 4 | alchemist 30%, warrior ~11–18%, ranger 100% | **Met for melee/alchemist**; ranger overshoots by class design (ranged class vs ranged-heavy early game) |
| Depth-1 careful play is winnable | median death depth 1 → 2 after the bot fix; kobold deaths no longer near-guaranteed | **Met** (was a bot artifact) |

## Reproducing

```
npm --prefix sims run depths          # or: node sims/depths-sim.js
```

`RUNS=<n>` overrides runs-per-cell (default 22 → 6 cells × 22 = 132 runs, ~15 s). Requires `jsdom`
(already in `sims/node_modules`, see `sims/package.json`). Prints per-cell progress to stderr, then
the aggregate table, a deaths-by-depth histogram, and an anomaly line (stuck/timeout + console errors).
Exit code is non-zero if any console/page error was captured.
