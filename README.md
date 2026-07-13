# Roguelite PoC Arcade

Five single-file, dependency-free browser roguelites — **100% touchpad-playable** (move, click, drag; no keyboard required). Each game is one self-contained `.html` file with no build step, no CDN, and no external assets.

> ▶️ **Play it:** **https://mirator.github.io/roguelite-arcade/**

## The games

| Game | Genre | How you play |
|------|-------|--------------|
| **[Depths](games/depths.html)** | Classic roguelike RPG | Pick a class (Warrior / Ranger / Alchemist), click to move, click monsters to fight. Abilities, level-up boons, gear rarities, cursed items, shops, champions, a Soul Shrine that carries between runs — reach the Amulet on depth 10. |
| **[Swarm](games/swarm.html)** | Survivors / auto-shooter | Your hero chases the cursor; weapons fire on their own. Dodge artillery and bombers, survive escalating bosses. A 22-node upgrade tree funded by every death. |
| **[Loopline](games/loopline.html)** | Loop Hero-style idle tactics | The hero walks the loop alone — you shape the world with adjacency-synergy cards, gear up, and decide when to risk one more lap. Two-phase Lich at loop 8, NG+, camp meta-shop. |
| **[Warband](games/warband.html)** | Auto-battler | Pick a commander, draft around four faction synergies, equip spoils, and scout the exact enemy lineup before each fight. Gold interest makes every coin a decision. |
| **[Dungeon Deal](games/dungeondeal.html)** | Card dungeon | A 4×4 grid of fate — you move into every card you take. Keys, targeted spells, relics, XP levels, a mini-boss on floor 5 and a two-stage Depth Lord on floor 10. |

Start from **[`index.html`](index.html)** — the arcade hub links to all five.

## Controls

Everything is playable with a touchpad alone — cursor movement, left-click, and (in Brickfall-style aiming) click-drag. No right-click, scroll wheel, or keyboard is required, though some games accept keyboard shortcuts as an optional bonus.

## Run locally

No build step — it's static files. Serve the folder with any static server:

```bash
python3 -m http.server 8642
# then open http://localhost:8642
```

Opening `index.html` directly from disk works too, though a local server is recommended so relative links behave.

## Balance simulations

Each game has a re-runnable, headless balance harness under [`sims/`](sims/) that loads the real game in [jsdom](https://github.com/jsdom/jsdom) and plays it through the game's own input handlers — no game logic is reimplemented. Results are written up in `sims/results-*.md`.

```bash
cd sims
npm ci                        # reproducible install from package-lock.json
npm test                      # fast syntax and mechanics verification
```

Long-running balance batches are separate from the fast verification command:

```bash
cd sims
npm run loopline              # e.g. run the Loopline balance batch
```

## Deployment

Pushing to `main` triggers the workflow in [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml), which publishes the repository root to GitHub Pages. The Pages source is set to **GitHub Actions**, so every push to `main` redeploys automatically.

## License

MIT — see [LICENSE](LICENSE).
