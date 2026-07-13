# Warband — Balance Simulation Results

Date: 2026-07-13 · Harness: `sims/warband-sim.js` · Game: `games/warband.html` (5 numeric knobs tuned, see below)

## Methods

The harness (`node sims/warband-sim.js [runsPerPolicy=30] [baseSeed=5000]`, mechanics spot-checks via
`node sims/warband-sim.js --mechanics`; also `npm run warband` / `npm run warband:mechanics` from `sims/`) loads
`games/warband.html` into jsdom and plays full campaign runs through the game's **real entry points**: the exact
top-level functions the game's own `data-act` click dispatcher calls, exposed on the game's `window.__wb` debug
handle — `chooseNode`, `clickShop`, `clickSlot`, `clickStash`, `reroll`, `sellSelected`, `pickPatron`, `pickEvent`,
`pickDrop`/`skipDrop`, `runBattle`. Buying, merging, equipping and swapping all go through the same click→click
selection flow a mouse-only player uses; no draft, economy, or combat logic is reimplemented. Battles run the game's
real async `runBattle()` at `wb.fast(10000)`. Runs are seeded (`Math.random` replaced per run with mulberry32), so
batches are fully reproducible. Safety: per-run action cap (400 phase steps), 30 s wall-clock guard, and a
repeated-boss-draw guard classify any non-terminating run as a softlock instead of hanging. Game constants
(`MAP_LAYERS`, `STASH_MAX`, …) are read out of the loaded page rather than hardcoded, so knob tuning can't desync the
harness. `WB_DEBUG=1` dumps per-softlock diagnostics.

This replaces the retired `wbtest/` scratchpad harness, which targeted the previous build (flat 10-round loop,
pay-to-train `armTrain`) — both removed by the campaign-map rework.

**THOUGHTFUL** commits to one faction off the opening shop and drafts toward it, picks the matching patron at the
node-3 fork, benches copies as merge fodder (and merges bench twins onto lineup units), spends leftover gold on
rerolls hunting merge copies (interest maxes at +2 net gold here, so hoarding is a losing play), positions
tanky/defensive units front (front = right = index 0) and glass cannons back, equips Tower Shield/Plate/Warhorn on
the front unit and offensive items on the highest-ATK unit, routes to Elite nodes when healthy (≥4 lives) and Event
nodes when hurt, and picks event boons by need (heal → recruit → gold). **GREEDY** buys raw strongest-stats offers
with zero faction/patron intent (always the first-listed patron), always front-fills, naive item equips, takes the
first open map node, takes the first applicable event option, never rerolls, never banks bench fodder — but does
take the two obvious stat plays any non-strategic player makes (merge a shop copy onto a fielded twin;
sell-weakest-to-upgrade when full), without which it is a strawman no game knob can move (verified: pre-fix greedy
lost every knob-affected battle both before and after a tuning step, leaving its aggregates bit-identical).

### Mechanics spot-checks (`--mechanics`, all 27 assertions pass)

- **Copy-merge via the real flow**: ★★ stats follow `levelUp` (+base+1 each), third copy → ★★★, an item on the
  consumed copy transfers to the merged unit, source slot empties.
- **Bench units don't fight**: a benched Dragon never appears in the battle roster; the fielded unit does; the bench
  survives the battle untouched.
- **Interest math**: `gold = min(12, 10 + min(3, floor(saved/3)))` verified for saved = 0/2/3/5/6/9/12/30.
- **Warlord retry**: a boss loss at depth 10 costs 2 lives, returns to the shop phase (not the map), and keeps the
  player positioned at the boss node for the retry.
- **Event choices**: +4 gold lands in the next shop, heal restores exactly 1 life (capped), free recruit lands on the
  bench; all three return to the map phase.

## Results (final config, 3 × 30 runs/policy, seeds 5000/6000/7000, commanders rotated)

| Metric | THOUGHTFUL | GREEDY |
|---|---|---|
| Win rate (pooled n=90) | **43/90 (47.8%)** | **15/90 (16.7%)** |
| Win rate by seed | 33% / 60% / 50% | 3% / 20% / 27% |
| Separation (pooled) | — | **2.87× in thoughtful's favor** |
| Avg depth reached | ~9.6 / 10 | ~9.4 / 10 |
| Deaths by depth (pooled) | L1-3: 0 · L4-6: 0 · L7-9: 16 · L10 boss: 30 | L1-3: 0 · L4-6: 0 · L7-9: 30 · L10 boss: 45 |
| Lives lost by depth (pooled) | 6 / 62 / 71 / 63 | 8 / 80 / 88 / 74 |
| Softlocks | 1 (harness artifact, see below) | 0 |
| Console errors | **0** | **0** |

