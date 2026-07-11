'use strict';
/*
 * Re-runnable balance simulation for games/depths.html.
 *
 * Loads the real game into jsdom and plays it through the actual input surface:
 *  - arrow-key keydown events  -> playerStep (move / melee attack, one real turn)
 *  - canvas mousedown events   -> HUD buttons, ranger bow shots, shop / level-up /
 *                                 inventory / target-mode clicks, descend (click self)
 * No game logic is reimplemented; the harness only decides WHERE to click.
 *
 * Policies:
 *  - reckless: beeline to stairs (amulet on depth 10), fights only what blocks the
 *              path, never uses potions/scrolls/flasks tactically, offensive boons.
 *  - careful:  clears items, retreats to corridors to fight one-at-a-time, drinks
 *              potions under 40% HP, uses scrolls/flasks, defensive boons, buys
 *              potions at shops.
 * Both policies equip strictly-better gear/rings (basic play, not tactics).
 * Alchemist's Transmute is not used by either policy (interactive reroll UI).
 *
 * Usage: node sims/depths-sim.js          (RUNS=<n> env var overrides runs/cell)
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const HTML_PATH = path.join(__dirname, '..', 'games', 'depths.html');
const HTML = fs.readFileSync(HTML_PATH, 'utf8');

const RUNS_PER_CELL = parseInt(process.env.RUNS || '22', 10); // 6 cells * 22 = 132 runs
const MAX_ACTS = 5000;      // hard cap on bot actions per run (softlock guard)
const MAX_RUN_MS = 20000;   // hard wall-clock cap per run (softlock guard)
const COLS = 40, ROWS = 30, HUD_H = 128;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const ARROW = { '1,0': 'ArrowRight', '-1,0': 'ArrowLeft', '0,1': 'ArrowDown', '0,-1': 'ArrowUp' };

// ---------------------------------------------------------------- loader ----
function makeFakeCtx() {
  const store = {};
  const gradient = { addColorStop: () => {} };
  return new Proxy({}, {
    get(t, prop) {
      if (prop in store) return store[prop];
      if (prop === 'measureText') return () => ({ width: 10 });
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient' ||
          prop === 'createPattern') return () => gradient;
      return () => {};
    },
    set(t, prop, v) { store[prop] = v; return true; },
  });
}

function loadGame() {
  const errors = [];
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously',
    url: 'http://localhost/',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.HTMLCanvasElement.prototype.getContext = function () { return makeFakeCtx(); };
      window.requestAnimationFrame = () => 0; // disable render loop; sim drives turns itself
      window.addEventListener('error', ev => errors.push((ev.error && ev.error.stack) || ev.message));
      window.addEventListener('unhandledrejection',
        ev => errors.push('unhandledrejection: ' + ((ev.reason && ev.reason.stack) || ev.reason)));
      const orig = window.console.error.bind(window.console);
      window.console.error = (...a) => { errors.push('console.error: ' + a.map(String).join(' ')); orig(...a); };
    },
  });
  const win = dom.window;
  if (!win.__D) throw new Error('window.__D not found after load');
  return { dom, win, D: win.__D, errors };
}

// ---------------------------------------------------------------- input -----
function clickAt(win, x, y) {
  win.document.getElementById('game').dispatchEvent(
    new win.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }));
}
function clickRect(win, r) { clickAt(win, r.x + r.w / 2, r.y + r.h / 2); }
function clickTile(win, D, tx, ty) {
  clickAt(win, D.offX + tx * D.tile + D.tile / 2, D.offY + ty * D.tile + D.tile / 2);
}
function pressKey(win, key) {
  win.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

// ---------------------------------------------------------------- helpers ---
const idx = (x, y) => y * COLS + x;
const inB = (x, y) => x >= 0 && y >= 0 && x < COLS && y < ROWS;
const manhattan = (ax, ay, bx, by) => Math.abs(ax - bx) + Math.abs(ay - by);
const cheby = (ax, ay, bx, by) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));

function lineCells(x0, y0, x1, y1) { // mirror of the game's Bresenham (for bow LOS)
  const cells = [];
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy, x = x0, y = y0;
  for (;;) {
    cells.push([x, y]);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
  return cells;
}
function losClear(S, ax, ay, bx, by) {
  const cells = lineCells(ax, ay, bx, by);
  for (let i = 1; i < cells.length - 1; i++)
    if (S.map[idx(cells[i][0], cells[i][1])] === 0) return false;
  return true;
}
function visMonsters(S) { return S.monsters.filter(m => S.vis[idx(m.x, m.y)]); }
function adjMonsters(S) { return S.monsters.filter(m => manhattan(m.x, m.y, S.px, S.py) === 1); }
function bowable(S, m) {
  const d = cheby(m.x, m.y, S.px, S.py);
  return d >= 2 && d <= 4 && S.vis[idx(m.x, m.y)] && losClear(S, m.x, m.y, S.px, S.py);
}
function floorNeighbors(S, x, y) {
  let n = 0;
  for (const [dx, dy] of DIRS) if (inB(x + dx, y + dy) && S.map[idx(x + dx, y + dy)] === 1) n++;
  return n;
}

// BFS distance/parent field from the player over floor tiles.
function bfsField(S, blockMonsters, avoidTraps) {
  const dist = new Int16Array(COLS * ROWS).fill(-1);
  const prev = new Int32Array(COLS * ROWS).fill(-1);
  const monsterOn = new Uint8Array(COLS * ROWS);
  for (const m of S.monsters) if (inB(m.x, m.y)) monsterOn[idx(m.x, m.y)] = 1;
  const trapOn = new Uint8Array(COLS * ROWS);
  if (avoidTraps) for (const t of S.traps) if (t.revealed && !t.sprung) trapOn[idx(t.x, t.y)] = 1;
  const keeperI = S.keeper ? idx(S.keeper.x, S.keeper.y) : -1;
  const q = [idx(S.px, S.py)];
  dist[q[0]] = 0;
  let head = 0;
  while (head < q.length) {
    const cur = q[head++];
    const cx = cur % COLS, cy = (cur - cx) / COLS;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (!inB(nx, ny)) continue;
      const ni = idx(nx, ny);
      if (dist[ni] !== -1 || S.map[ni] !== 1 || ni === keeperI) continue;
      if (trapOn[ni]) continue;
      dist[ni] = dist[cur] + 1;
      prev[ni] = cur;
      if (blockMonsters && monsterOn[ni]) continue; // reachable as endpoint, not traversable
      q.push(ni);
    }
  }
  return { dist, prev };
}
function firstStep(S, field, tx, ty) {
  let cur = idx(tx, ty);
  if (field.dist[cur] <= 0) return null;
  const start = idx(S.px, S.py);
  while (field.prev[cur] !== start && field.prev[cur] !== -1) cur = field.prev[cur];
  if (field.prev[cur] !== start) return null;
  return [cur % COLS, Math.floor(cur / COLS)];
}
// Step toward (tx,ty): prefer paths around monsters, fall back to through them
// (the arrow key onto a monster tile is a melee attack = "fight what blocks").
function stepToward(ctx, tx, ty) {
  const S = ctx.D.S;
  const avoid = ctx.policy === 'careful';
  let f = bfsField(S, true, avoid);
  let st = firstStep(S, f, tx, ty);
  if (!st) { f = bfsField(S, false, avoid); st = firstStep(S, f, tx, ty); }
  if (!st && avoid) { f = bfsField(S, false, false); st = firstStep(S, f, tx, ty); } // trap-gated path: brave it
  if (!st) return false;
  const key = ARROW[(st[0] - S.px) + ',' + (st[1] - S.py)];
  if (!key) return false;
  pressKey(ctx.win, key);
  return true;
}
function reachDist(S, tx, ty) { // distance ignoring monsters (structural reachability)
  const f = bfsField(S, false, false);
  return f.dist[idx(tx, ty)];
}

// -------------------------------------------------------------- UI actions --
const BOON_PREFS = {
  reckless: ['might', 'greed', 'vigor', 'focus', 'eagle', 'stone', 'ashen', 'antivenom'],
  careful: ['stone', 'vigor', 'antivenom', 'ashen', 'focus', 'might', 'eagle', 'greed'],
};
function pickBoon(ctx) {
  const { win, D } = ctx;
  const choices = D.S.boonChoices || [];
  let bi = 0;
  for (const p of BOON_PREFS[ctx.policy]) {
    const j = choices.indexOf(p);
    if (j >= 0) { bi = j; break; }
  }
  clickRect(win, D.levelL.rows[bi].rect);
}
function handleShop(ctx) {
  const { win, D } = ctx;
  const S = D.S;
  ctx.shopped = true;
  if (ctx.policy === 'careful') {
    let guard = 0;
    while (D.uiMode === 'shop' && guard++ < 12) {
      const L = D.shopL;
      if (!L) break;
      const wares = S.shopWares || [];
      let bought = false;
      for (const row of L.rows) {
        if (row.type !== 'ware') continue;
        const w = wares[row.i];
        if (w && w.kind === 'potion' && S.gold >= w.price) { clickRect(win, row.rect); bought = true; break; }
      }
      if (!bought) break;
    }
  }
  if (D.uiMode === 'shop' && D.shopL) clickRect(win, D.shopL.close);
}
function openInvAndUse(ctx, kind) {
  const { win, D } = ctx;
  clickRect(win, D.hud.inv);
  if (D.uiMode !== 'inventory') return false;
  const row = D.invL.rows.find(r => r.type === 'use' && r.kind === kind);
  if (!row) { clickRect(win, D.invL.close); return false; }
  clickRect(win, row.rect);
  if (D.uiMode === 'inventory') clickRect(win, D.invL.close);
  return true;
}
function gearScore(g) {
  if (!g) return 0;
  let s = g.power;
  for (const a of g.affixes) s += (a.k === 'hp' ? a.v / 6 : a.v);
  if (g.cursed && g.known && g.curse) s += (g.curse.k === 'hp' ? g.curse.v / 6 : g.curse.v);
  return s;
}
function tryEquipUpgrades(ctx) {
  const { win, D } = ctx;
  const S = D.S;
  for (let i = 0; i < S.pack.length; i++) {
    const g = S.pack[i];
    const cur = S.equip[g.slot];
    if (cur && cur.cursed && cur.known) continue; // stuck: shop service only
    if (gearScore(g) > gearScore(cur) + 0.5) {
      clickRect(win, D.hud.inv);
      if (D.uiMode !== 'inventory') return false;
      const row = D.invL.rows.find(r => r.type === 'pack' && r.i === i);
      if (row) clickRect(win, row.rect);
      if (D.uiMode === 'inventory') clickRect(win, D.invL.close);
      return true;
    }
  }
  return false;
}
const RING_PREFS = {
  reckless: ['ring_str', 'ring_regen', 'ring_prot'],
  careful: ['ring_regen', 'ring_prot', 'ring_str'],
};
function tryEquipRing(ctx) { // consumes a game turn
  const S = ctx.D.S;
  if (S.rings[0] !== null && S.rings[1] !== null) return false;
  for (const kind of RING_PREFS[ctx.policy]) {
    if ((S.inv[kind] | 0) > 0) return openInvAndUse(ctx, kind);
  }
  return false;
}
// Target-mode AoE: pick visible tile maximizing monsters hit.
function bestAoeTile(S, radius, minHits) {
  let best = null, bestN = 0;
  const vms = visMonsters(S);
  for (const c of vms) {
    let n = 0;
    for (const m of vms) if (cheby(m.x, m.y, c.x, c.y) <= radius) n++;
    const w = n + ((c.isBoss || c.isMini) ? 2 : 0);
    if (w > bestN) { bestN = w; best = c; }
  }
  if (!best) return null;
  let raw = 0;
  for (const m of vms) if (cheby(m.x, m.y, best.x, best.y) <= radius) raw++;
  if (raw < minHits && !vms.some(m => (m.isBoss || m.isMini) && cheby(m.x, m.y, best.x, best.y) <= radius)) return null;
  return best;
}

// careful anti-shooter tactic: a tile the awake shooters can neither see nor
// reach with their range forces the ranged AI to walk into melee.
function findHideTile(S, shooters, maxD) {
  const hidden = (x, y) => shooters.every(m => {
    const e = Math.sqrt((m.x - x) * (m.x - x) + (m.y - y) * (m.y - y));
    return e > (m.range || 6) || !losClear(S, x, y, m.x, m.y);
  });
  if (hidden(S.px, S.py)) return { x: S.px, y: S.py };
  const f = bfsField(S, true, true);
  let best = null, bestD = 99;
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    const i = idx(x, y);
    if (S.map[i] !== 1 || f.dist[i] <= 0 || f.dist[i] > maxD) continue;
    if (!hidden(x, y)) continue;
    if (f.dist[i] < bestD) { bestD = f.dist[i]; best = { x, y }; }
  }
  return best;
}

// ---------------------------------------------------------------- policy ----
function chooseTravelTarget(ctx) {
  const S = ctx.D.S;
  // careful: visit shop first on shop floors, then hoover up items, then stairs
  if (ctx.policy === 'careful') {
    if (S.keeper && !S.shopGreeted && !ctx.shopped) {
      for (const [dx, dy] of DIRS) {
        const ax = S.keeper.x + dx, ay = S.keeper.y + dy;
        if (inB(ax, ay) && S.map[idx(ax, ay)] === 1 && reachDist(S, ax, ay) >= 0)
          return { x: ax, y: ay, why: 'shop' };
      }
    }
    let best = null, bestD = 1e9;
    for (const it of S.items) {
      const d = reachDist(S, it.x, it.y);
      if (d >= 0 && d < bestD) { bestD = d; best = it; }
    }
    if (best) return { x: best.x, y: best.y, why: 'item' };
  }
  if (S.depth < 10 && S.stairs) return { x: S.stairs.x, y: S.stairs.y, why: 'stairs' };
  // depth 10: the amulet (reckless beeline; careful reaches here after items are gone)
  const am = S.items.find(it => it.type === 'amulet');
  if (am) return { x: am.x, y: am.y, why: 'amulet' };
  const boss = S.monsters.find(m => m.isBoss);
  if (boss) return { x: boss.x, y: boss.y, why: 'boss' };
  return null;
}

function playTurn(ctx) {
  const { win, D } = ctx;
  const S = D.S;
  const cls = S.cls;
  const adj = adjMonsters(S);
  const vms = visMonsters(S);

  if (ctx.lastDepth !== S.depth) { ctx.lastDepth = S.depth; ctx.shopped = false; ctx.holdCount = 0; }
  if (S.shopGreeted) ctx.shopped = true;

  if (ctx.policy === 'careful') {
    // survival consumables
    if (S.hp < S.maxHp * 0.4 && (S.inv.potion | 0) > 0 && S.hp < S.maxHp) {
      clickRect(win, D.hud.potion);
      return;
    }
    if (S.hp < S.maxHp * 0.25 && (S.inv.potion | 0) === 0 && (S.inv.scroll_tele | 0) > 0 && adj.length) {
      if (openInvAndUse(ctx, 'scroll_tele')) return;
    }
    if ((S.inv.scroll_map | 0) > 0 && !ctx.mappedDepth[S.depth]) {
      ctx.mappedDepth[S.depth] = true;
      if (openInvAndUse(ctx, 'scroll_map')) return;
    }
    // offensive consumables on clusters / bosses
    if ((S.inv.scroll_fire | 0) > 0) {
      const t = bestAoeTile(S, 2, 3);
      if (t && openInvAndUse(ctx, 'scroll_fire')) {
        if (D.uiMode === 'target') clickTile(win, D, t.x, t.y);
        return;
      }
    }
    if ((S.inv.flask | 0) > 0 && D.hud.flask) {
      const t = bestAoeTile(S, 1, 2);
      if (t) {
        clickRect(win, D.hud.flask);
        if (D.uiMode === 'target') { clickTile(win, D, t.x, t.y); return; }
      }
    }
  }

  // gear management when not engaged (both policies; zero-turn except rings)
  if (!adj.length) {
    if (tryEquipUpgrades(ctx)) return;
    if (tryEquipRing(ctx)) return;
  }

  // class ability
  if (S.abilityCd <= 0) {
    if (cls === 'warrior' && adj.length >= 2) { clickRect(win, D.hud.ability); return; }
    if (cls === 'ranger') {
      const inR = vms.filter(m => bowable(S, m) || manhattan(m.x, m.y, S.px, S.py) === 1);
      if (inR.length >= 2 || inR.some(m => m.isBoss || m.isMini)) { clickRect(win, D.hud.ability); return; }
    }
    // alchemist transmute: skipped (interactive reroll, not modelled)
  }

  // adjacent combat: click the monster tile (works even for wraiths phased into walls)
  if (adj.length) {
    let target = adj[0];
    for (const m of adj) if (m.hp < target.hp) target = m;
    if (S.seen[idx(target.x, target.y)]) { clickTile(win, D, target.x, target.y); return; }
    // unseen wall tile (rare wraith case): step away or wait
    clickTile(win, D, S.px, S.py);
    return;
  }

  // ranger bow: shoot nearest shootable monster
  if (cls === 'ranger') {
    let best = null, bestD = 99;
    for (const m of vms) {
      if (!bowable(S, m)) continue;
      const d = cheby(m.x, m.y, S.px, S.py);
      if (d < bestD) { bestD = d; best = m; }
    }
    if (best) { clickTile(win, D, best.x, best.y); return; }
  }

  // engage awake ranged monsters pelting us from afar (both policies): they
  // never "block" the path, but ignoring them means dying to chip damage.
  // Fleeing shooters move at player speed, so an open-map pursuit can cycle
  // forever — cap each chase, then blacklist the target and resume the goal.
  const shooters = vms.filter(m => m.awake && m.ai === 'ranged' && !((ctx.ignore[m.id] | 0) > S.turn));
  if (shooters.length) {
    shooters.sort((a, b) => manhattan(a.x, a.y, S.px, S.py) - manhattan(b.x, b.y, S.px, S.py));
    const tgt = shooters[0];
    const chased = (ctx.chase[tgt.id] || 0);
    if (chased > 30) {
      ctx.ignore[tgt.id] = S.turn + 150; // give up; walk on, eat the chip damage
    } else {
      if (ctx.policy === 'careful') {
        // flask it (alchemist) if the shooter lingers in view
        if ((S.inv.flask | 0) > 0 && D.hud.flask && chased > 2 && S.vis[idx(tgt.x, tgt.y)]) {
          clickRect(win, D.hud.flask);
          if (D.uiMode === 'target') { clickTile(win, D, tgt.x, tgt.y); return; }
        }
        // Shooters are frail and die in one melee, but crossing open ground
        // under fire is what kills melee classes (kobolds pelt 3-5/turn and
        // flee once you close to 2 tiles). If we can't reach the shooter
        // almost immediately, break line of sight FIRST — the ranged AI then
        // loses LOS and must walk into melee. This mirrors real corridor play;
        // rushing straight across an open room is the depth-1 death spiral.
        const reach = reachDist(S, tgt.x, tgt.y);
        const hw = (ctx.hideWait[tgt.id] || 0);
        if (reach > 2 && hw < 20) {
          const hide = findHideTile(S, shooters, 10);
          if (hide) {
            ctx.hideWait[tgt.id] = hw + 1;
            if (hide.x === S.px && hide.y === S.py) { clickTile(win, D, S.px, S.py); return; } // wait; they close on us
            if (stepToward(ctx, hide.x, hide.y)) return;
          }
        }
      }
      ctx.chase[tgt.id] = chased + 1;
      if (stepToward(ctx, tgt.x, tgt.y)) return;
    }
  }

  // careful: hold a corridor so awake melee monsters arrive one at a time
  if (ctx.policy === 'careful') {
    const threats = vms.filter(m => m.awake && (m.ai === 'melee' || m.ai === 'phase') && !m.isBoss);
    const rangedAwake = vms.some(m => m.awake && m.ai !== 'melee' && m.ai !== 'phase');
    if (threats.length >= 2 && !rangedAwake && ctx.holdCount < 15) {
      ctx.holdCount++;
      if (floorNeighbors(S, S.px, S.py) <= 2) {
        const onStairs = S.stairs && S.px === S.stairs.x && S.py === S.stairs.y;
        if (!onStairs) { clickTile(win, D, S.px, S.py); return; } // wait in the corridor
      } else {
        // move to nearest corridor tile within 5 steps
        const f = bfsField(S, true, true);
        let best = null, bestD = 99;
        for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
          const i = idx(x, y);
          if (S.map[i] !== 1 || f.dist[i] < 0 || f.dist[i] > 5) continue;
          if (floorNeighbors(S, x, y) > 2) continue;
          if (f.dist[i] < bestD) { bestD = f.dist[i]; best = [x, y]; }
        }
        if (best && stepToward(ctx, best[0], best[1])) return;
      }
    } else if (!threats.length) ctx.holdCount = 0;
  }

  // descend when standing on the stairs
  if (S.stairs && S.px === S.stairs.x && S.py === S.stairs.y) {
    if (ctx.policy === 'reckless' || !adj.length) { clickTile(win, D, S.px, S.py); return; }
  }

  // travel
  const tgt = chooseTravelTarget(ctx);
  if (tgt && (tgt.x !== S.px || tgt.y !== S.py) && stepToward(ctx, tgt.x, tgt.y)) return;
  if (tgt && tgt.x === S.px && tgt.y === S.py && tgt.why === 'stairs') { clickTile(win, D, S.px, S.py); return; }
  // nothing to do: engage nearest visible monster or wait
  if (vms.length && stepToward(ctx, vms[0].x, vms[0].y)) return;
  clickTile(win, D, S.px, S.py); // wait (or descend if on stairs)
}

function act(ctx) {
  const { win, D } = ctx;
  if (D.screen !== 'game') return;
  switch (D.uiMode) {
    case 'levelup': pickBoon(ctx); return;
    case 'shop': handleShop(ctx); return;
    case 'inventory': clickRect(win, D.invL.close); return;
    case 'target': clickAt(win, 5, win.innerHeight - 5); return; // cancel stray target mode
    default: playTurn(ctx);
  }
}

// ---------------------------------------------------------------- one run ---
function runOne(policy, cls) {
  const { dom, win, D, errors } = loadGame();
  try {
    // start a run from the title screen
    const card = D.titleL.cards.find(c => c.key === cls);
    clickRect(win, card.rect);
    if (D.screen !== 'game') throw new Error('run did not start for class ' + cls);

    const ctx = { win, D, policy, cls, lastDepth: 0, shopped: false, holdCount: 0, mappedDepth: {}, chase: {}, ignore: {}, hideWait: {} };
    let acts = 0, sameTurn = 0, lastTurn = -1, stuck = false;
    const tRun = Date.now();
    while (acts < MAX_ACTS && D.screen === 'game') {
      if (Date.now() - tRun > MAX_RUN_MS) { stuck = true; break; } // wall-clock softlock guard
      act(ctx);
      acts++;
      const t = D.S.turn;
      if (t === lastTurn) {
        sameTurn++;
        if (sameTurn > 40) clickTile(win, D, D.S.px, D.S.py); // force a wait turn
        if (sameTurn > 80) { stuck = true; break; }
      } else { sameTurn = 0; lastTurn = t; }
    }
    const S = D.S;
    return {
      policy, cls,
      win: D.screen === 'win',
      dead: D.screen === 'dead',
      stuck: stuck || (acts >= MAX_ACTS),
      depth: S.depth,
      level: S.level,
      souls: S.soulsEarned || 0,
      kills: S.kills,
      turns: S.turn,
      gold: S.gold,
      cause: S.causeOfDeath || '',
      errors: errors.slice(),
    };
  } finally {
    dom.window.close();
  }
}

// -------------------------------------------------------------- aggregate ---
function causeKey(s) {
  if (!s) return 'unknown';
  if (/spike trap/.test(s)) return 'spike trap';
  if (/poison dart/.test(s)) return 'dart trap';
  const m = s.match(/(?:Slain by a|Shot down by a) (.+?) on depth/);
  if (m) return m[1];
  if (/poison/i.test(s)) return 'poison';
  if (/Burned/.test(s)) return 'burning';
  return s.slice(0, 30);
}
function median(arr) {
  if (!arr.length) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}
const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);

function main() {
  const classes = ['warrior', 'ranger', 'alchemist'];
  const policies = ['reckless', 'careful'];
  const cells = [];
  let totalErrors = 0, errorSamples = [];
  const t0 = Date.now();

  for (const policy of policies) {
    for (const cls of classes) {
      const runs = [];
      for (let i = 0; i < RUNS_PER_CELL; i++) {
        const r = runOne(policy, cls);
        runs.push(r);
        if (r.errors.length) {
          totalErrors += r.errors.length;
          if (errorSamples.length < 5) errorSamples.push(...r.errors.slice(0, 2));
        }
      }
      cells.push({ policy, cls, runs });
      process.stderr.write(`. finished ${policy}/${cls} (${RUNS_PER_CELL} runs)\n`);
    }
  }

  // ---- report ----
  const lines = [];
  lines.push('| Policy | Class | Runs | Win % | Median depth | Avg lvl @ death | Avg souls | Avg kills | Top death causes |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const c of cells) {
    const n = c.runs.length;
    const wins = c.runs.filter(r => r.win).length;
    const deaths = c.runs.filter(r => r.dead);
    const causes = {};
    for (const r of deaths) {
      const k = causeKey(r.cause);
      causes[k] = (causes[k] || 0) + 1;
    }
    const top = Object.entries(causes).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([k, v]) => `${k} (${v})`).join(', ') || '—';
    const stuckN = c.runs.filter(r => r.stuck).length;
    lines.push(`| ${c.policy} | ${c.cls} | ${n} | ${(100 * wins / n).toFixed(0)}% | ` +
      `${median(c.runs.map(r => r.depth))} | ` +
      `${deaths.length ? avg(deaths.map(r => r.level)).toFixed(1) : '—'} | ` +
      `${avg(c.runs.map(r => r.souls)).toFixed(0)} | ` +
      `${avg(c.runs.map(r => r.kills)).toFixed(1)} | ` +
      `${top}${stuckN ? ` [stuck:${stuckN}]` : ''} |`);
  }
  console.log(lines.join('\n'));

  // death-depth histogram (all cells) for difficulty-spike analysis
  const byDepth = {};
  for (const c of cells) for (const r of c.runs) if (r.dead) byDepth[r.depth] = (byDepth[r.depth] || 0) + 1;
  console.log('\nDeaths by depth: ' + Object.keys(byDepth).sort((a, b) => a - b)
    .map(d => `d${d}:${byDepth[d]}`).join('  '));

  const allRuns = cells.flatMap(c => c.runs);
  console.log(`\nTotal runs: ${allRuns.length}   wins: ${allRuns.filter(r => r.win).length}` +
    `   stuck/timeout: ${allRuns.filter(r => r.stuck).length}` +
    `   console/page errors: ${totalErrors}`);
  if (errorSamples.length) console.log('Error samples:\n' + errorSamples.join('\n---\n'));
  console.log(`Elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (totalErrors > 0) process.exitCode = 1;
}

main();
