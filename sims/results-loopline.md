# Loopline — Balance Simulation Results

Date: 2026-07-13 · Harness: `sims/loopline-sim.js` · Game: `games/loopline.html` (unmodified)

## Method

The harness loads a fresh copy of the real game in jsdom for every run and drives its public game functions. `mulberry32` replaces `window.Math.random` in jsdom's `beforeParse` hook, before the page script evaluates, so initialization and play share one deterministic random stream. Each policy receives the same ordered seed cohort. Every per-run line includes its seed; anomaly lines include the affected seed as well.

Policies are unchanged: naive only equips upgrades, decent also places scenery, and good places non-Oblivion cards with simple synergy rules. Outcomes are observed through the game's `endRun` path. The validity gate replays seed 424242 twice and requires identical result objects; two independent command invocations also produced identical `RESULT_JSON`.

## Current fixed-seed batch

Command: `node sims/loopline-sim.js 20 12000`
Seeds: 12000–12019 for each policy · elapsed: 4.6 s · console errors/timeouts: 0

| Policy | Outcomes (win/death/softlock) | Avg death loop | Median death loop | Mini-boss win | Lich reached | Lich win | Avg score |
|---|---:|---:|---:|---:|---:|---:|---:|
| naive | 3 / 17 / 0 | 5.2 | 4.0 | 45% | 30% | 15% | 397 |
| decent | 4 / 16 / 0 | 4.9 | 4.0 | 40% | 35% | 20% | 387 |
| good | 2 / 18 / 0 | 6.7 | 7.5 | 80% | 55% | 10% | 901 |

Average and median death loop use deaths only. Other rates use all 20 requested runs. These values are a reproducible snapshot of this cohort, not a claim about broader player win rates.

## Reproduce

```powershell
cd sims
npm ci
node loopline-sim.js --validity
node loopline-sim.js 20 12000
```
