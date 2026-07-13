# Depths — Balance Simulation Results

Date: 2026-07-13 · Harness: `sims/depths-sim.js` · Game: `games/depths.html` (unmodified)

## Method

The harness loads the real game in jsdom and drives keyboard and canvas input. Each policy/class cell receives the same deterministic seed list; `window.Math.random` is replaced in `beforeParse`, before game initialization. Reckless rushes objectives with little tactical resource use; Careful clears, uses cover and consumables, and makes defensive choices.

Win, death, and stuck/timeout are exclusive terminal classes. A result-health validator rejects malformed overlaps, missing requested results, and any nonempty batch with no completed win/death results. Console/page errors continue to fail the process independently. Its synthetic validity mode proves an all-stuck batch fails while a mixed completed/stuck batch passes.

## Current fixed-seed batch

Command: `$env:RUNS='22'; $env:BASE_SEED='16000'; node sims/depths-sim.js`
Seeds: 16000–16021 for each of six cells · elapsed: 29.1 s · total: 132 requested, 115 deaths, 15 wins, 2 stuck/timeouts, 0 console/page errors

| Policy | Class | Outcomes (win/death/stuck) | Win % requested | Median depth | Avg level @ death | Avg souls | Avg kills | Top death causes |
|---|---|---:|---:|---:|---:|---:|---:|---|
| reckless | warrior | 0 / 22 / 0 | 0% | 4 | 2.8 | 33 | 7.3 | kobold slinger (5), goblin (3), wraith (2) |
| reckless | ranger | 0 / 22 / 0 | 0% | 2 | 1.6 | 19 | 3.6 | goblin champion (5), poison (4), goblin (3) |
| reckless | alchemist | 0 / 22 / 0 | 0% | 2 | 1.6 | 18 | 3.4 | kobold slinger (8), goblin (4), kobold slinger champion (3) |
| careful | warrior | 4 / 18 / 0 | 18% | 7 | 7.6 | 138 | 50.0 | burning (6), kobold slinger (6), fire mage champion (2) |
| careful | ranger | 10 / 10 / 2 | 45% | 8.5 | 5.1 | 169 | 60.6 | cave spider champion (2), kobold slinger champion (2), orc champion (1) |
| careful | alchemist | 1 / 21 / 0 | 5% | 7 | 8.8 | 123 | 45.3 | burning (10), fire mage (3), kobold slinger (3) |

Deaths by depth: d1:18, d2:25, d3:24, d4:18, d5:3, d6:1, d7:19, d8:2, d9:2, d10:3. The two Careful Ranger guard outcomes are reported as stuck/timeouts and excluded from its ten completed deaths.

## Reproduce

```powershell
cd sims
npm ci
node depths-sim.js --validity
$env:RUNS='22'
$env:BASE_SEED='16000'
node depths-sim.js
```
