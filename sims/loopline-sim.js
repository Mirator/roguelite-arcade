'use strict';
/**
 * Loopline balance simulation harness.
 *
 * Loads the single-file game (games/loopline.html) into jsdom, stubs out the
 * canvas 2D context + localStorage, and drives the REAL game loop (the exact
 * top-level `update(dt)`, `placeCard`, `computeLegal`, `equipItem` functions
 * defined inside the page's <script>) with three scripted policies:
 *
 *   naive  - never places any drawn card; equips greedily (upgrade a slot
 *            whenever a backpack item beats what's equipped there).
 *   decent - places only "scenery" (off-road) cards - meadow/mountain/
 *            beacon/desert/river - at the first legal tile returned by the
 *            game's own computeLegal(); ignores road/adjacency cards (grove,
 *            graveyard, village, battlefield, manor) entirely, so they pile
 *            up in hand and get auto-scrapped for a little score once the
 *            hand overflows. Same greedy equip as naive.
 *   good   - places every non-erase card, choosing tiles with lightweight
 *            synergy awareness driven by the game's own documented card
 *            synergies (river doubles adjacent meadow/mountain/beacon;
 *            grove+graveyard mutate into a Blood Grove; village avoids a
 *            Vampire Manor neighbor to dodge corruption; manor avoids a
 *            village neighbor for the same reason; desert use capped at 2
 *            copies since it debuffs the hero too). Same greedy equip.
 *
 * None of the three policies use Oblivion (erase) or ever retreat - a run
 * only ends via death or a Lich kill (the game's only two terminal states
 * reached during normal play; `endRun('retreat')` is never invoked here).
 *
 * Card categories (road/adj/off/special) are hardcoded in CARD_PLACE below,
 * mirroring the `place` field of the game's own CARDS object (games/
 * loopline.html, the CARDS constant) - that table is static content, not
 * derived game state, so hardcoding it here does not duplicate any logic
 * that could drift out of sync with balance changes.
 *
 * Each run gets a brand-new jsdom load (fresh localStorage => no camp/meta
 * upgrades carried over, so all 3 policies start from the same baseline),
 * and the window is explicitly closed afterwards to stop its
 * requestAnimationFrame loop/timers.
 *
 * Usage: node sims/loopline-sim.js
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require(path.join(__dirname, 'node_modules', 'jsdom'));

const HTML_PATH = path.join(__dirname, '..', 'games', 'loopline.html');
const RUNS_PER_POLICY = 20;
const MAX_SIM_SECONDS = 20000; // safety cap: simulated game-seconds per run
const MAX_WALL_MS = 20000; // safety cap: real wall-clock ms per run (softlock guard)
const DT = 1 / 30;
const DECISION_CHUNK_TICKS = 90; // ~3 simulated seconds between decisions

// Mirrors CARDS[type].place from games/loopline.html (static content, not state).
const CARD_PLACE = {
  grove: 'road', graveyard: 'road', village: 'road', battlefield: 'road',
  manor: 'adj',
  meadow: 'off', mountain: 'off', beacon: 'off', desert: 'off', river: 'off',
  oblivion: 'special',
};

/* ============================== jsdom loader ============================== */

function makeFakeCtx() {
  const store = {};
  const noop = () => {};
  return new Proxy({}, {
    get(target, prop) { return prop in store ? store[prop] : noop; },
    set(target, prop, value) { store[prop] = value; return true; },
  });
}

function loadGame() {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const errors = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    resources: 'usable',
    url: 'http://localhost/',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.HTMLCanvasElement.prototype.getContext = function () { return makeFakeCtx(); };
      window.addEventListener('error', (ev) => {
        errors.push((ev.error && ev.error.stack) || String(ev.message));
      });
      window.addEventListener('unhandledrejection', (ev) => {
        errors.push('unhandledrejection: ' + ((ev.reason && ev.reason.stack) || ev.reason));
      });
      const origError = window.console.error.bind(window.console);
      window.console.error = (...args) => {
        errors.push('console.error: ' + args.map(String).join(' '));
        origError(...args);
      };
    },
  });
  const win = dom.window;
  if (!win.G || typeof win.G.S === 'undefined') throw new Error('window.G.S not found after load');
  return { dom, win, errors };
}

/* ============================== shared equip logic ============================== */

function greedyEquip(win) {
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 100) {
    changed = false;
    const S = win.G.S;
    for (let i = 0; i < S.backpack.length; i++) {
      const it = S.backpack[i];
      const cur = S.equip[it.slot];
      if (!cur || win.gearScore(it) > win.gearScore(cur)) {
        win.equipItem(i);
        changed = true;
        break; // indices shifted (splice + possible push of displaced item); rescan
      }
    }
  }
}

/* ============================== placement policies ============================== */

function placeNone(_win) { /* naive: never place anything */ }

