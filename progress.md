Original prompt: Implement the approved UI/UX improvement plan across the arcade hub and all five games, preserving single-file delivery, balance, save data, and existing debug/simulation contracts.

## Working checklist

- [x] Shared arcade navigation, focus states, reduced motion, emoji fallbacks, and live status.
- [x] Responsive/touch improvements for Depths, Swarm, Loopline, Warband, and Dungeon Deal.
- [x] Progressive first-run guidance and replayable help.
- [x] Automated UI regression coverage at desktop, laptop, and phone viewports.
- [x] Existing mechanics suite and new UI suite pass.

## Notes

- Baseline commit: `3b3bf74`.
- Existing `npm test` mechanics/syntax suite passed before implementation.
- Keep `window.__D`, `window.__wb`, and the other simulation hooks stable.
- Hub cards now use concise hooks, run-length/style chips, explicit Play affordances, keyboard focus, mobile spacing, reduced motion, and emoji font fallbacks.
- Added shared title/arcade/menu/sound affordances, 44 px coarse-pointer targets, live regions, and `render_game_to_text` summaries without changing existing debug handles.
- Added first-run tutorial keys for all games, persistent touch/focus details, Dungeon Deal two-tap confirmation, Swarm drag steering, Loopline's mobile drawer/scrolling hand, and Warband semantic actions/recaps.
- Added `npm run test:ui` with Playwright coverage at 1440×900, 1024×768, and touch-emulated 390×844.
- Final verification: `npm test` passed; `npm run test:ui` passed (22 active, 8 intentional project skips).
