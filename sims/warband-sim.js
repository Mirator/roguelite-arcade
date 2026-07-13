'use strict';
/**
 * Warband balance simulation harness.
 *
 * Loads the single-file game (games/warband.html) into jsdom and drives the
 * REAL game through the functions it exposes on its own debug handle,
 * `window.__wb` — chooseNode, clickShop, clickSlot, clickStash, toggleFreeze,
 * reroll, sellSelected, pickPatron, pickEvent, pickDrop, skipDrop, runBattle,
 * fast(). These are the exact top-level functions the game's own
 * `data-act` click dispatcher calls (see the `document.addEventListener(
 * 'click', ...)` switch near the end of the <script>) — the harness never
 * reimplements draft, merge, economy, or combat math, it only decides which
 * of the game's real entry points to call and with what arguments. Two-step
 * selections (buy a shop card onto a slot, equip a stash item onto a unit,
 * swap/merge two owned units) are driven with the same click→click sequence
 * a mouse-only player would use (e.g. `clickShop(i)` then `clickSlot('line',
 * j)`), never the lower-level `performMove` shortcut. The isolated
 * --mechanics probes additionally prep specific test states via the debug
 * helpers (`setShop`/`give`/`giveItem`) and a couple of direct state pokes,
 * but every behavior under test still runs through the real flow.
 *
 * NOTE on the previous harness: an older sim (scratchpad wbtest/) targeted a
 * prior build with a flat 10-round loop and a pay-to-train `armTrain`
 * action. That build was replaced by the campaign-map structure (map →
 * shop → battle, with event/patron/drop side-phases, merges only via
 * drafting a second copy of a unit) — see the NOTE comment near the top of
 * games/warband.html's <script>. This harness targets the current build.
 *
 * Runs are seeded — `Math.random` is replaced per run with mulberry32 in the
 * jsdom window, so `node sims/warband-sim.js` is fully reproducible. Battle
 * animation delays are real `setTimeout`s gated by `bt.speed`
 * (`wb.fast(mult)` divides every `wait(ms)` by `mult`), so runs finish in a
 * handful of real milliseconds without needing a virtual clock. Aggregates
 * only; a wall-clock guard and an action-count cap classify any run that
 * doesn't reach `over` in reasonable time/steps as a softlock rather than
 * hanging the batch.
 *
 * Policies:
 *   THOUGHTFUL - commits to one faction off the very first shop (best
 *     average raw stat-score among that shop's offers) and sticks with it:
 *     buys/merges toward it, swaps out off-faction filler once the lineup is
 *     full, picks the matching patron at the round-3+ fork, benches
 *     off-turn copies as merge fodder instead of dumping them, positions
 *     tanky/defensive-ability units at the front (low lineup index — the
 *     side the CSS renders on the right and `front()` reads first in
 *     battle) and glass-cannon carries at the back, equips defensive items
 *     (Tower Shield/Plate/Warhorn) on the front unit and offensive items on
 *     its highest-ATK unit, prefers the Elite (⭐) map node when healthy
 *     (>=4 lives) for better spoils and the Event (❓) node when hurt, and
 *     picks event choices by need (heal below max lives, else a free
 *     recruit if there's room, else the flat gold).
 *   GREEDY - buys whichever shop offer has the best raw stats with no
 *     faction awareness at all, always front-fills the lowest empty lineup
 *     index (no tank positioning), equips items onto the first item-less
 *     unit it finds, always takes the first faction listed at the patron
 *     fork, always takes the first *applicable* event option in listed
 *     order (free recruit if there's room, else the flat gold — it never
 *     reasons about healing), and never benches anything as deliberate
 *     merge fodder.
 *
 * Usage: node sims/warband-sim.js [runsPerPolicy=30] [baseSeed=5000]
 *        node sims/warband-sim.js --mechanics   (run the mechanics spot-checks only)
 */

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require(path.join(__dirname, 'node_modules', 'jsdom'));

const HTML_PATH = process.env.WB_HTML || path.join(__dirname, '..', 'games', 'warband.html');
const HTML = fs.readFileSync(HTML_PATH, 'utf8');

const MAX_STEPS = 400;       // safety cap: phase-loop iterations per run
const MAX_WALL_MS = 30000;   // safety cap: real wall-clock ms per run (softlock guard)
const BATTLE_SPEED = 10000;  // wb.fast() multiplier — real setTimeout waits shrink to ~0