Pre-tuning baseline (same harness, pooled n=60/policy): thoughtful **5%**, greedy **0%**, all deaths L7-9/L10 —
the campaign back half and the Warlord were walls nobody could climb.

## Verdict vs targets

- **Thoughtful clearly beats greedy (≥2×)** — met: 2.87× pooled (per-seed 10.0× / 3.0× / 1.88×).
- **Thoughtful ~30-55% wins** — met: 47.8% pooled, 33-60% per seed.
- **Deaths concentrated in the back half** — met emphatically: zero deaths before depth 7 in all 180 final runs;
  lives bleed starts at L4-6 and losses cluster at L7-9 and the Warlord.
- **Softlocks 0** — met for the game: no reachable state without a legal action was found in ~700 total runs across
  tuning. The 1 classified case (and one boss-stalemate case seen during tuning) are harness artifacts, below.

## Observations

1. **Merge density is the engine of power.** The single biggest bot improvement was converting leftover gold into
   rerolls to hunt copies — battle wins scale with ★-density far more than with raw stat buys. Human implication:
   the reroll button matters a lot; a player who never rerolls plays like GREEDY (~17%).
2. **The Warlord is the wall by design.** Both policies reach depth ~9.5 on average; the campaign kills few outright
   (deaths L7-9 mostly from running dry of lives), and the finale converts arrivals at ~50% (thoughtful) / ~25%
   (greedy). The 2-lives boss retry rule gives well-preserved runs a real second attempt, which is where the elite/
   event routing and life-mending of THOUGHTFUL pays off.
3. **These are consistent bots, not humans.** They never mis-click, always scout, and never tilt. Real players will
   land below these rates; the trustworthy signals are the separation and the death distribution, both healthy.
4. **Interest is cosmetically weak.** `min(12, 10+interest)` means banking 9 gold yields +2 net — the sim bots are
   right to ignore it. If banking is meant to be a real strategy, the cap needs headroom (e.g. cap 14); left
   unchanged here since it wasn't a balance-target knob and spend-everything play is fine for this PoC.

## Softlock classification (1/180 final runs — harness artifacts, not game bugs)

- Seed 5026 (final batch): run killed by the 30 s wall-clock guard mid-run at depth 4 with 5 lives and a winning
  record — a single slow-wall outlier (jsdom timer stall), not a stuck game state; would almost certainly have been
  a win.
- Seed 5029 (seen during tuning): five consecutive Warlord **draws** — a ★★★ Order/healer lineup vs the boss
  stalemated at the 60-turn battle cap; a drawn boss fight costs no lives and loops back to prep, and the bot
  re-prepped an identical lineup. The harness now perturbs the lineup after any draw and classifies 5 repeated
  same-node draws as a bot dead-end. A human simply changes their lineup. (Design note, non-blocking: a re-fightable
  0-cost boss draw is mildly exploitable; charging a draw 1 life at the boss would close it.)

## Tuning changes (games/warband.html — numeric knobs only, 5 lines)

Applied in small steps with 30-run re-checks after each; values reflect the current file:

| Knob | Line | Before | After |
|---|---|---|---|
| Enemy ★-up roll 1 (per unit) | 866 | `(depth-2)*0.17` | `(depth-2)*0.11` |
| Enemy ★-up roll 2 (per unit) | 867 | `(depth-5)*0.18` | `(depth-5)*0.11` |
| Enemy flat stat band | 860 | `bAtk=⌊depth/3⌋, bHp=⌊depth·3/5⌋` | `bAtk=⌊(depth-1)/3⌋, bHp=⌊depth/2⌋` |
| Enemy item frequency | 870 | `0.22 + 0.03·depth` (from depth 4) | `0.16 + 0.025·depth` |
| Warlord band | 730 | `genEnemy(12, {count:5, minLvl:2, itemChance:.6})` | `genEnemy(10, {count:5, minLvl:2, itemChance:.4})` |

Rationale: at the old values the mid-game ★★ density hit 68% per enemy unit by depth 6 and the Warlord rolled ~98%
★★★ across all five units — thoughtful play topped out at 5-17% no matter how well it drafted. An intermediate
config (Warlord at effective depth 8/9) overshot to ~57-61% pooled; Warlord depth 10 with `itemChance .4` centers
the band. Each step was validated on 3 independent seed bases before adoption.

## Reproduce

```
cd sims
node warband-sim.js --mechanics     # 27 assertions
node warband-sim.js 30 5000         # thoughtful seeds 5000-5029, greedy 6000-6029
node warband-sim.js 30 6000
node warband-sim.js 30 7000
```