function placeSceneryOnly(win) {
  const S = win.G.S;
  for (let i = S.hand.length - 1; i >= 0; i--) {
    const type = S.hand[i];
    if (CARD_PLACE[type] !== 'off') continue; // decent only places scenery cards
    const legal = win.computeLegal(type);
    if (!legal.size) continue;
    const k = legal.values().next().value;
    const [x, y] = k.split(',').map(Number);
    win.placeCard(i, x, y);
  }
}

function nb4(x, y) { return [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]; }

function pickSynergyTile(win, type, cells) {
  const S = win.G.S;
  const placedAt = (x, y) => S.placed[x + ',' + y];
  const roadCardAt = (x, y) => {
    const ri = S.roadMap.get(x + ',' + y);
    return ri !== undefined ? S.loopTiles[ri].card : undefined;
  };
  const isRiverAdj = (x, y) => nb4(x, y).some(([nx, ny]) => {
    const p = placedAt(nx, ny); return p && p.type === 'river';
  });

  if (type === 'river') {
    let best = null, bestScore = -1;
    for (const k of cells) {
      const [x, y] = k.split(',').map(Number);
      let score = 0;
      for (const [nx, ny] of nb4(x, y)) {
        const p = placedAt(nx, ny);
        if (p && (p.type === 'meadow' || p.type === 'mountain' || p.type === 'beacon')) score++;
      }
      if (score > bestScore) { bestScore = score; best = k; }
    }
    return best;
  }
  if (type === 'meadow' || type === 'mountain' || type === 'beacon') {
    for (const k of cells) {
      const [x, y] = k.split(',').map(Number);
      if (isRiverAdj(x, y)) return k;
    }
    if (type === 'mountain') {
      for (const k of cells) {
        const [x, y] = k.split(',').map(Number);
        const hasMtnNeighbor = nb4(x, y).some(([nx, ny]) => {
          const p = placedAt(nx, ny); return p && p.type === 'mountain';
        });
        if (hasMtnNeighbor) return k;
      }
    }
    return cells[0];
  }
  if (type === 'desert') {
    let count = 0;
    for (const k in S.placed) if (S.placed[k].type === 'desert') count++;
    return count < 2 ? cells[0] : null; // cap desert use: debuffs hero too, not just enemies
  }
  if (type === 'grove') {
    for (const k of cells) {
      const [x, y] = k.split(',').map(Number);
      const hasGraveNeighbor = nb4(x, y).some(([nx, ny]) => {
        const c = roadCardAt(nx, ny); return c && c.type === 'graveyard';
      });
      if (hasGraveNeighbor) return k;
    }
    return cells[0];
  }
  if (type === 'graveyard') {
    for (const k of cells) {
      const [x, y] = k.split(',').map(Number);
      const hasGroveNeighbor = nb4(x, y).some(([nx, ny]) => {
        const c = roadCardAt(nx, ny); return c && c.type === 'grove';
      });
      if (hasGroveNeighbor) return k;
    }
    return cells[0];
  }
  if (type === 'village') {
    for (const k of cells) {
      const [x, y] = k.split(',').map(Number);
      const hasManorNeighbor = nb4(x, y).some(([nx, ny]) => {
        const p = placedAt(nx, ny); return p && p.type === 'manor';
      });
      if (!hasManorNeighbor) return k;
    }
    return cells[0]; // no safe tile available, place anyway
  }
  if (type === 'manor') {
    for (const k of cells) {
      const [x, y] = k.split(',').map(Number);
      const hasVillageNeighbor = nb4(x, y).some(([nx, ny]) => {
        const c = roadCardAt(nx, ny); return c && c.type === 'village';
      });
      if (!hasVillageNeighbor) return k;
    }
    return null; // would only corrupt a village - hold the card instead
  }
  return cells[0]; // battlefield etc: no particular synergy target
}

function placeSynergy(win) {
  const S = win.G.S;
  for (let i = S.hand.length - 1; i >= 0; i--) {
    const type = S.hand[i];
    if (CARD_PLACE[type] === 'special') continue; // never use oblivion
    const legalSet = win.computeLegal(type);
    if (!legalSet.size) continue;
    const cells = [...legalSet];
    const target = pickSynergyTile(win, type, cells);
    if (target == null) continue;
    const [x, y] = target.split(',').map(Number);
    win.placeCard(i, x, y);
  }
}

const POLICIES = {
  naive: { place: placeNone, label: 'naive (no placements + greedy equip)' },
  decent: { place: placeSceneryOnly, label: 'decent (scenery placements + greedy equip)' },
  good: { place: placeSynergy, label: 'good (synergy placements + greedy equip)' },
};

/* ============================== single-run driver ============================== */