// ------------------------------------------------------------------ rng ---
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --------------------------------------------------------------- loader ---
function loadGame(seed) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push('jsdomError: ' + (e && e.message)));
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously',
    url: 'http://localhost/',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      window.addEventListener('error', (ev) => {
        errors.push((ev.error && ev.error.stack) || ev.message);
      });
      window.addEventListener('unhandledrejection', (ev) => {
        errors.push('unhandledrejection: ' + ((ev.reason && ev.reason.stack) || ev.reason));
      });
      const origError = window.console.error.bind(window.console);
      window.console.error = (...a) => {
        errors.push('console.error: ' + a.map(String).join(' '));
        origError(...a);
      };
    },
  });
  const win = dom.window;
  if (!win.__wb) throw new Error('window.__wb handle not found after load');
  win.Math.random = mulberry32(seed);
  // Constants read straight from the page's own top-level `const`s (classic
  // <script>, so they live in the realm's global lexical scope and are
  // visible to window.eval in the same realm) rather than re-hardcoded here,
  // so a numeric-knob tuning pass never silently desyncs the harness.
  const K = {};
  for (const name of ['MAP_LAYERS', 'STASH_MAX', 'START_LIVES', 'MAX_LVL', 'COST_UNIT', 'GOLD_CAP']) {
    K[name] = win.eval(name);
  }
  return { dom, win, wb: win.__wb, errors, K };
}

// ------------------------------------------------------- shared scoring ---
// FRONT_BONUS / rawScore mirror the retired wbtest/bot.js heuristics — the
// unit table's shape (n,e,f,t,a,h,ab,v,d) is unchanged by the map rework.
const FRONT_BONUS = { armor: 6, shield: 5, rally: 4, revive: 4, faintBuff: 2, heal: 2, pack: 1, feast: 1 };
const DEFENSIVE_ITEMS = new Set(['tshield', 'plate', 'horn']);

function rawScore(UNITS, key) {
  const U = UNITS[key];
  return U.a * 1.3 + U.h + U.t * 1.5;
}
function frontScore(UNITS, key) {
  const U = UNITS[key];
  return (U.h - U.a) + (FRONT_BONUS[U.ab] || 0);
}
function emptySlots(arr) {
  const out = [];
  for (let i = 0; i < arr.length; i++) if (!arr[i]) out.push(i);
  return out;
}
function factionCounts(UNITS, list) {
  const c = { Order: 0, Beast: 0, Undead: 0, Arcane: 0 };
  for (const u of list) if (u) c[UNITS[u.key].f]++;
  return c;
}
function bestShopFaction(wb) {
  const S = wb.state;
  const sums = { Order: 0, Beast: 0, Undead: 0, Arcane: 0 };
  const cnts = { Order: 0, Beast: 0, Undead: 0, Arcane: 0 };
  for (const s of S.shop) {
    if (!s) continue;
    const f = wb.UNITS[s.key].f;
    sums[f] += rawScore(wb.UNITS, s.key); cnts[f]++;
  }
  let bf = 'Beast', bv = -1;
  for (const f in sums) { const avg = cnts[f] ? sums[f] / cnts[f] : 0; if (avg > bv) { bv = avg; bf = f; } }
  return bf;
}

// Find a shop offer that merges onto an existing owned copy (lineup first,
// then bench) — this is the ONLY way to upgrade a unit's stars now.
function findMergeCandidate(wb) {
  const S = wb.state;
  for (let i = 0; i < S.shop.length; i++) {
    const s = S.shop[i];
    if (!s) continue;
    for (let j = 0; j < S.lineup.length; j++) {
      const u = S.lineup[j];
      if (u && u.key === s.key && u.lvl < 3) return { shopI: i, zone: 'line', i: j };
    }
    for (let j = 0; j < S.bench.length; j++) {
      const u = S.bench[j];
      if (u && u.key === s.key && u.lvl < 3) return { shopI: i, zone: 'bench', i: j };
    }
  }
  return null;
}

function placeTarget(wb, key, slots) {
  const fs2 = frontScore(wb.UNITS, key);
  const filled = wb.state.lineup.filter(Boolean);
  const avg = filled.length ? filled.reduce((s, u) => s + frontScore(wb.UNITS, u.key), 0) / filled.length : 0;
  return fs2 >= avg ? Math.min(...slots) : Math.max(...slots);
}

