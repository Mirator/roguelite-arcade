# Dungeon Deal — Balance Simulation Results

Date: 2026-07-13 · Harness: `sims/dungeondeal-sim.js` · Game: `games/dungeondeal.html` (unmodified)

## Method

The jsdom harness drives the real UI/game entry points with deterministic `mulberry32` seeds. Greedy and Tactical each receive seeds 1000–1039. Results now have three disjoint terminal classes:

- win: the real game reached its victory screen;
- death: the real game reached its dead screen;
- softlock: the bot exhausted its progress/action guard without either terminal screen.

Softlocks are excluded from death causes and death floors. The win-rate denominator is completed runs (`wins + deaths`); requested counts and softlocks are printed separately. A synthetic validity mode requires one win, one death, and one softlock to remain disjoint and verifies that the softlock does not enter death aggregates.

## Current fixed-seed batch

Command: `node sims/dungeondeal-sim.js 40 1000`
Seeds: 1000–1039 for each policy · elapsed: 649.3 s · unknown outcomes: 0 · console errors: 0

| Metric | Greedy | Tactical |
|---|---:|---:|
| Requested | 40 | 40 |
| Outcomes (win/death/softlock) | 22 / 17 / 1 | 38 / 0 / 2 |
| Completed-run win rate | 22/39 (56.4%) | 38/38 (100%) |
| Median floor (all requested) | 10 | 10 |
| Avg floor (all requested) | 9.20 | 10.00 |
| Avg level at end (all requested) | 17.43 | 18.90 |
| Avg gold at end (all requested) | 867.4 | 686.3 |

Greedy deaths by cause: monster 6, trap 11, mimic 0, other 0. Greedy deaths by floor: F3:1, F5:1, F6:3, F7:1, F9:2, F10:9. Tactical had no completed deaths, so its cause and floor tables are empty. The three softlocks are simulator-policy guard outcomes, not deaths and not evidence of a game crash.

## Reproduce

```powershell
cd sims
npm ci
node dungeondeal-sim.js --validity
node dungeondeal-sim.js --mechanics
node dungeondeal-sim.js 40 1000
```
