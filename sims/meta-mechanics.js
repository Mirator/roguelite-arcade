'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const games = Object.fromEntries(
  ['warband', 'loopline', 'dungeondeal'].map((name) => [
    name,
    fs.readFileSync(path.join(__dirname, '..', 'games', `${name}.html`), 'utf8'),
  ]),
);

function json(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadGame(name, storage = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push(`jsdomError: ${error && error.message}`));
  const dom = new JSDOM(games[name], {
    runScripts: 'dangerously',
    url: `http://${name}.test/`,
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.addEventListener('error', (event) => {
        errors.push((event.error && event.error.stack) || event.message);
      });
      window.addEventListener('unhandledrejection', (event) => {
        errors.push(`unhandledrejection: ${(event.reason && event.reason.stack) || event.reason}`);
      });
      for (const [key, raw] of Object.entries(storage)) window.localStorage.setItem(key, raw);

      const noop = () => {};
      const context = new Proxy({}, {
        get: () => noop,
        set: () => true,
      });
      window.HTMLCanvasElement.prototype.getContext = () => context;
      window.requestAnimationFrame = () => 1;
      window.cancelAnimationFrame = noop;
      window.AudioContext = window.webkitAudioContext = class {
        constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
        createOscillator() { return context; }
        createGain() { return context; }
        resume() {}
      };
    },
  });
  return { dom, win: dom.window, errors };
}

function assertClean(ctx, label) {
  assert.deepEqual(ctx.errors, [], `${label} boot errors:\n${ctx.errors.join('\n')}`);
}