function equipStash(wb) {
  const S = wb.state;
  let guard = 0;
  while (S.stash.length > 0 && guard++ < 6) {
    const item = S.stash[0];
    const candidates = S.lineup.map((u, i) => (u && !u.item) ? i : -1).filter((i) => i >= 0);
    if (!candidates.length) break;
    let target;
    if (DEFENSIVE_ITEMS.has(item)) target = Math.min(...candidates);
    else target = candidates.reduce((best, i) => (S.lineup[i].atk > S.lineup[best].atk ? i : best), candidates[0]);
    wb.clickStash(0);
    wb.clickSlot('line', target);
  }
}
function equipStashNaive(wb) {
  const S = wb.state;
  let guard = 0;
  while (S.stash.length > 0 && guard++ < 6) {
    const idx = S.lineup.findIndex((u) => u && !u.item);
    if (idx < 0) break;
    wb.clickStash(0);
    wb.clickSlot('line', idx);
  }
}

function nudgePositions(wb) {
  const S = wb.state;
  for (let i = 0; i < S.lineup.length - 1; i++) {
    const a = S.lineup[i], b = S.lineup[i + 1];
    if (!a || !b) continue;
    if (frontScore(wb.UNITS, b.key) > frontScore(wb.UNITS, a.key) + 2) {
      wb.clickSlot('line', i);
      wb.clickSlot('line', i + 1);
    }
  }
}

// If the lineup is full but the shop has a target-faction unit and we still
// field off-faction filler, sell the weakest off-faction unit to make room.
function swapForFaction(wb, targetFaction) {
  const S = wb.state;
  if (S.gold < 3) return false;
  const cnt = factionCounts(wb.UNITS, S.lineup)[targetFaction];
  if (cnt >= 5) return false;
  let shopI = -1, shopVal = -1;
  for (let i = 0; i < S.shop.length; i++) {
    const s = S.shop[i];
    if (!s || wb.UNITS[s.key].f !== targetFaction) continue;
    const v = rawScore(wb.UNITS, s.key);
    if (v > shopVal) { shopVal = v; shopI = i; }
  }
  if (shopI < 0) return false;
  let lineI = -1, lineVal = 1e9;
  for (let j = 0; j < S.lineup.length; j++) {
    const u = S.lineup[j];
    if (!u || wb.UNITS[u.key].f === targetFaction) continue;
    const v = u.atk + u.hp + u.lvl * 6 + (u.item ? 3 : 0);
    if (v < lineVal) { lineVal = v; lineI = j; }
  }
  if (lineI < 0) return false;
  if (lineVal > shopVal + 14) return false; // don't scrap a heavily invested unit for a fresh t1
  wb.clickSlot('line', lineI);
  wb.sellSelected();
  const slots = emptySlots(S.lineup);
  if (!slots.length || !S.shop[shopI]) return true;
  wb.clickShop(shopI);
  wb.clickSlot('line', slots[0]);
  return true;
}

// -------------------------------------------------- THOUGHTFUL shop pass ---
// Economy note: with `gold = min(12, 10 + min(3, floor(saved/3)))` interest
// nets at most +2 gold for banking 6-9 — hoarding is a losing play. So the
// thoughtful bot spends everything each shop: merges first, faction buys,
// then converts leftover gold into rerolls hunting more merge copies.
function buyPassThoughtful(wb, targetFaction) {
  const S = wb.state;
  let guard = 0;
  while (guard++ < 40) {
    // 1. Shop offer merges onto an owned copy (lineup or bench) — top value.
    if (S.gold >= 3) {
      const merge = findMergeCandidate(wb);
      if (merge) { wb.clickShop(merge.shopI); wb.clickSlot(merge.zone, merge.i); continue; }
    }
    // 2. Fill empty lineup slots, faction-weighted.
    const lineSlots = emptySlots(S.lineup);
    if (S.gold >= 3 && lineSlots.length) {
      let best = -1, bestScore = -1;
      for (let i = 0; i < S.shop.length; i++) {
        const s = S.shop[i];
        if (!s) continue;
        const U = wb.UNITS[s.key];
        let score = rawScore(wb.UNITS, s.key);
        if (U.f === targetFaction) score += 7;
        if (score > bestScore) { bestScore = score; best = i; }
      }
      if (best >= 0) {
        const key = S.shop[best].key;
        wb.clickShop(best);
        wb.clickSlot('line', placeTarget(wb, key, lineSlots));
        continue;
      }
    }
    // 3. Lineup full: push a doctrine swap (sell off-faction filler for an
    //    on-faction offer) toward the 3/5 thresholds.
    if (S.gold >= 3 && !lineSlots.length && swapForFaction(wb, targetFaction)) continue;
    // 4. Bench an on-faction offer as future merge fodder.
    const benchSlots = emptySlots(S.bench);
    if (S.gold >= 3 && !lineSlots.length && benchSlots.length) {
      let best = -1, bestScore = -1;
      for (let i = 0; i < S.shop.length; i++) {
        const s = S.shop[i];
        if (!s || wb.UNITS[s.key].f !== targetFaction) continue;
        const score = rawScore(wb.UNITS, s.key);
        if (score > bestScore) { bestScore = score; best = i; }
      }
      if (best >= 0) { wb.clickShop(best); wb.clickSlot('bench', benchSlots[0]); continue; }
    }
    // 5. Nothing actionable in this shop — convert leftover gold into
    //    rerolls hunting merge copies (free first for the Tactician).
    if (S.freeReroll) { wb.reroll(); continue; }
    if (S.gold >= 1) {
      const g = S.gold;
      wb.reroll();
      if (S.gold >= g) break; // reroll refused — bail out
      continue;
    }
    break;
  }
}