function runOnce(policyName) {
  const { dom, win, errors } = loadGame();
  const policy = POLICIES[policyName];

  let endKind = null;
  const origEndRun = win.endRun;
  win.endRun = function (kind) { endKind = kind; return origEndRun(kind); };

  let miniBossWin = false;
  const origKillEnemy = win.killEnemy;
  win.killEnemy = function (e) {
    if (e.type === 'boneboss') miniBossWin = true;
    return origKillEnemy(e);
  };

  win.startRun(0);

  let simSeconds = 0;
  const wallStart = Date.now();
  let timedOut = false;
  while (win.G.S.phase === 'run') {
    for (let i = 0; i < DECISION_CHUNK_TICKS && win.G.S.phase === 'run'; i++) {
      win.update(DT);
      simSeconds += DT;
    }
    if (win.G.S.phase !== 'run') break;
    try {
      policy.place(win);
      greedyEquip(win);
    } catch (e) {
      errors.push('policy error: ' + (e.stack || e.message));
      break;
    }
    if (simSeconds > MAX_SIM_SECONDS || Date.now() - wallStart > MAX_WALL_MS) {
      timedOut = true;
      break;
    }
  }

  const S = win.G.S;
  const result = {
    finalLoop: S.loop,
    finalDay: S.day,
    finalScore: S.score,
    kind: timedOut ? 'timeout' : (endKind || 'unknown'),
    miniBossWin,
    lichReached: !!S.bossSpawned,
    lichWin: endKind === 'victory',
    errors: errors.slice(),
  };

  try { dom.window.close(); } catch (e) { /* ignore */ }
  return result;
}

/* ============================== aggregation ============================== */

function median(nums) {
  if (!nums.length) return NaN;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function avg(nums) { return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : NaN; }
function pct(n, total) { return total ? (100 * n / total) : 0; }

function summarize(policyName, results) {
  const deaths = results.filter(r => r.kind === 'death');
  const deathLoops = deaths.map(r => r.finalLoop);
  const miniBossWins = results.filter(r => r.miniBossWin).length;
  const lichReached = results.filter(r => r.lichReached).length;
  const lichWins = results.filter(r => r.lichWin).length;
  const scores = results.map(r => r.finalScore);
  const anomalies = results.filter(r => r.kind === 'timeout' || r.errors.length > 0);
  return {
    policyName,
    n: results.length,
    avgDeathLoop: avg(deathLoops),
    medianDeathLoop: median(deathLoops),
    deathCount: deaths.length,
    miniBossWinRate: pct(miniBossWins, results.length),
    lichReachedPct: pct(lichReached, results.length),
    lichWinRate: pct(lichWins, results.length),
    avgScore: avg(scores),
    anomalies,
  };
}

function fmt(n, d = 1) { return Number.isFinite(n) ? n.toFixed(d) : 'n/a'; }

/* ============================== main ============================== */

function main() {
  const allSummaries = [];
  const allResults = {};
  for (const policyName of Object.keys(POLICIES)) {
    console.log(`\nRunning policy "${policyName}" (${POLICIES[policyName].label}) x${RUNS_PER_POLICY}...`);
    const results = [];
    for (let i = 0; i < RUNS_PER_POLICY; i++) {
      const r = runOnce(policyName);
      results.push(r);
      const tag = r.kind === 'victory' ? 'WIN' : r.kind === 'death' ? `died L${r.finalLoop}` : r.kind;
      const errTag = r.errors.length ? ` [${r.errors.length} error(s)]` : '';
      console.log(`  run ${i + 1}/${RUNS_PER_POLICY}: ${tag}, score=${r.finalScore}, miniBossWin=${r.miniBossWin}, lichReached=${r.lichReached}${errTag}`);
    }
    allResults[policyName] = results;
    allSummaries.push(summarize(policyName, results));
  }

  console.log('\n=== RESULTS TABLE ===');
  console.log('policy   | avg death loop | median death loop | mini-boss win% | Lich reached% | Lich win% | avg score');
  for (const s of allSummaries) {
    console.log(
      `${s.policyName.padEnd(8)} | ${fmt(s.avgDeathLoop).padStart(14)} | ${fmt(s.medianDeathLoop).padStart(17)} | ` +
      `${fmt(s.miniBossWinRate).padStart(14)}% | ${fmt(s.lichReachedPct).padStart(13)}% | ${fmt(s.lichWinRate).padStart(8)}% | ${fmt(s.avgScore, 0)}`
    );
  }

  const anomalyTotal = allSummaries.reduce((a, s) => a + s.anomalies.length, 0);
  if (anomalyTotal) {
    console.log(`\n${anomalyTotal} run(s) had anomalies (timeout or console/JS errors):`);
    for (const s of allSummaries) {
      for (const a of s.anomalies) {
        console.log(`  [${s.policyName}] kind=${a.kind} loop=${a.finalLoop} errors=${JSON.stringify(a.errors)}`);
      }
    }
  } else {
    console.log('\nNo anomalies (timeouts or console/JS errors) across all runs.');
  }

  return { allSummaries, allResults };
}

if (require.main === module) {
  main();
}

module.exports = { main, runOnce, summarize, POLICIES };
