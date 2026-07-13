'use strict';
/**
 * Dungeon Deal balance simulation harness.
 *
 * Loads the single-file game (games/dungeondeal.html) into jsdom and drives
 * the REAL game through its real DOM listeners: every action is a dispatched
 * MouseEvent click on #board .card/.slot elements, statusbar spell chips, and
 * overlay buttons (perk/boon/event/merchant/start). No game logic is
 * reimplemented — combat/loot resolution runs through the page's own
 * resolveCard/castOnCell/buyOffer/choosePerk/chooseBoon handlers. Policy-side
 * evaluation reuses the game's own exposed math (predictedDamage, calcFight,
 * trapDamage — top-level function declarations of the classic <script>, so
 * they live on window) and reads state via the game's window.DD handle.
 *
 * Input lock handling: the game locks input via a Date.now()-based timestamp
 * (S.lockUntil) and schedules everything else with setTimeout. The harness
 * installs a virtual clock (window.Date.now) plus a virtual timer queue
 * (window.setTimeout/clearTimeout) and fast-forwards between actions, so the
 * real unlock/animation/overlay paths all run, just instantly.
 *
 * Policies:
 *   greedy   - always takes the best-value adjacent card: potions when hurt,
 *              else better weapons, else the weakest survivable monster, else
 *              loot. Casts Fireball at the biggest monster the moment it has
 *              one, arms Freeze before any damaging fight, never uses Swap,
 *              picks random perks/boons, only buys healing at merchants.
 *   tactical - adds positioning (center cells preferred over corners), saves
 *              Fireball for elites/bosses, arms Freeze for big hits only,
 *              uses Swap to pull a potion adjacent when low, banks keys for
 *              locked chests, buys weapons/potions/shields at merchants, and
 *              picks defensive perks/boons when HP-poor.
 *
 * Both policies never take a predictably lethal card while an alternative
 * exists, and walk toward the best remaining target across empty slots when
 * nothing adjacent is worth taking (the game spawns stairs behind a walking
 * hero once the deck is empty and the floor's monsters are dead).
 *
 * Runs are seeded (Math.random is replaced per run with mulberry32), so
 * `node sims/dungeondeal-sim.js` is fully reproducible. Aggregates only.
 *
 * Usage: node sims/dungeondeal-sim.js [runsPerPolicy=40] [baseSeed=1000]
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');

const HTML_PATH = process.env.DD_HTML ||
  path.join(__dirname, '..', 'games', 'dungeondeal.html');
const HTML = fs.readFileSync(HTML_PATH, 'utf8');

// ---------------------------------------------------------------- loader ---
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
  if (!win.DD) throw new Error('window.DD handle not found after load');

  // Deterministic RNG per run.
  win.Math.random = mulberry32(seed);

  // Virtual clock + timer queue. The game's input lock compares Date.now()
  // to S.lockUntil; consume animations, event/merchant overlays, the death
  // panel and mini-boss stairs all arrive via setTimeout. Fast-forwarding
  // this clock runs the game's real unlock/spawn paths instantly.
  let vnow = 1e12;
  let tid = 1;
  const timers = new Map();
  win.Date.now = () => vnow;
  win.setTimeout = (fn, ms = 0, ...args) => {
    const id = tid++;
    timers.set(id, { t: vnow + Math.max(0, +ms || 0), fn, args });
    return id;
  };
  win.clearTimeout = (id) => { timers.delete(id); };

  function flush(ms) {
    vnow += ms;
    for (let i = 0; i < 5000; i++) {
      let bestId = null, bestT = Infinity;
      for (const [id, tm] of timers) {
        if (tm.t <= vnow && tm.t < bestT) { bestT = tm.t; bestId = id; }
      }
      if (bestId === null) break;
      const tm = timers.get(bestId);
      timers.delete(bestId);
      try { tm.fn(...tm.args); }
      catch (e) { errors.push('timer callback: ' + (e && e.stack)); }
    }
    // Float-text nodes are removed on animationend, which never fires in
    // jsdom — prune them so long runs don't drown the DOM.
    win.document.querySelectorAll('#board .float').forEach((el) => el.remove());
  }

  return { dom, win, flush, errors };
}

function click(win, el) {
  assert.ok(el, 'expected clickable element');
  el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
}

function prepareTransitionCard(ctx, type) {
  const { win } = ctx;
  win.clearBoardEls();
  win.DD.state.lockUntil = 0;
  win.spawnSpecialAt(1, { type }, 0);
  return win.document.querySelector('#board .card[data-cell="1"]');
}

function prepareBoss(ctx, hitsLeft = 2) {
  const { win } = ctx;
  win.clearBoardEls();
  win.DD.state.lockUntil = 0;
  win.DD.state.deck.length = 0;
  const boss = win.makeBoss(5);
  boss.hitsLeft = hitsLeft;
  win.spawnSpecialAt(1, boss, 0);
  return { boss, card: cardEl(win.document, 1) };
}

function castSpellAt(ctx, spell, card) {
  const { win } = ctx;
  win.DD.debug.give(spell);
  win.DD.state.lockUntil = 0;
  click(win, win.document.querySelector('.spell-chip'));
  assert.equal(card.classList.contains('target'), true, `${spell} should target the boss`);
  click(win, card);
}

function runMechanicsTests() {
  let count = 0;
  const test = (name, fn) => {
    fn();
    count++;
    console.log(`ok ${count} - ${name}`);
  };

  test('stale end panel cannot replace the title screen', () => {
    const ctx = loadGame(5001);
    const { win, flush, errors } = ctx;
    click(win, win.document.querySelector('#btn-start'));
    flush(4000);
    const card = prepareTransitionCard(ctx, 'monster');
    win.DD.state.hp = 1;
    win.DD.state.weapon = null;
    win.DD.state.shield = null;
    win.DD.state.board[1].v = 99;
    click(win, card);
    assert.equal(win.DD.state.screen, 'dead', 'lethal card should end the run');
    win.showTitle();
    const titleMarkup = win.document.querySelector('#overlay').innerHTML;
    flush(1000);
    assert.equal(win.DD.state.screen, 'title');
    assert.equal(win.document.querySelector('#overlay').innerHTML, titleMarkup);
    assert.match(titleMarkup, /DUNGEON DEAL/);
    assert.deepEqual(errors, []);
    win.close();
  });

  for (const [type, screen, delay] of [
    ['event', 'event', 320],
    ['merchant', 'merchant', 320],
    ['stairs', 'perk', 360],
  ]) {
    test(`stale ${type} transition cannot replace a new run`, () => {
      const ctx = loadGame(5100 + count);
      const { win, flush, errors } = ctx;
      click(win, win.document.querySelector('#btn-start'));
      flush(4000);
      click(win, prepareTransitionCard(ctx, type));
      win.newRun();
      flush(delay + 100);
      assert.equal(win.DD.state.screen, 'play');
      assert.equal(win.document.querySelector('#overlay').classList.contains('show'), false);
      assert.deepEqual(errors, []);
      win.close();
    });

    test(`${type} transition still fires in its original lifecycle`, () => {
      const ctx = loadGame(5200 + count);
      const { win, flush, errors } = ctx;
      click(win, win.document.querySelector('#btn-start'));
      flush(4000);
      click(win, prepareTransitionCard(ctx, type));
      flush(delay + 100);
      assert.equal(win.DD.state.screen, screen);
      assert.equal(win.document.querySelector('#overlay').classList.contains('show'), true);
      assert.deepEqual(errors, []);
      win.close();
    });
  }

  test('normal boss attack retains its per-hit XP and stage progress', () => {
    const ctx = loadGame(5301);
    const { win, errors } = ctx;
    click(win, win.document.querySelector('#btn-start'));
    win.DD.state.hp = 100;
    win.DD.state.maxHp = 100;
    const { boss, card } = prepareBoss(ctx);
    click(win, card);
    assert.equal(win.DD.state.xp, 2);
    assert.equal(boss.si, 0);
    assert.equal(boss.hitsLeft, 1);
    assert.deepEqual(errors, []);
    win.close();
  });

  test('Fireball retains full XP when it clears a mini-boss', () => {
    const ctx = loadGame(5302);
    const { win, errors } = ctx;
    click(win, win.document.querySelector('#btn-start'));
    const { boss, card } = prepareBoss(ctx);
    castSpellAt(ctx, 'fire', card);
    assert.equal(win.DD.state.xp, 10);
    assert.equal(boss.si, 1);
    assert.equal(win.DD.state.stats.slain, 1);
    assert.deepEqual(errors, []);
    win.close();
  });

  test('Bomb removes a nonfinal boss hit without awarding XP', () => {
    const ctx = loadGame(5303);
    const { win, errors } = ctx;
    click(win, win.document.querySelector('#btn-start'));
    const { boss, card } = prepareBoss(ctx);
    castSpellAt(ctx, 'bomb', card);
    assert.equal(win.DD.state.xp, 0);
    assert.equal(boss.si, 0);
    assert.equal(boss.hitsLeft, 1);
    assert.equal(win.DD.state.board[1], boss);
    assert.deepEqual(errors, []);
    win.close();
  });

  test('Bomb awards no XP for a final mini-boss hit and preserves other rewards', () => {
    const ctx = loadGame(5304);
    const { win, flush, errors } = ctx;
    click(win, win.document.querySelector('#btn-start'));
    const goldBefore = win.DD.state.gold;
    const relicsBefore = Object.keys(win.DD.state.relics).length;
    const { boss, card } = prepareBoss(ctx, 1);
    castSpellAt(ctx, 'bomb', card);
    flush(500);
    assert.equal(win.DD.state.xp, 0);
    assert.equal(boss.si, 1);
    assert.equal(win.DD.state.stats.slain, 1);
    assert.equal(win.DD.state.gold, goldBefore + 10);
    assert.equal(Object.keys(win.DD.state.relics).length, relicsBefore + 1);
    assert.equal(win.DD.state.board[1].type, 'stairs');
    assert.deepEqual(errors, []);
    win.close();
  });

  console.log(`Dungeon Deal mechanics: ${count} passed`);
}

// ---------------------------------------------------------- policy logic ---
const CENTER = new Set([5, 6, 9, 10]);
const CORNERS = new Set([0, 3, 12, 15]);
const colOf = (c) => c % 4;
const rowOf = (c) => c >> 2;
const manhattan = (a, b) => Math.abs(colOf(a) - colOf(b)) + Math.abs(rowOf(a) - rowOf(b));

function boardCards(S) {
  const out = [];
  S.board.forEach((c, cell) => { if (c) out.push({ cell, c }); });
  return out;
}

function cardEl(doc, cell) {
  return [...doc.querySelectorAll('#board .card')].find(
    (el) => +el.dataset.cell === cell && !el.classList.contains('hero'));
}

// Score a candidate cell. -Infinity marks "never unless forced" (lethal).
function cardScore(win, S, c, cell, policy) {
  const tact = policy === 'tactical';
  const hurt = S.maxHp - S.hp;
  const center = tact ? (CENTER.has(cell) ? 1.5 : (CORNERS.has(cell) ? -1 : 0)) : 0;
  if (!c) return 0.2 + center * 0.1; // plain step onto an empty slot

  switch (c.type) {
    case 'potion': {
      const amt = c.v + (S.perks.alch || 0) * 2;
      const heal = Math.min(amt, hurt);
      if (tact) return (S.hp < S.maxHp * 0.5 ? 70 + heal : (hurt >= amt ? 40 + heal : 6)) + center;
      return (hurt >= amt ? 60 + heal : (hurt > 0 ? 8 + heal : 1)) + center;
    }
    case 'weapon': {
      const nv = c.v + (S.perks.whet || 0) + (S.relics.stone ? 1 : 0);
      const cur = S.weapon ? S.weapon.v : 0;
      const d = nv - cur;
      return (d > 0 ? 45 + d * 3 : 1) + center;
    }
    case 'shield':
      return (S.shield ? (c.block > S.shield.block ? 12 : 1) : 35) + center;
    case 'coin': {
      const g = (c.v + (S.relics.clover ? 2 : 0)) * Math.pow(2, S.perks.greed || 0);
      return 20 + g * 0.5 + center;
    }
    case 'gem': return 20 + c.v * 0.5 + center;
    case 'chest': return (tact && S.hp <= 4 ? -25 : 21) + center; // mimic risk when nearly dead
    case 'key': return 24 + center;
    case 'locked': return S.keys > 0 ? 55 + center : -Infinity; // unreachable without a key anyway
    case 'spell': return (S.spells.length < 2 ? 30 : 12) + center;
    case 'stairs': return NaN; // scored by caller (needs whole-board context)
    case 'monster': case 'elite': case 'boss': {
      const dmg = win.predictedDamage(c);
      if (dmg >= S.hp && S.windLeft <= 0) return -Infinity;
      if (c.type === 'boss') return 50 - dmg * 2 + center;
      const w = tact ? 6 : 4;
      let s = 28 + c.v - dmg * w + (c.type === 'elite' ? 10 : 0);
      if (S.deck.length === 0) s += 20; // monsters must die before stairs appear
      if (tact && dmg > S.hp * 0.4 && S.hp < S.maxHp * 0.7) s -= 15;
      return s + center;
    }
    case 'trap': {
      if (S.kits > 0) return 15 + center;
      const d = win.trapDamage(c.v);
      if (d >= S.hp && S.windLeft <= 0) return -Infinity;
      return d === 0 ? 15 + center : -20 - d * 8 + center;
    }
    case 'curse': return (S.weapon ? -15 : -8) + center;
    case 'event': return 18 + center;    // shrine/fountain/imp — net positive on average
    case 'bloodgold': {
      const d = win.predictedDamage(c);
      if (d >= S.hp && S.windLeft <= 0) return -Infinity;
      return 20 + c.v * 0.5 - d * 3 + center;
    }
    case 'anvil': return (S.weapon ? (S.weapon.v >= 8 ? 18 : 2) : 0.5) + center;
    case 'merchant': return 16 + center; // browse offers (both policies at least heal)
  }
  return 0;
}

function stairsScore(win, S, policy) {
  // Descend once nothing valuable is left to loot on this floor.
  const anyGood = boardCards(S).some(({ c, cell }) =>
    c.type !== 'stairs' && cardScore(win, S, c, cell, policy) >= 12);
  return anyGood ? 2 : 100;
}

// One spell decision per play step; returns true if it acted.
function trySpells(ctx, policy) {
  const { win, flush } = ctx;
  const doc = win.document;
  const S = win.DD.state;
  if (!S.spells.length) return false;

  const chipFor = (sp) => {
    const i = S.spells.indexOf(sp);
    return i >= 0 ? doc.querySelector(`.spell-chip[data-spell-i="${i}"]`) : null;
  };
  const monsters = boardCards(S).filter(({ c }) =>
    c.type === 'monster' || c.type === 'elite' || c.type === 'boss');
  const adjacentTo = (cell) => manhattan(cell, S.heroCell) === 1;

  // ---- Fireball ----
  if (S.spells.includes('fire') && monsters.length) {
    let target = null;
    if (policy === 'greedy') {
      // burn the biggest thing on the board, right now
      target = monsters.reduce((b, m) => {
        const val = (x) => x.c.type === 'boss' ? 100 : (x.c.type === 'elite' ? 50 + x.c.v : x.c.v);
        return val(m) > val(b) ? m : b;
      });
    } else {
      // save it: boss stage always, elite when it would hurt, or emergency
      const boss = monsters.find((m) => m.c.type === 'boss');
      const elite = monsters.find((m) => m.c.type === 'elite');
      if (boss) target = boss;
      else if (elite && (win.predictedDamage(elite.c) >= 4 || S.hp < S.maxHp * 0.5)) target = elite;
      else {
        // emergency: a lethal monster is adjacent and everything else is bad
        const lethalAdj = monsters.find((m) => adjacentTo(m.cell) &&
          win.predictedDamage(m.c) >= S.hp && S.windLeft <= 0);
        if (lethalAdj && S.hp < S.maxHp * 0.4) target = lethalAdj;
      }
    }
    if (target) {
      const chip = chipFor('fire');
      if (chip) {
        click(win, chip);
        flush(100);
        const tEl = cardEl(doc, target.cell);
        if (tEl && tEl.classList.contains('target')) {
          click(win, tEl);
          flush(1200);
          return true;
        }
        // couldn't target — cancel out
        const cancel = doc.querySelector('#cancel-target');
        if (cancel) { click(win, cancel); flush(300); }
      }
    }
  }

  // ---- Bomb (a weaker fireball: no XP/loot) ----
  if (S.spells.includes('bomb') && monsters.length) {
    const target = monsters.reduce((b, m) => {
      const val = (x) => x.c.type === 'boss' ? 100 : win.predictedDamage(x.c);
      return val(m) > val(b) ? m : b;
    });
    const worth = target.c.type === 'boss' || win.predictedDamage(target.c) >= (policy === 'tactical' ? 5 : 4);
    if (worth) {
      const chip = chipFor('bomb');
      if (chip) {
        click(win, chip);
        flush(100);
        const tEl = cardEl(doc, target.cell);
        if (tEl && tEl.classList.contains('target')) {
          click(win, tEl);
          flush(1200);
          return true;
        }
        const cancel = doc.querySelector('#cancel-target');
        if (cancel) { click(win, cancel); flush(300); }
      }
    }
  }

  // ---- Freeze ----
  if (S.spells.includes('freeze') && !S.freeze) {
    const adjFights = monsters.filter((m) => adjacentTo(m.cell));
    let arm = false;
    if (policy === 'greedy') {
      arm = adjFights.some((m) => win.predictedDamage(m.c) > 0);
    } else {
      arm = adjFights.some((m) => {
        const d = win.predictedDamage(m.c);
        if (d <= 0) return false;
        if (m.c.type === 'boss' || m.c.type === 'elite') return true;
        return d >= S.hp * 0.5;
      });
    }
    if (arm) {
      const chip = chipFor('freeze');
      if (chip) { click(win, chip); flush(500); return true; }
    }
  }

  // ---- Swap (tactical only): pull a potion next to the hero when low ----
  if (policy === 'tactical' && S.spells.includes('swap') && S.hp < S.maxHp * 0.4) {
    const potions = boardCards(S).filter(({ c }) => c.type === 'potion');
    const adjPotion = potions.some((p) => adjacentTo(p.cell));
    if (potions.length && !adjPotion) {
      // swap the nearest potion with the least valuable adjacent card
      const potion = potions.reduce((b, p) =>
        manhattan(p.cell, S.heroCell) < manhattan(b.cell, S.heroCell) ? p : b);
      const adjCards = boardCards(S).filter(({ c, cell }) =>
        adjacentTo(cell) && c.type !== 'potion' && c.type !== 'boss');
      if (adjCards.length) {
        const victim = adjCards.reduce((b, a) =>
          cardScore(win, S, a.c, a.cell, policy) < cardScore(win, S, b.c, b.cell, policy) ? a : b);
        const chip = chipFor('swap');
        if (chip) {
          click(win, chip);
          flush(100);
          const pEl = cardEl(doc, potion.cell);
          if (pEl && pEl.classList.contains('target')) {
            click(win, pEl);
            flush(100);
            const vEl = cardEl(doc, victim.cell);
            if (vEl && vEl.classList.contains('target')) {
              click(win, vEl);
              flush(800);
              return true;
            }
          }
          const cancel = doc.querySelector('#cancel-target');
          if (cancel) { click(win, cancel); flush(300); }
        }
      }
    }
  }
  return false;
}

function playStep(ctx, policy, rs) {
  const { win, flush } = ctx;
  const doc = win.document;
  const S = win.DD.state;

  // Stray targeting mode (shouldn't persist) — cancel it.
  if (S.targeting) {
    const cancel = doc.querySelector('#cancel-target');
    if (cancel) click(win, cancel);
    flush(600);
    return;
  }

  if (trySpells(ctx, policy)) return;

  const els = [...doc.querySelectorAll('#board .card.reachable, #board .slot.reachable')];
  if (!els.length) { rs.idle++; flush(1500); return; }
  rs.idle = 0;

  const cands = els.map((el) => ({ el, cell: +el.dataset.cell, c: S.board[+el.dataset.cell] }));
  let best = null, bestScore = -Infinity;
  for (const cd of cands) {
    const s = (cd.c && cd.c.type === 'stairs')
      ? stairsScore(win, S, policy)
      : cardScore(win, S, cd.c, cd.cell, policy);
    if (s > bestScore) { bestScore = s; best = cd; }
  }

  // Nothing worthwhile adjacent: walk across empty slots toward the best
  // remaining target anywhere on the board (or let stairs spawn behind us).
  if (bestScore < 3) {
    let goal = null, goalScore = 3;
    for (const { c, cell } of boardCards(S)) {
      const s = c.type === 'stairs'
        ? stairsScore(win, S, policy)
        : cardScore(win, S, c, cell, policy);
      if (s > goalScore) { goalScore = s; goal = cell; }
    }
    const slots = cands.filter((cd) => !cd.c);
    if (slots.length) {
      if (goal != null) {
        slots.sort((a, b) =>
          (manhattan(a.cell, goal) - manhattan(b.cell, goal)) ||
          ((a.cell === rs.prevCell) - (b.cell === rs.prevCell)));
      } else {
        slots.sort((a, b) => (a.cell === rs.prevCell) - (b.cell === rs.prevCell));
      }
      best = slots[0];
      bestScore = 3;
    }
  }

  // Forced pick: everything adjacent is lethal/awful and there is nowhere to
  // walk — or we've been pacing empty slots without progress (the remaining
  // targets are walled off behind "bad" cards). Chew through the least
  // damaging adjacent CARD (Second Wind may save us).
  if (!best || bestScore === -Infinity || rs.stuck > 30) {
    let f = null, fd = Infinity;
    for (const cd of cands) {
      if (!cd.c) continue; // cards only — walking got us stuck in the first place
      if (cd.c.type === 'locked' && S.keys < 1) continue;
      const d = win.predictedDamage(cd.c);
      const lethal = d >= S.hp && S.windLeft <= 0;
      const dd = d + (lethal ? 1000 : 0); // avoid lethal unless it's all there is
      if (dd < fd) { fd = dd; f = cd; }
    }
    if (f) best = f;
  }
  if (!best) { rs.idle++; flush(1500); return; }

  rs.stuck = best.c ? 0 : rs.stuck + 1;
  rs.prevCell = S.heroCell;
  if (best.c) rs.lastHazard = best.c.type;
  click(win, best.el);
  flush(2000);
}

// ------------------------------------------------------- overlay handlers ---
function handlePerk(ctx, policy) {
  const { win, flush } = ctx;
  const S = win.DD.state;
  const els = [...win.document.querySelectorAll('.perk-choice')];
  if (!els.length) { flush(500); return; }
  const keys = els.map((el) => el.dataset.perk);
  let pickKey;
  if (policy === 'tactical') {
    const low = S.hp < S.maxHp * 0.55;
    const pref = low
      ? ['vit', 'wind', 'skin', 'alch', 'bulw', 'whet', 'greed']
      : ['whet', 'skin', 'wind', 'bulw', 'vit', 'alch', 'greed'];
    pickKey = pref.find((k) => keys.includes(k)) || keys[0];
  } else {
    pickKey = keys[Math.floor(win.Math.random() * keys.length)];
  }
  click(win, els[keys.indexOf(pickKey)]);
  flush(3000); // covers the next floor's deal-in lock
}

function handleLevel(ctx, policy) {
  const { win, flush } = ctx;
  const S = win.DD.state;
  const els = [...win.document.querySelectorAll('.boon-choice')];
  if (!els.length) { flush(500); return; }
  const keys = els.map((el) => el.dataset.boon);
  let pickKey;
  if (policy === 'tactical') {
    if (S.hp <= S.maxHp * 0.45 && keys.includes('mend')) pickKey = 'mend';
    else if (!S.shield && keys.includes('guard')) pickKey = 'guard';
    else if ((!S.weapon || S.weapon.v < 4) && keys.includes('hone')) pickKey = 'hone';
    else pickKey = ['hone', 'guard', 'tools', 'scroll', 'gild', 'mend']
      .find((k) => keys.includes(k)) || keys[0];
  } else {
    pickKey = keys[Math.floor(win.Math.random() * keys.length)];
  }
  click(win, els[keys.indexOf(pickKey)]);
  flush(1000);
}

function handleEvent(ctx, policy) {
  const { win, flush } = ctx;
  const doc = win.document;
  const S = win.DD.state;
  const btn = (ev) => doc.querySelector(`[data-ev="${ev}"]`);
  let target = null;
  if (S.eventKind === 'shrine') {
    const threshold = policy === 'tactical' ? 9 : 5;
    const pray = btn('pray');
    target = (S.hp >= threshold && pray && !pray.classList.contains('disabled'))
      ? pray : btn('leave');
  } else if (S.eventKind === 'fountain') {
    target = S.hp < S.maxHp ? btn('drink') : btn('leave');
  } else { // imp
    const pay = btn('pay');
    target = (S.gold >= 4 && pay && !pay.classList.contains('disabled'))
      ? pay : btn('refuse');
  }
  if (!target) target = doc.querySelector('.panel .btn'); // failsafe
  if (target) click(win, target);
  flush(1000);
}

function handleMerchant(ctx, policy) {
  const { win, flush } = ctx;
  const doc = win.document;
  const S = win.DD.state;

  const tryBuy = (pred) => {
    const i = S.merchOffers.findIndex((o) => !o.sold && S.gold >= o.price && pred(o));
    if (i < 0) return false;
    const el = doc.querySelector(`[data-buy="${i}"]`);
    if (!el) return false;
    click(win, el); // buyOffer re-renders the panel; re-query next time
    flush(200);
    return true;
  };

  if (policy === 'tactical') {
    for (let guard = 0; guard < 8; guard++) {
      const bought =
        tryBuy((o) => (o.id === 'weapon' || o.id === 'gsword') &&
          (o.v + (S.perks.whet || 0) + (S.relics.stone ? 1 : 0)) > (S.weapon ? S.weapon.v : 0) + 1) ||
        tryBuy((o) => o.id === 'bigheal' && S.hp <= S.maxHp - 12) ||
        tryBuy((o) => o.id === 'heal' && S.hp <= S.maxHp - 6) ||
        tryBuy((o) => (o.id === 'shield' || o.id === 'aegis') && !S.shield) ||
        tryBuy((o) => o.id === 'key' && S.keys === 0 &&
          boardCards(S).some(({ c }) => c.type === 'locked')) ||
        tryBuy((o) => o.id === 'amulet' && S.gold >= o.price + 6) ||
        tryBuy((o) => o.id === 'kit' && S.kits === 0 && S.gold >= o.price + 6) ||
        tryBuy((o) => o.id === 'spell' && S.spells.length < 2 && S.gold >= o.price + 8);
      if (!bought) break;
    }
  } else {
    // greedy: heals up if hurt, otherwise walks out
    for (let guard = 0; guard < 4; guard++) {
      if (!tryBuy((o) => o.id === 'heal' && S.hp <= S.maxHp - 6)) break;
    }
  }
  const leave = doc.querySelector('#btn-leave');
  if (leave) click(win, leave);
  flush(1000);
}

// -------------------------------------------------------------- run driver --
function causeOf(lastHazard) {
  if (lastHazard === 'monster' || lastHazard === 'elite' || lastHazard === 'boss') return 'monster';
  if (lastHazard === 'trap') return 'trap';
  if (lastHazard === 'chest') return 'mimic';
  return 'other';
}

function playRun(policy, seed) {
  const ctx = loadGame(seed);
  const { win, flush, errors } = ctx;
  const doc = win.document;

  click(win, doc.querySelector('#btn-start'));
  flush(4000);

  const rs = { idle: 0, stuck: 0, prevCell: null, lastHazard: null, steps: 0 };
  let softlock = false;

  while (rs.steps++ < 4000) {
    flush(2500);
    const S = win.DD.state;
    if (S.screen === 'dead' || S.screen === 'victory') break;
    if (S.screen === 'play') playStep(ctx, policy, rs);
    else if (S.screen === 'perk') handlePerk(ctx, policy);
    else if (S.screen === 'level') handleLevel(ctx, policy);
    else if (S.screen === 'event') handleEvent(ctx, policy);
    else if (S.screen === 'merchant') handleMerchant(ctx, policy);
    else flush(1500);
    if (rs.idle > 12) { softlock = true; break; }
  }
  if (rs.steps >= 4000) softlock = true;

  if (softlock && process.env.DD_DEBUG) {
    const S = win.DD.state;
    const board = S.board.map((c, i) => c ? `${i}:${c.type}${c.v!=null?c.v:''}` : null).filter(Boolean);
    console.error(`\n[SOFTLOCK] ${policy} seed=${seed} floor=${S.floor} screen=${S.screen} hp=${S.hp}/${S.maxHp} heroCell=${S.heroCell} targeting=${JSON.stringify(S.targeting)} deck=${S.deck.length} keys=${S.keys} kits=${S.kits} weapon=${S.weapon?S.weapon.v:0} steps=${rs.steps} idle=${rs.idle} stuck=${rs.stuck}`);
    console.error(`  board: ${board.join(' ')}`);
    const reach = [...win.document.querySelectorAll('#board .card.reachable, #board .slot.reachable')].map(el=>el.dataset.cell);
    console.error(`  reachable cells: ${reach.join(',') || '(none)'}`);
  }

  flush(2000);
  const S = win.DD.state;
  const res = {
    policy, seed,
    won: S.screen === 'victory',
    floor: S.floor,
    lvl: S.lvl,
    gold: S.gold,
    cause: S.screen === 'dead' ? causeOf(rs.lastHazard) : null,
    softlock,
    steps: rs.steps,
    errors: errors.slice(),
  };
  win.close();
  return res;
}

// --------------------------------------------------------------- reporting --
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

function summarize(label, results) {
  const n = results.length;
  const wins = results.filter((r) => r.won).length;
  const deaths = results.filter((r) => !r.won);
  const causes = { monster: 0, trap: 0, mimic: 0, other: 0 };
  const deathFloors = {};
  for (const r of deaths) {
    causes[r.cause || 'other']++;
    deathFloors[r.floor] = (deathFloors[r.floor] || 0) + 1;
  }
  const softlocks = results.filter((r) => r.softlock).length;
  const errCount = results.reduce((s, r) => s + r.errors.length, 0);
  console.log(`\n=== ${label} (n=${n}) ===`);
  console.log(`win rate:            ${wins}/${n} (${(100 * wins / n).toFixed(0)}%)`);
  console.log(`median floor:        ${median(results.map((r) => r.floor))}`);
  console.log(`avg floor:           ${avg(results.map((r) => r.floor)).toFixed(2)}`);
  console.log(`avg level at end:    ${avg(results.map((r) => r.lvl)).toFixed(2)}`);
  console.log(`avg gold at end:     ${avg(results.map((r) => r.gold)).toFixed(1)}`);
  console.log(`deaths by cause:     monster ${causes.monster} · trap ${causes.trap} · mimic ${causes.mimic} · other ${causes.other}`);
  console.log(`deaths by floor:     ${Object.keys(deathFloors).sort((a, b) => a - b)
    .map((f) => `F${f}:${deathFloors[f]}`).join(' ') || '—'}`);
  console.log(`softlocks:           ${softlocks}`);
  console.log(`console errors:      ${errCount}`);
  if (errCount) {
    const seen = new Set();
    for (const r of results) for (const e of r.errors) {
      const k = String(e).slice(0, 120);
      if (!seen.has(k)) { seen.add(k); console.log('  err: ' + k); }
    }
  }
  return { label, n, wins, winRate: wins / n, medianFloor: median(results.map((r) => r.floor)),
    avgFloor: avg(results.map((r) => r.floor)), avgLvl: avg(results.map((r) => r.lvl)),
    avgGold: avg(results.map((r) => r.gold)), causes, deathFloors, softlocks, errors: errCount };
}

// --------------------------------------------------------------------- main --
(function main() {
  if (process.argv[2] === '--mechanics') {
    runMechanicsTests();
    return;
  }
  const N = +(process.argv[2] || 40);
  const BASE_SEED = +(process.argv[3] || 1000);
  const t0 = Date.now();

  const all = {};
  const policies = process.env.DD_ONLY ? process.env.DD_ONLY.split(',') : ['greedy', 'tactical'];
  for (const policy of policies) {
    const results = [];
    for (let i = 0; i < N; i++) {
      results.push(playRun(policy, BASE_SEED + i));
      process.stdout.write(`\r${policy}: ${i + 1}/${N} runs`);
    }
    process.stdout.write('\n');
    all[policy] = results;
  }

  const sums = {};
  for (const policy of Object.keys(all)) sums[policy] = summarize(policy.toUpperCase(), all[policy]);

  console.log(`\ntotal wall time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('RESULT_JSON:' + JSON.stringify(sums));
})();