// Merge owned copies: a benched copy joins its lineup twin (+1★), freeing the
// bench slot — the whole point of holding merge fodder.
function mergeOwnedCopies(wb) {
  const S = wb.state;
  let guard = 0;
  let merged = true;
  while (merged && guard++ < 6) {
    merged = false;
    for (let b = 0; b < S.bench.length; b++) {
      const u = S.bench[b];
      if (!u) continue;
      const j = S.lineup.findIndex((v) => v && v.key === u.key && v.lvl < 3 && u.lvl < 3);
      if (j >= 0) {
        wb.clickSlot('bench', b);
        wb.clickSlot('line', j);
        merged = true;
        break;
      }
    }
  }
}

function playShopThoughtful(wb, committedFaction) {
  const S = wb.state;
  const targetFaction = committedFaction || bestShopFaction(wb);
  mergeOwnedCopies(wb);
  buyPassThoughtful(wb, targetFaction);
  mergeOwnedCopies(wb);
  // Promote a leveled/merged bench unit into an empty lineup slot if one opened up.
  for (let i = 0; i < S.bench.length; i++) {
    const u = S.bench[i];
    if (!u) continue;
    const slots = emptySlots(S.lineup);
    if (!slots.length) break;
    wb.clickSlot('bench', i);
    wb.clickSlot('line', placeTarget(wb, u.key, slots));
  }
  equipStash(wb);
  nudgePositions(wb);
  if (!S.lineup.some(Boolean)) {
    for (let i = 0; i < S.shop.length; i++) if (S.shop[i]) { wb.clickShop(i); wb.clickSlot('line', 0); break; }
  }
}

// ------------------------------------------------------ GREEDY shop pass ---
// A raw-stats player: no faction/patron intent, no bench planning, no
// positioning, no rerolls — but still takes the two obvious stat plays any
// non-strategic player makes: buy a copy onto a fielded twin (instant +1★
// stat jump) and, once full, sell the weakest unit for a bigger stat stick.
function playShopGreedy(wb) {
  const S = wb.state;
  let guard = 0;
  while (guard++ < 12) {
    if (S.gold < 3) break;
    // Obvious merge: the shop offers a copy of something already fielded.
    let did = false;
    for (let i = 0; i < S.shop.length && !did; i++) {
      const s = S.shop[i];
      if (!s) continue;
      const j = S.lineup.findIndex((u) => u && u.key === s.key && u.lvl < 3);
      if (j >= 0) { wb.clickShop(i); wb.clickSlot('line', j); did = true; }
    }
    if (did) continue;
    let best = -1, bestScore = -1;
    for (let i = 0; i < S.shop.length; i++) {
      const s = S.shop[i];
      if (!s) continue;
      const score = rawScore(wb.UNITS, s.key);
      if (score > bestScore) { bestScore = score; best = i; }
    }
    if (best < 0) break;
    const slots = emptySlots(S.lineup);
    if (slots.length) {
      wb.clickShop(best);
      wb.clickSlot('line', Math.min(...slots)); // always front-fills, no tank awareness
      continue;
    }
    // Full: upgrade-by-replacement if the offer out-stats the weakest fielded unit.
    let weak = -1, weakVal = Infinity;
    for (let j = 0; j < S.lineup.length; j++) {
      const u = S.lineup[j];
      const v = u.atk + u.hp + u.lvl * 8 + (u.item ? 3 : 0);
      if (v < weakVal) { weakVal = v; weak = j; }
    }
    const offer = S.shop[best];
    if (wb.UNITS[offer.key].a + wb.UNITS[offer.key].h + 8 <= weakVal) break; // nothing clearly better
    wb.clickSlot('line', weak);
    wb.sellSelected();
    const slots2 = emptySlots(S.lineup);
    if (!slots2.length || !S.shop[best]) break;
    wb.clickShop(best);
    wb.clickSlot('line', Math.min(...slots2));
  }
  equipStashNaive(wb);
  if (!S.lineup.some(Boolean)) {
    for (let i = 0; i < S.shop.length; i++) if (S.shop[i]) { wb.clickShop(i); wb.clickSlot('line', 0); break; }
  }
}

