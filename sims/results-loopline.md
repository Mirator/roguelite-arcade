# Loopline — Balance Simulation Results

Date: 2026-07-11 · Harness: `sims/loopline-sim.js` · Game: `games/loopline.html` (unmodified)

## Methods

The harness loads the single-file game into jsdom (canvas 2D context and requestAnimationFrame stubbed, jsdom's own localStorage used) and drives the game's **real** top-level functions: runs start via `startRun(0)`, time advances by calling the game's `update(1/30)` in batches of 90 ticks (~3 simulated seconds) between policy decisions, placements go through the game's own `computeLegal()` + `placeCard()`, and gear through `equipItem()`. Run outcomes are detected by wrapping the global `endRun`/`killEnemy` functions (jsdom globals are assignable, and the game's internal calls route through them), so mini-boss kills and death/victory are observed without touching game code. Three scripted policies: **naive** = never places a card, greedy equip only (equip any backpack item whose `gearScore` beats the equipped item in its slot); **decent** = places only off-road scenery cards (meadow/mountain/beacon/river/desert) at the first legal tile, same greedy equip; **good** = places every non-Oblivion card with synergy awareness (rivers seek adjacent scenery, scenery seeks rivers, mountains cluster, groves seek graveyards for Blood Grove mutations, villages/manors avoid each other to dodge corruption, desert capped at 2 copies), same greedy equip. No policy retreats or uses Oblivion; every run ends in death or a Lich kill. Each run is a fresh jsdom load (fresh localStorage → no camp meta upgrades), NG+0. 20 runs per policy; a second independent 20-run batch was run to gauge sampling variance (pooled n=40 shown separately). Zero console errors, zero softlocks/timeouts across all 120 runs; no game-code fixes were needed.

## Results (primary batch, 20 runs per policy)

| Policy | Avg death loop | Median death loop | Mini-boss win % | Lich reached % | Lich win % | Avg score |
|--------|---------------:|------------------:|----------------:|---------------:|-----------:|----------:|
| naive  | 4.3 | 4 | 30% | 10% | 5%  | 219 |
| decent | 4.9 | 4 | 50% | 25% | 10% | 339 |
| good   | 5.5 | 4 | 60% | 45% | 25% | 704 |

Pooled across both batches (n=40 per policy), to smooth 20-run noise:

| Policy | Avg death loop | Median death loop | Mini-boss win % | Lich reached % | Lich win % | Avg score |
|--------|---------------:|------------------:|----------------:|---------------:|-----------:|----------:|
| naive  | 4.6 | 4 | 40.0% | 17.5% | 7.5%  | 280 |
| decent | 4.9 | 4 | 42.5% | 22.5% | 7.5%  | 304 |
| good   | 5.9 | 6 | 70.0% | 47.5% | 22.5% | 775 |

(Avg/median death loop computed over deaths only; victories excluded.)

## Observations

1. **Loop 4 is the wall, and it's a coinflip on loot RNG.** For every policy the median death loop is 4 — the Bone Colossus fight. Whether the hero survives it is decided mostly by what gear dropped in loops 1–3, which makes 20-run win rates swing ±15 percentage points between batches (good: 60% then 80%; naive: 30% then 50%). Runs that lose the fight die at the campfire with near-identical low scores (~92–130 for good/decent losses), i.e. there is almost no partial credit.

2. **Scenery-only play barely beats doing nothing.** Pooled, decent (42.5% Colossus) is statistically indistinguishable from naive (40%) — in the second batch decent actually scored *below* naive. Off-road scenery adds max HP/regen but no extra loot economy; without spawner tiles the hero fights only ambient spawns and stays gear-poor. The real power in this design is spawner placement (grove/graveyard engines), which is what separates good from the other two on every metric.

3. **The Colossus is a harder filter than the Lich.** For the good policy, most Colossus victors go on to reach the Lich (47.5% reached vs 70% Colossus wins pooled), and roughly half of arrivals convert to victory (22.5% wins / 47.5% reached). The 2-phase Lich is dangerous but fair once a run has boss-worthy gear; the difficulty curve front-loads its filtering at loop 4.

4. **Score separates policies much more sharply than survival.** Avg score is ~280 / ~304 / ~775 (naive/decent/good) — a 2.5–2.8× spread driven by spawner kill income and the victory bonus, versus only a ~1.3-loop spread in avg death loop. Score (and thus camp-supply income) is a good proxy for play quality; death loop alone is not.

5. **Engine health: clean.** 120 full runs produced zero console errors, zero unhandled rejections, and zero softlocks (every run terminated via the game's own `endRun`). No bug fixes to `loopline.html` were needed or made.

## Tuning-target check

| Target | Measured (pooled n=40) | Verdict |
|--------|------------------------|---------|
| Naive dies loop 3–5 | avg death loop 4.6, median 4 | **Met** — though naive also beats the Colossus ~40% of the time on lucky gear, which the target didn't anticipate |
| Decent beats Colossus ~50% | 42.5% (50% in the primary batch) | **Roughly met**, at the low end; scenery-only play adds less than intended over naive |
| Good beats Colossus 75%+ | 70% (60% / 80% across batches) | **Marginally missed** — inside sampling noise of the target, but the point estimate is below 75% |
| Good beats Lich 10–30% | 22.5% (25% / 20%) | **Met** |

Caveat vs the earlier in-page sims (good ≈ 75–85% Colossus, decent ≈ 50%): the direction and ordering fully reproduce, but exact rates differ — expected, since scripted-policy implementations differ in detail and 20-run batches carry ±15pp noise on the Colossus coinflip. If a retune is ever considered, the actionable signals here are the decent≈naive gap (scenery undertuned relative to spawners) and the all-or-nothing loop-4 wall — but per scope, no balance changes were made.

## Reproducing

```
node sims/loopline-sim.js
```

Requires `jsdom` (already in `sims/node_modules`, see `sims/package.json`). Runs 3 × 20 runs (~30 s total), prints per-run lines, the aggregate table, and an anomaly report (timeouts / console errors).