let count = 0;
function test(name, fn) {
  try {
    fn();
    count++;
    console.log(`ok ${count} - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test('Warband preserves valid fields and removes unknown ownership', () => {
  const ctx = loadGame('warband', {
    wb_meta_v1: JSON.stringify({
      medals: 12, battleWins: 3, runs: 4,
      owned: { turtle: true, gold1: false, banner: 'yes', unknown: true },
    }),
  });
  assert.deepEqual(json(ctx.win.__wb.meta), {
    medals: 12, trophies: 0, battleWins: 3, runs: 4,
    owned: { turtle: true, gold1: false },
  });
  assert.equal(ctx.win.document.querySelector('#mMedals').textContent, '12');
  assert.doesNotMatch(ctx.win.document.querySelector('#scr-title').textContent, /undefined|NaN/);
  assertClean(ctx, 'Warband valid save');
  ctx.win.close();
});

test('Warband rejects malformed containers and unsafe counters field by field', () => {
  for (const raw of ['{', 'null', '[]', '"wrong"']) {
    const ctx = loadGame('warband', { wb_meta_v1: raw });
    assert.deepEqual(json(ctx.win.__wb.meta), {
      medals: 0, trophies: 0, battleWins: 0, runs: 0, owned: {},
    }, `fixture ${raw}`);
    assertClean(ctx, `Warband fixture ${raw}`);
    ctx.win.close();
  }

  const ctx = loadGame('warband', {
    wb_meta_v1: '{"medals":-1,"trophies":1.5,"battleWins":"7","runs":1e400,"owned":{"wolf":1,"gold2":true}}',
  });
  assert.deepEqual(json(ctx.win.__wb.meta), {
    medals: 0, trophies: 0, battleWins: 0, runs: 0, owned: { gold2: true },
  });
  assertClean(ctx, 'Warband unsafe fields');
  ctx.win.close();
});

test('Warband end-run arithmetic stays numeric after a malformed save', () => {
  const ctx = loadGame('warband', { wb_meta_v1: '{"medals":"many","owned":null}' });
  ctx.win.__wb.startRun('necro');
  ctx.win.__wb.state.wins = 2;
  ctx.win.__wb.state.pos = { l: 3 };
  ctx.win.__wb.endRun(false);
  assert.equal(ctx.win.__wb.meta.medals, 4);
  assert.equal(ctx.win.__wb.meta.runs, 1);
  assert.equal(Number.isFinite(ctx.win.__wb.meta.medals), true);
  assertClean(ctx, 'Warband arithmetic');
  ctx.win.close();
});

test('Loopline preserves valid partial fields, known upgrades, and loadout', () => {
  const ctx = loadGame('loopline', {
    loopline_meta_v2: JSON.stringify({
      supplies: 90,
      best: { loops: 5, wins: 2 },
      up: { pack: true, armory: false, unknown: true, lucky: 'yes' },
      loadout: 'shield',
    }),
  });
  assert.deepEqual(json(ctx.win.G.meta), {
    supplies: 90,
    best: { loops: 5, score: 0, wins: 2 },
    up: { pack: true, hearty: false, lucky: false, triage: false, armory: false },
    loadout: 'shield',
  });
  assert.doesNotMatch(ctx.win.document.querySelector('#overlay').textContent, /undefined|NaN/);
  assertClean(ctx, 'Loopline valid save');
  ctx.win.close();
});

test('Loopline normalizes legacy best data and malformed modern saves', () => {
  const legacy = loadGame('loopline', {
    loopline_best_v1: JSON.stringify({ loops: 3, score: 44, wins: 1, extra: 9 }),
  });
  assert.deepEqual(json(legacy.win.G.meta.best), { loops: 3, score: 44, wins: 1 });
  assertClean(legacy, 'Loopline legacy save');
  legacy.win.close();

  for (const raw of ['{', 'null', '[]', 'true']) {
    const ctx = loadGame('loopline', { loopline_meta_v2: raw });
    assert.deepEqual(json(ctx.win.G.meta), {
      supplies: 0,
      best: { loops: 0, score: 0, wins: 0 },
      up: { pack: false, hearty: false, lucky: false, triage: false, armory: false },
      loadout: 'sword',
    }, `fixture ${raw}`);
    assertClean(ctx, `Loopline fixture ${raw}`);
    ctx.win.close();
  }

  const unsafe = loadGame('loopline', {
    loopline_meta_v2: '{"supplies":-5,"best":{"loops":2.2,"score":1e400,"wins":"1"},"up":[],"loadout":"axe"}',
  });
  assert.deepEqual(json(unsafe.win.G.meta), {
    supplies: 0,
    best: { loops: 0, score: 0, wins: 0 },
    up: { pack: false, hearty: false, lucky: false, triage: false, armory: false },
    loadout: 'sword',
  });
  assertClean(unsafe, 'Loopline unsafe fields');
  unsafe.win.close();
});

test('Loopline banking arithmetic stays numeric after a malformed save', () => {
  const ctx = loadGame('loopline', { loopline_meta_v2: '{"supplies":"lots","best":null,"up":42}' });
  ctx.win.startRun(0);
  ctx.win.G.S.score = 21;
  ctx.win.endRun('retreat');
  assert.equal(ctx.win.G.meta.supplies, 21);
  assert.equal(ctx.win.G.meta.best.score, 21);
  assert.equal(Number.isFinite(ctx.win.G.meta.supplies), true);
  assertClean(ctx, 'Loopline arithmetic');
  ctx.win.close();
});

test('Dungeon Deal preserves safe best fields and clamps wins to runs', () => {
  const ctx = loadGame('dungeondeal', {
    dd_best: JSON.stringify({ floor: 7, gold: 123, won: true, unknown: 1 }),
    dd_meta: JSON.stringify({ runs: 4, wins: 9, unknown: true }),
  });
  assert.deepEqual(json(ctx.win.loadBest()), { floor: 7, gold: 123, won: true });
  assert.deepEqual(json(ctx.win.meta()), { runs: 4, wins: 4 });
  assert.match(ctx.win.document.querySelector('#best-chip').textContent, /123/);
  assert.doesNotMatch(ctx.win.document.querySelector('#best-chip').textContent, /undefined|NaN/);
  assertClean(ctx, 'Dungeon Deal valid save');
  ctx.win.close();
});

test('Dungeon Deal rejects malformed containers and normalizes unsafe fields', () => {
  for (const raw of ['{', 'null', '[]', '"wrong"']) {
    const ctx = loadGame('dungeondeal', { dd_best: raw, dd_meta: raw });
    assert.equal(ctx.win.loadBest(), null, `best fixture ${raw}`);
    assert.deepEqual(json(ctx.win.meta()), { runs: 0, wins: 0 }, `meta fixture ${raw}`);
    assertClean(ctx, `Dungeon Deal fixture ${raw}`);
    ctx.win.close();
  }

  const ctx = loadGame('dungeondeal', {
    dd_best: '{"floor":-1,"gold":1e400,"won":"yes"}',
    dd_meta: '{"runs":2.5,"wins":-1}',
  });
  assert.deepEqual(json(ctx.win.loadBest()), { floor: 0, gold: 0, won: false });
  assert.deepEqual(json(ctx.win.meta()), { runs: 0, wins: 0 });
  assertClean(ctx, 'Dungeon Deal unsafe fields');
  ctx.win.close();

  const partial = loadGame('dungeondeal', {
    dd_best: '{"floor":6,"gold":"rich","won":true}',
    dd_meta: '{"runs":5,"wins":"two"}',
  });
  assert.deepEqual(json(partial.win.loadBest()), { floor: 6, gold: 0, won: true });
  assert.deepEqual(json(partial.win.meta()), { runs: 5, wins: 0 });
  assertClean(partial, 'Dungeon Deal partial save');
  partial.win.close();
});

test('Dungeon Deal end-run arithmetic stays numeric after a malformed save', () => {
  const ctx = loadGame('dungeondeal', {
    dd_best: '{"floor":"deep","gold":null,"won":0}',
    dd_meta: '{"runs":"many","wins":true}',
  });
  ctx.win.newRun();
  ctx.win.DD.state.floor = 3;
  ctx.win.DD.state.gold = 17;
  ctx.win.endRun(false);
  assert.deepEqual(json(ctx.win.loadBest()), { floor: 3, gold: 17, won: false });
  assert.deepEqual(json(ctx.win.meta()), { runs: 1, wins: 0 });
  assert.equal(Number.isFinite(ctx.win.meta().runs), true);
  assertClean(ctx, 'Dungeon Deal arithmetic');
  ctx.win.close();
});

console.log(`Meta mechanics: ${count} checks passed.`);