// ------------------------------------------------------------ map / side ---
function curDepth(wb) { return wb.state.pos ? wb.state.pos.l + 1 : 1; }

function chooseMapNode(wb, mode) {
  const S = wb.state;
  const l = S.pos ? S.pos.l + 1 : 0;
  const layer = S.map[l];
  const open = [];
  for (let i = 0; i < layer.length; i++) {
    const from = S.pos ? S.map[S.pos.l][S.pos.i] : null;
    if (!S.pos ? l === 0 : from.edges.includes(i)) open.push(i);
  }
  if (!open.length) return; // shouldn't happen
  if (mode === 'greedy') { wb.chooseNode(l, open[0]); return; }
  const healthy = S.lives >= 4;
  const hurt = S.lives <= 2;
  const score = (i) => {
    const t = layer[i].type;
    if (t === 'elite') return healthy ? 3 : (hurt ? -1 : 1);
    if (t === 'event') return hurt ? 4 : 1.5;
    return 2; // fight
  };
  let bi = open[0], bv = -Infinity;
  for (const i of open) { const v = score(i); if (v > bv) { bv = v; bi = i; } }
  wb.chooseNode(l, bi);
}

function pickEventChoice(wb, mode) {
  const S = wb.state;
  const canHeal = S.lives < wbK(wb).START_LIVES;
  const haveRoom = S.bench.some((b) => !b) || S.lineup.some((u) => !u);
  if (mode === 'thoughtful') {
    if (canHeal) { wb.pickEvent('life'); return; }
    if (haveRoom) { wb.pickEvent('unit'); return; }
    wb.pickEvent('gold');
  } else {
    // "first-listed" order is [unit, gold, life] — take the first one that's
    // actually applicable rather than wasting the click on a disabled option.
    if (haveRoom) { wb.pickEvent('unit'); return; }
    wb.pickEvent('gold');
  }
}
// Game constants of the currently loaded window; assigned per run/probe so
// helpers below never hardcode values that a tuning pass could change.
let _K = null;
function wbK() { return _K; }

function pickPatronChoice(wb, mode, committedFaction) {
  if (mode === 'thoughtful') wb.pickPatron(committedFaction);
  else wb.pickPatron(Object.keys(wb.FACTIONS)[0]); // never weighs the choice
}

function pickDropChoice(wb) {
  const S = wb.state;
  if (!S.dropChoices) return;
  if (S.stash.length >= _K.STASH_MAX) { wb.skipDrop(); return; }
  wb.pickDrop(0); // both policies just take the first offer; drops are a minor bonus either way
}

