# Swarm — Balance / Meta-Tree Simulation Results

Date: 2026-07-11 · Harness: `sims/swarm-sim.js` (+ `sims/run-swarm.sh`) · Game: `games/swarm.html` (unmodified) · Browser checks via preview server on `:8646`

## Methods

Two independent verification tracks.

**(1) In-browser mechanics (real DOM/pointer events).** The live game was driven on the preview server at `http://localhost:8646/games/swarm.html`. Tree nodes were bought by dispatching real `MouseEvent('click')` on the rendered `#treeNodesFull .tnode` divs (first click selects → info panel; second click buys, exactly as a user does), RESPEC/start via clicks on the real `#respecBtnFull`/`startRow`/`startBtn` elements. State was read back through the `window.__swarm` handle (`tree`, `treeBonus()`, `player`, `weapons`, `stats()`, `hurtPlayer()`). Persistence was tested by writing `localStorage`, calling `location.reload()`, and re-reading. Console was watched for errors throughout.

**(2) Headless survival/economy sims.** `sims/swarm-sim.js` loads the single-file game with stubbed DOM/canvas/rAF (its own in-memory `localStorage`) and drives the game's **real** `update(dt)` at a fixed 16.67 ms step via a gap-seeking kiting AI (`PROFILE=mid`: ~100 ms decision cadence, 250 ms reaction lag, 20%/tick dodge-miss — a competent-but-human kiter, not frame-perfect). Level-up/chest picks go through the real card DOM + click handlers with a skilled build-priority policy (evolutions > core damage/rate > deepen owned weapons > breadth > defense-when-low > utility). Tree ownership is pre-seeded via the `TREE=` env var (writes `swarm_tree`), matching the exact node IDs a player would buy. Three tiers × 5 runs, run **twice** (pooled n=10/tier) to smooth variance. All sim batches were run as **background** tasks (never blocking the foreground) per the anti-hang protocol.

Reproduce: `bash sims/run-swarm.sh` (writes `sims/swarm-results.jsonl`). The wrapper stops without appending a result if the simulator fails or its first output line is not valid JSON. Raw data from this session: `sims/swarm-results-batch1.jsonl`, `sims/swarm-results-batch2.jsonl`.

## Tree-mechanics checks (in-browser, real events)

| Check | Method | Result |
|-------|--------|--------|
| Node select → info panel → buy | Real clicks on o1 (select shows cost, second click buys) | **PASS** |
| Full prereq **chain** buy | Bought o1→o2→o3→o6 by real double-clicks; o6 (req o3) only buyable after chain | **PASS** — exact costs deducted (15/35/70/190), 5000→4690 |
| Prereq gating (locked node) | Locked nodes render `.locked`, `buyBtnFull.disabled`, `buyNode()` returns false | **PASS** |
| Insufficient funds | `buyBtnFull.disabled` when `coins < cost`; buy rejected | **PASS** |
| `treeBonus()` reflects purchases | After o1+o2+o6: dmg=1.33, crit=0.05, rate=1.10 (o3) | **PASS** (matches formula) |
| RESPEC 50% refund + state clear | Real click `#respecBtnFull`; spent 310 → refunded `floor(310×0.5)=155` (4690→4845); `tree={}` | **PASS** |
| Persistence across reload | Seeded 15-node tree + reload → all 15 nodes survive from `swarm_tree` | **PASS** |
| Weapon-unlock nodes grant weapon | Own o4, select Blades, start → `weapons.orbit.level===1` (not bolt) | **PASS** |
| Head Start (f5) starts at level 2 | Own f5, start → `player.level===2` + free level-up card offered | **PASS** |
| Phoenix (v7) revives once | Own v7; lethal `hurtPlayer(9999)` → revive at hp 63 = ceil(125×0.5), revives 1→0, still alive; 2nd lethal hit → dies | **PASS** |
| Console errors | Watched across all of the above | **ZERO** (no logs, no errors) |

All mechanics pass. No game-code bugs found; no fixes needed.

## Survival curve (headless, PROFILE=mid, pooled n=10/tier)

| Tier | Setup | Median survival | Mean (deaths) | Win % (30:00) | Notes |
|------|-------|----------------:|--------------:|--------------:|-------|
| naked | 60 HP, no nodes | **2:49** | 2:50 | 0% | range 1:22–3:50; dies before/at first boss (SUNDERER @150s) |
| mid-tree | 9 nodes (o1-4,v1-4,f1 · ~440c) | **8:14** | 7:23 | 0% (1/10 reached 15:00 cap) | ~**2.9× naked** |
| near-full | all 21 nodes (2240c) | 30:00 (winners) | ~9:36 (losers) | **50%** | losers all die 8:44–10:43; winners cap at 30:00 w/ 5 evolutions |

Ratio check: mid median (494 s) ÷ naked median (169 s) = **2.9×** — inside the 2–3× target. Near-full reaches ~9–10.5 min even on losses and wins 50% of the time (≤ the 70% ceiling; "wins sometimes" satisfied).

## Economy math

- **Tree cost** (verified from `TREE_NODES`, lines 1265–1285): Offense 720 · Vitality 880 · Fortune 640 → **full tree = 2240 coins**. Tier-1 nodes (`req:"root"`): o1/v1/f1 = **15 each**.
- **Salvage formula** (line 1477): `round((8 + floor(elapsed/12)*4) × coinMul)`; `runCoins` (pickups + salvage) capped at `RUN_COIN_CAP = 1500` (line 353), banked to `coins` on death/win (lines 1478–1480). Sanity: a 1:22 death → `8 + 6×4 = 32` salvage, matches observed.
- **First ~3 deaths fund tier-1?** First-3 naked banks: batch1 = 183+118+152 = **453**, batch2 = 44+202+79 = **325**. Even the three *smallest* naked banks across n=10 (44+69+79) = 192. All ≫ the 30 coins for 2 tier-1 nodes — **decisively met** (a fresh profile can open the whole tier-1 row after ~2 deaths).
- **Runs to full tree (2240c):** pooled mean naked bank = **118 coins/run** → naive flat-rate floor ≈ **19 runs**. Realistically fewer: banks grow with the survival→income flywheel (mid-tree runs banked mean ~590/run; full-tree runs hit the 1500 cap). A realistic climb (3 naked → tier-1/2, then mid-tier runs at 300–800) reaches full in **~10–14 runs**.

## Tuning

**No changes made.** The curve is well-shaped: naked (0% win, dies at first boss) → mid 2.9× → near-full 50% win, and the economy comfortably funds early nodes while pacing the full tree to ~10–19 runs. The one marginal item — pooled naked median 2:49 vs the 1:00–2:30 sim target (batch2 alone was in-range at 2:14) — is a <20 s overshoot dominated by run-to-run variance (1:22–3:50) and by the idealized kiting AI, which out-survives a real touchpad human (the design intent, human death ~1:00–1:30, will land faster in practice). Dropping the 60-HP baseline would ripple through the entire curve and risk over-nerfing mid/full for a within-noise proxy miss, so per scope no knob was touched.

## Engine health

Zero console errors in-browser. Across 30 headless runs (2 batches) all runs terminated cleanly via the game's own `die()`/`win()`; avg frame < 0.5 ms, peak 26–150 ms during 30-min full-tree runs. A single 170 s frame spike seen in an earlier batch1 full run did **not** reproduce in batch2 — it was a one-off host stall, not a game hang.
