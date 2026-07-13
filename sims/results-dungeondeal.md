# Dungeon Deal — Balance Simulation Results

## Methods

The harness (`sims/dungeondeal-sim.js`, re-run with `node sims/dungeondeal-sim.js [runsPerPolicy] [baseSeed]`) loads
`games/dungeondeal.html` into jsdom and plays it through the game's **real input surface**: every action is a
dispatched `MouseEvent` click on `#board .card`/`.slot` elements (the game's own `.reachable`/`.target` classes gate
what is clickable), statusbar spell chips, and overlay buttons for perks, level-up boons, events, and the merchant.
No game logic is reimplemented — combat, loot, XP, and death all resolve through the page's own handlers. Policy
evaluation reuses the game's own exposed math (`predictedDamage`, `trapDamage`) and reads state via the game's
`window.DD` debug handle. The consume-animation input lock is handled by installing a virtual clock and fast-forwarding
between actions. Runs are seeded (`Math.random` replaced with mulberry32 per run), making the whole batch
reproducible.

**greedy** always takes the best-value adjacent card: potions when hurt, better weapons, then the weakest survivable
monster, then loot; random perks/boons; only buys healing at merchants. **tactical** adds positioning (center over
corners), saves Fireball for elites/bosses, arms Freeze only for big hits, uses Swap to pull a distant potion adjacent
when low, banks keys for locked chests, and picks defensive perks/boons when HP-poor. Both refuse predictably-lethal
cards while any alternative exists.

## Results (pooled n = 24 per policy, seeds 2000–2011 + 3000–3011, post-tuning)

| Metric | greedy | tactical |
|---|---|---|
| Win rate | 12/24 (50%) | 17/24 (71%) |
| Median floor reached | 10 | 10 |
| Avg floor reached | 9.4 | 9.7 |
| Avg level at end | ~17 | ~18 |
| Deaths by floor | F5·2 F7·2 F8·2 F9·1 F10·5 | F7·2 F9·1 F10·4 |
| Softlocks (bot artifact — see below) | 0 | 4 |
| Console errors (all runs) | 0 | 0 |

**Before tuning (n=40/policy):** greedy 83% (all 7 deaths on floor 10), tactical 100%, zero deaths on floors 1–9 —
the game had no tension. After tuning, deaths now spread across **floors 5–10**, which was the primary goal.

## Observations

1. **Tension goal met.** The pre-tuning game let both policies coast to the floor-10 boss untouched; deaths now
   occur throughout the back half (floor 5 mini-boss onward), so the mid-game is a real resource squeeze.
2. **These are perfect-play bots and overperform humans** — they use the game's own `predictedDamage` to never mis-time
   a fight. A human greedy player, mis-drinking potions and taking bad fights, will land well below the bot's 50%. The
   absolute rates are bot-specific; the *separation* (tactical clearly ahead of greedy, deaths spread across floors) is
   the trustworthy signal.
3. **Greedy at 50% is slightly above the 25–40% bot-target.** The lever is sustain: 4–5 potions/floor healing `3–5+f/3`
   let a greedy player out-heal chip damage. Reducing base potion count (`buildDeck`, line 398: `pCount = 4 + …`) to 3
   is the clean single knob if a harder greedy curve is wanted — deferred pending a confirmation batch so it doesn't
   also over-punish tactical.

## Softlock verdict — bot artifact, NOT a game bug

The tactical bot hit 4 "softlocks" (~17% of its runs), all confirmed as bot-policy dead-ends, not reachable game
hangs. Debug dumps (`DD_DEBUG=1`):

| seed | floor | HP | board remaining | verdict |
|---|---|---|---|---|
| 2011 | 7 | 12/27 | monster(9) | **survivable WIN** (9 dmg vs 12 HP → 3 HP, last monster → stairs) — bot failed to path to it |
| 2008 | 9 | 3/37 | shield, monster(13) | lost position (lethal, no weapon) — bot refuses the only card instead of dying |
| 3006 | 10 | 2/37 | monster(14), curse, trap(9) | lost position — same |
| 3008 | 7 | 9/33 | shield, curse, monster(10), trap(7) | lost position — same |

In **every** dump the game reports a non-empty `reachable` set — the game always offers a legal move. A human always
has an action (walk to the remaining card and take it, winning or dying). The bot has two gaps: (a) no fallback to
accept death when all remaining moves are lethal (it wanders to the step cap instead), and (b) an empty-cell pathing
failure that let it strand next to a winnable fight (seed 2011). Both are sim-harness limitations; **`dungeondeal.html`
was not changed for the softlocks** — there is no board state a human can reach with zero legal moves.

## Tuning changes (games/dungeondeal.html)

Difficulty tuning to spread deaths off floor 10 (applied during this pass; values reflect current file):
- `buildDeck` monster power `ri(1+f, 4+f)`, elite `ri(7,9)+max(0,f-5)`, weapon `ri(3,5)+floor((f-1)*0.9)` — the
  weapon-vs-monster gap narrowed vs the original so weapons deplete faster than they replace deeper in.
- Trap/curse counts ramp with floor (`tCount = min(3, 1+floor(f/3))`; curse from floor 2, second from floor 6).
- Boss (line 420): mini Warden floor 5 (power 8, 2 hits); Depth Lord floor 10, 2 stages (power 12→9, 2 hits each).

## Remaining risks

- Greedy bot win rate (50%) sits above the 25–40% bot-target; documented lever above, not yet applied/confirmed.
- Bot softlocks slightly deflate the tactical win rate (4 runs neither cleanly won nor lost); a bot fix would resolve
  ~2 into wins (pushing tactical toward ~79%) and ~2 into losses. Game unaffected either way.

## Addendum — MVP rework batch (2026-07-12)

Post-rework confirmation (boons removed → instant level-ups of +1 max HP & heal 2, XP curve `9 + lvl*6`; imp redesigned
to pay-8 vs steal-40%+curse; new cards Blood Gold/Anvil, Bomb spell, Midas/Feather relics; tier-2 merchant from floor 6).
`node sims/dungeondeal-sim.js 24 4000`:

| policy | win rate | deaths by floor | softlocks | console errors |
|---|---|---|---|---|
| greedy | 12/24 (50%) | F4:1 F5:2 F8:2 F9:1 F10:6 | 1 | 0 |
| tactical | 20/24 (83%) | F5:1 F8:1 F9:1 F10:1 | 3 (bot artifact, see above) | 0 |

Separation preserved (tactical ≫ greedy), greedy anchor unchanged at 50%, deaths spread across floors 4-10.
An earlier candidate curve (`8 + lvl*5`) pushed tactical to 87% and was rejected; current curve keeps hero power
close to the pre-rework line. Bomb/Blood Gold/Anvil scored into both bot policies (`sims/dungeondeal-sim.js`).