// --------------------------------------------------------------- runner ---
// runBattle() is async (it awaits real, if tiny, setTimeout-based waits under
// wb.fast()), so the whole phase loop is async and awaits each battle before
// reading the outcome — afterBattle() has already run by then.
async function playRunAsync(mode, commander, seed) {
  const { win, wb, errors, K } = loadGame(seed);
  _K = K;
  const t0 = Date.now();
  wb.startRun(commander);
  wb.fast(BATTLE_SPEED);
  const S = wb.state;
  const committedFaction = mode === 'thoughtful' ? bestShopFaction(wb) : null;

  const path = []; // {depth, type, result}
  let steps = 0;
  let softlock = false;

  while (S.phase !== 'over') {
    if (Date.now() - t0 > MAX_WALL_MS) { softlock = true; break; }
    if (++steps > MAX_STEPS) { softlock = true; break; }
    const phase = S.phase;
    if (phase === 'map') {
      chooseMapNode(wb, mode);
    } else if (phase === 'event') {
      pickEventChoice(wb, mode);
    } else if (phase === 'patron') {
      pickPatronChoice(wb, mode, committedFaction);
    } else if (phase === 'shop') {
      // If the last battle at this node was a draw, an identical re-prep
      // would stalemate again (deterministic combat) — rotate the lineup
      // through the real click flow to change the matchup order.
      const last = path[path.length - 1];
      if (last && last.result === 'draw' && last.depth === curDepth(wb)) {
        const filled = [];
        for (let i = 0; i < S.lineup.length; i++) if (S.lineup[i]) filled.push(i);
        if (filled.length >= 2) {
          wb.clickSlot('line', filled[0]);
          wb.clickSlot('line', filled[filled.length - 1]);
        }
      }
      if (mode === 'thoughtful') playShopThoughtful(wb, committedFaction);
      else playShopGreedy(wb);
      if (!S.lineup.some(Boolean)) { softlock = true; break; } // truly nothing to field
      const node = S.map[S.pos.l][S.pos.i];
      const depth = curDepth(wb);
      const type = node.type;
      const livesBefore = S.lives, winsBefore = S.wins;
      await wb.runBattle();
      const result = S.wins > winsBefore ? 'win' : (S.lives < livesBefore ? 'lose' : 'draw');
      path.push({ depth, type, result, livesAfter: S.lives });
      // A drawn boss fight costs no lives and loops back to the shop — a
      // repeated stalemate would retry forever. Classify as a dead-end.
      if (path.length >= 5 &&
          path.slice(-5).every((p) => p.result === 'draw' && p.depth === depth)) {
        softlock = true;
        break;
      }
    } else if (phase === 'drop') {
      pickDropChoice(wb);
    } else {
      softlock = true;
      break;
    }
  }
  // A run is a softlock iff the loop exited without the game reaching 'over'.
  softlock = S.phase !== 'over';
  if (softlock && process.env.WB_DEBUG) {
    const tailPath = path.slice(-6).map((p) => `${p.type}@${p.depth}:${p.result}`).join(' ');
    console.error(`\n[SOFTLOCK] ${mode} seed=${seed} cmd=${commander} phase=${S.phase} ` +
      `depth=${S.pos ? S.pos.l + 1 : 0} lives=${S.lives} gold=${S.gold} steps=${steps} ` +
      `ms=${Date.now() - t0} lineup=[${S.lineup.map((u) => (u ? `${u.key}L${u.lvl}` : '·')).join(',')}] ` +
      `tail: ${tailPath}`);
  }
  // Victory detection: endRun(true) bumps meta.trophies, and each jsdom load
  // starts with a fresh localStorage, so trophies>0 iff THIS run beat the boss.
  const victory = !softlock && wb.meta.trophies > 0;
  const depthReached = S.pos ? S.pos.l + 1 : 0;

  const res = {
    mode, commander, seed,
    won: victory,
    depthReached,
    wins: S.wins,
    lives: S.lives,
    path,
    softlock,
    steps,
    ms: Date.now() - t0,
    errors: errors.slice(),
    committedFaction,
    patron: S.patron,
  };
  win.close();
  return res;
}

