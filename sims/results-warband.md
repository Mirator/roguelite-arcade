# Warband — Balance Simulation Results

Date: 2026-07-13 · Harness: `sims/warband-sim.js` · Game: `games/warband.html` (unmodified by this validity pass)

## Method

The harness loads the real game in jsdom and drives the same shop, lineup, map, event, and battle entry points used by the UI. Every run is seeded with `mulberry32`. Thoughtful and Greedy now receive the exact same ordered cohort: seed 5000 uses Necromancer, 5001 Tactician, 5002 Warlord, then that commander rotation repeats. This permits paired outcome comparisons; the old `+1000` Greedy seed offset is gone.

The summary reports both policy aggregates and within-pair deltas. A fast validity mode constructs both cohorts independently and asserts that their ordered seed/commander records are identical.

## Current paired batch

Command: `node sims/warband-sim.js 30 5000`
Seeds: 5000–5029 for both policies · elapsed: 253.5 s · softlocks: 0 · console errors: 0

| Metric | Thoughtful | Greedy |
|---|---:|---:|
| Outcomes (win/death/softlock) | 11 / 19 / 0 | 6 / 24 / 0 |
| Win rate | 36.7% | 20.0% |
| Avg depth reached | 9.77 | 9.53 |
| Avg battle wins | 6.13 | 5.07 |
| Deaths L1–3 / L4–6 / L7–9 / boss | 0 / 0 / 4 / 15 | 0 / 0 / 9 / 15 |
| Lives lost L1–3 / L4–6 / L7–9 / boss | 2 / 15 / 25 / 31 | 1 / 22 / 34 / 23 |

Paired outcomes: Thoughtful-only wins 8, Greedy-only wins 3, both win 3, neither wins 16. Thoughtful minus Greedy is **+16.7 percentage points** in wins, **+0.23** average depth, and **+1.07** average battle wins. The aggregate win-rate ratio is 1.83× for this cohort.

## Reproduce

```powershell
cd sims
npm ci
node warband-sim.js --validity
node warband-sim.js --mechanics
node warband-sim.js 30 5000
```