// -------------------------------------------------------------- mechanics --
async function runMechanicsChecks() {
  const fails = [];
  const check = (name, cond) => { if (!cond) fails.push(name); console.log(`  [${cond ? 'OK' : 'FAIL'}] ${name}`); };

  // 1. Copy-merge stats + item transfer via the real move/merge flow.
  {
    const { win, wb, K } = loadGame(1);
    _K = K;
    wb.startRun('tact');
    wb.chooseNode(0, 0);           // layer-0 nodes are always plain fights -> shop phase
    const S = wb.state;
    check('setup: entered shop via map node', S.phase === 'shop');
    const key = 'knight';
    const U = wb.UNITS[key];
    wb.give(50);
    wb.setShop([key, key, key, null]);
    wb.clickShop(0); wb.clickSlot('line', 0); // buy copy #1 -> lineup slot 0, lvl1
    const lvl1atk = S.lineup[0].atk, lvl1hp = S.lineup[0].hp;
    check('merge: lvl1 stats match base', S.lineup[0].lvl === 1 && lvl1atk === U.a && lvl1hp === U.h);
    wb.setShop([key, null, null, null]);
    wb.clickShop(0); wb.clickSlot('line', 0); // buy copy #2 onto the same slot -> merges to lvl2
    check('merge: lvl2 after 2nd copy', S.lineup[0].lvl === 2);
    check('merge: lvl2 atk formula', S.lineup[0].atk === lvl1atk + U.a + 1);
    check('merge: lvl2 hp formula', S.lineup[0].hp === lvl1hp + U.h + 1);
    // Item transfer: put a copy WITH an item on the bench, move it onto the
    // item-less lineup unit -> destination should inherit the item and level up.
    wb.giveItem('cleaver');
    wb.setShop([key, null, null, null]);
    wb.clickShop(0); wb.clickSlot('bench', 0); // buy copy #3 -> bench, lvl1
    wb.clickStash(0); wb.clickSlot('bench', 0); // equip cleaver onto the bench copy
    check('merge: item equipped pre-merge', S.bench[0].item === 'cleaver');
    wb.clickSlot('bench', 0); wb.clickSlot('line', 0); // merge bench copy onto lineup (lvl2->lvl3)
    check('merge: lvl3 after 3rd copy', S.lineup[0].lvl === 3);
    check('merge: item transferred to merged unit', S.lineup[0].item === 'cleaver');
    check('merge: bench slot emptied', S.bench[0] === null);
    win.close();
  }

  // 2. Bench units don't fight (lineup units do).
  {
    const { win, wb, K } = loadGame(2);
    _K = K;
    wb.startRun('warlord');
    wb.chooseNode(0, 0);           // real fight node -> shop phase with a scouted enemy
    const S = wb.state;
    wb.give(50);
    wb.setShop(['dragon', 'turtle', null]);
    wb.clickShop(0); wb.clickSlot('bench', 0); // dragon parked on the bench only
    wb.clickShop(1); wb.clickSlot('line', 0);  // turtle actually fielded
    check('bench: unit placed on bench, not lineup', S.bench[0] && S.bench[0].key === 'dragon' && !S.lineup.some((u) => u && u.key === 'dragon'));
    wb.fast(BATTLE_SPEED);
    await wb.runBattle();
    const foughtKeys = wb.battle.P.map((f) => f.key);
    check('bench: fielded unit entered the battle roster', foughtKeys.includes('turtle'));
    check('bench: benched unit never entered the battle roster', !foughtKeys.includes('dragon'));
    check('bench: benched unit still on the bench post-battle', S.bench[0] && S.bench[0].key === 'dragon');
    win.close();
  }

  // 3. Interest math: startShop() gold formula for a range of banked amounts.
  {
    const { win, wb, K } = loadGame(3);
    _K = K;
    wb.startRun('tact');
    wb.chooseNode(0, 0);           // enter a real fight node so the shop has a scouted enemy
    const S = wb.state;
    for (const saved of [0, 2, 3, 5, 6, 9, 12, 30]) {
      S.saved = saved;
      S.bonusGold = 0;
      wb.startShop();
      const interest = Math.min(3, Math.floor(saved / 3));
      const expect = Math.min(12, 10 + interest); // GOLD_CAP=12, no meta gold bonus, no event bonus in this probe
      check(`interest: saved=${saved} -> gold=${expect}`, S.gold === expect);
    }
    win.close();
  }

  // 4. Warlord retry consumes lives and re-preps the same fight.
  {
    const { win, wb, K } = loadGame(4);
    _K = K;
    wb.startRun('necro');
    const S = wb.state;
    S.pos = { l: K.MAP_LAYERS - 1, i: 0 };
    const node = S.map[S.pos.l][S.pos.i];
    node.visited = true;
    node.enemy = wb.genEnemy(12, { count: 5, minLvl: 2, itemChance: 0.6 });
    node.name = 'The Warlord';
    S.enemy = node.enemy;
    S.patronChosen = true;         // skip the patron fork so startShop lands in 'shop'
    wb.startShop();
    S.lineup = [null, null, null, null, null]; // force an unwinnable fight (no fielded units)
    S.bench = [null, null, null];
    const livesBefore = S.lives;
    wb.fast(BATTLE_SPEED);
    await wb.runBattle();
    check('warlord retry: lives consumed on loss', S.lives === livesBefore - 2); // depth 10 > 5 -> cost 2
    check('warlord retry: back in shop, not bounced to map/over', S.phase === 'shop');
    check('warlord retry: still positioned at the boss node', S.pos.l === K.MAP_LAYERS - 1);
    win.close();
  }

  // 5. Event choices apply real state changes.
  {
    const { win, wb, K } = loadGame(5);
    _K = K;
    wb.startRun('tact');
    const S = wb.state;
    // gold
    S.phase = 'event'; S.eventUnit = 'rat'; S.bonusGold = 0;
    wb.pickEvent('gold');
    check('event: +4 gold applied', S.bonusGold === 4 && S.phase === 'map');
    // life
    S.phase = 'event'; S.eventUnit = 'rat'; S.lives = K.START_LIVES - 2;
    wb.pickEvent('life');
    check('event: heal applied', S.lives === K.START_LIVES - 1 && S.phase === 'map');
    // free recruit
    S.phase = 'event'; S.eventUnit = 'mage'; S.bench = [null, null, null];
    wb.pickEvent('unit');
    check('event: free recruit applied', S.bench[0] && S.bench[0].key === 'mage' && S.phase === 'map');
    win.close();
  }

  if (fails.length) {
    console.log(`\n${fails.length} mechanics check(s) FAILED:`, fails.join('; '));
    process.exitCode = 1;
  } else {
    console.log('\nAll mechanics checks passed.');
  }
}

// -------------------------------------------------------------- reporting --
function bracket(depth) {
  if (depth <= 3) return 'L1-3';
  if (depth <= 6) return 'L4-6';
  if (depth <= 9) return 'L7-9';
  return 'L10(boss)';
}
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function summarize(label, results) {
  const n = results.length;
  const wins = results.filter((r) => r.won).length;
  const softlocks = results.filter((r) => r.softlock).length;
  const errCount = results.reduce((s, r) => s + r.errors.length, 0);
  const deathsByBracket = { 'L1-3': 0, 'L4-6': 0, 'L7-9': 0, 'L10(boss)': 0 };
  const livesLostByBracket = { 'L1-3': 0, 'L4-6': 0, 'L7-9': 0, 'L10(boss)': 0 };
  for (const r of results) {
    if (!r.won && !r.softlock) deathsByBracket[bracket(r.depthReached)]++;
    for (const p of r.path) {
      if (p.result === 'lose') livesLostByBracket[bracket(p.depth)]++;
    }
  }
  console.log(`\n=== ${label} (n=${n}) ===`);
  console.log(`win rate:            ${wins}/${n} (${(100 * wins / n).toFixed(0)}%)`);
  console.log(`avg depth reached:   ${avg(results.map((r) => r.depthReached)).toFixed(2)} / 10`);
  console.log(`avg battle wins:     ${avg(results.map((r) => r.wins)).toFixed(2)}`);
  console.log(`deaths by depth:     ${Object.entries(deathsByBracket).map(([k, v]) => `${k}:${v}`).join(' ')}`);
  console.log(`lives lost by depth: ${Object.entries(livesLostByBracket).map(([k, v]) => `${k}:${v}`).join(' ')}`);
  console.log(`softlocks:           ${softlocks}`);
  console.log(`console errors:      ${errCount}`);
  if (errCount) {
    const seen = new Set();
    for (const r of results) for (const e of r.errors) {
      const k = String(e).slice(0, 160);
      if (!seen.has(k)) { seen.add(k); console.log('  err: ' + k); }
    }
  }
  return {
    label, n, wins, winRate: wins / n,
    avgDepth: avg(results.map((r) => r.depthReached)),
    deathsByBracket, livesLostByBracket, softlocks, errors: errCount,
  };
}

// --------------------------------------------------------------- driver ---
const COMMANDERS = ['necro', 'tact', 'warlord'];

async function runBatch(mode, count, baseSeed) {
  const results = [];
  for (let i = 0; i < count; i++) {
    const commander = COMMANDERS[i % COMMANDERS.length];
    const seed = baseSeed + i;
    // eslint-disable-next-line no-await-in-loop
    const r = await playRunAsync(mode, commander, seed);
    if (r.errors.length) console.log(`  [errors] ${mode}/${commander} seed=${seed}:`, r.errors.slice(0, 3));
    results.push(r);
    process.stdout.write(`\r${mode}: ${i + 1}/${count} runs`);
  }
  process.stdout.write('\n');
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--mechanics') {
    await runMechanicsChecks();
    return;
  }
  const N = +(args[0] || 30);
  const BASE_SEED = +(args[1] || 5000);
  const t0 = Date.now();

  console.log(`Running ${N} THOUGHTFUL runs (seeds ${BASE_SEED}-${BASE_SEED + N - 1})...`);
  const thoughtful = await runBatch('thoughtful', N, BASE_SEED);
  console.log(`Running ${N} GREEDY runs (seeds ${BASE_SEED + 1000}-${BASE_SEED + 1000 + N - 1})...`);
  const greedy = await runBatch('greedy', N, BASE_SEED + 1000);

  const sT = summarize('THOUGHTFUL', thoughtful);
  const sG = summarize('GREEDY', greedy);

  console.log(`\nseparation: thoughtful ${(100 * sT.winRate).toFixed(0)}% vs greedy ${(100 * sG.winRate).toFixed(0)}%` +
    ` (ratio ${sG.winRate > 0 ? (sT.winRate / sG.winRate).toFixed(2) : 'inf'}x)`);
  console.log(`total wall time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('RESULT_JSON:' + JSON.stringify({ thoughtful: sT, greedy: sG }));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
