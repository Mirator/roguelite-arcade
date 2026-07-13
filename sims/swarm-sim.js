// Headless harness v2: runs expanded swarm.html game logic with stubbed DOM/canvas.
// Usage: node swarm-sim.js [game-html] [seconds]
// Pass seconds as the only argument to use ../games/swarm.html.
"use strict";
const fs = require("fs");
const path = require("path");

const defaultGame = path.resolve(__dirname, "../games/swarm.html");
const mechanicsMode = process.argv.includes("--mechanics");
const positionalArgs = process.argv.slice(2).filter((arg) => arg !== "--mechanics");
const firstArg = positionalArgs[0];
const useDefaultGame = firstArg === undefined || (firstArg.trim() !== "" && Number.isFinite(Number(firstArg)));
const gamePath = useDefaultGame ? defaultGame : firstArg;
const runSecondsArg = useDefaultGame ? firstArg : positionalArgs[1];
const html = fs.readFileSync(gamePath, "utf8");
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error("no script found"); process.exit(1); }
const src = m[1];

// ---- stubs ----
function makeEl(id) {
  let _html = "";
  const el = {
    id, children: [], handlers: {}, _cls: new Set(),
    classList: {
      add: (c) => el._cls.add(c),
      remove: (c) => el._cls.delete(c),
      toggle: (c, on) => { if (on === undefined) on = !el._cls.has(c); if (on) el._cls.add(c); else el._cls.delete(c); },
      contains: (c) => el._cls.has(c),
    },
    style: {},
    textContent: "",
    className: "",
    disabled: false,
    setAttribute(name, value) { el[name] = String(value); },
    getAttribute(name) { return el[name] === undefined ? null : String(el[name]); },
    appendChild(c) { el.children.push(c); return c; },
    addEventListener(t, fn) { (el.handlers[t] = el.handlers[t] || []).push(fn); },
    dispatchEvent(ev) { (el.handlers[ev.type] || []).forEach(fn => fn(ev)); return true; },
    getContext() { return ctxProxy; },
    width: 1280, height: 800,
  };
  Object.defineProperty(el, "innerHTML", {
    get: () => _html,
    set: (v) => { _html = v; if (v === "") el.children.length = 0; },
  });
  return el;
}
function noop() { return noop; }
const ctxProxy = new Proxy({}, { get: () => noop, set: () => true });

const ids = ["game", "pauseBtn", "muteBtn", "dmgBtn", "homeBtn", "titleScreen", "startRow", "startBtn", "openTreeBtn", "treeCoinBadge", "bestHint",
  "treeScreen", "treeBackBtn", "coinsLabelFull", "treeSvgFull", "treeNodesFull", "nodeInfoFull", "buyBtnFull", "respecBtnFull",
  "levelUpScreen", "lvlSub", "cards", "rerollBtn", "dpsPanelLevelUp", "chestScreen", "chestCards", "dpsPanelChest",
  "pauseScreen", "resumeBtn", "pauseNewRunBtn", "pauseMuteBtn", "pauseHomeBtn", "pauseHelpBtn",
  "liveStatus", "steerHint", "steerHintClose",
  "deathScreen", "deathStats", "bestLine", "coinLine", "dmgTable", "dpsCanvas", "newRunBtn",
  "winScreen", "winStats", "winDmgTable", "winDpsCanvas", "winRunBtn"];
const els = {};
for (const id of ids) els[id] = makeEl(id);

const literalIdPattern = /\b(?:el|(?:document\.)?getElementById)\(\s*["']([^"']+)["']\s*\)/g;
const referencedIds = new Set();
let idMatch;
while ((idMatch = literalIdPattern.exec(src)) !== null) referencedIds.add(idMatch[1]);
const missingIds = [...referencedIds].filter((id) => !els[id]).sort();
if (missingIds.length > 0) {
  throw new Error(`Swarm simulator DOM fixture is missing IDs referenced by ${gamePath}: ${missingIds.join(", ")}`);
}

let rafCb = null;
const winHandlers = {};
const window = {
  innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
  addEventListener: (t, fn) => { (winHandlers[t] = winHandlers[t] || []).push(fn); },
  dispatchEvent: (ev) => { (winHandlers[ev.type] || []).forEach(fn => fn(ev)); },
};
const document = {
  getElementById: (id) => els[id] || null,
  createElement: () => makeEl("div"),
};
const localStorage = { _d: {}, getItem(k) { return this._d[k] !== undefined ? this._d[k] : null; }, setItem(k, v) { this._d[k] = String(v); } };
const requestAnimationFrame = (cb) => { rafCb = cb; };
const timeouts = [];
const setTimeout_ = (fn, ms) => { timeouts.push({ fn, at: now + ms }); };
let now = 0;
const performance = { now: () => now };
class MouseEvent { constructor(type, opts = {}) { this.type = type; Object.assign(this, opts); this.stopPropagation = () => {}; } }
class Event { constructor(type) { this.type = type; this.stopPropagation = () => {}; } }
const CanvasRenderingContext2D = function () {};
CanvasRenderingContext2D.prototype = {};

// pre-seed shop levels if requested (e.g. SHOP='{"dmg":2}')
if (process.env.SHOP) localStorage.setItem("swarm_shop", process.env.SHOP);
// pre-seed upgrade-tree ownership if requested, e.g. TREE="o1,o2,o3,v1,v2"
if (process.env.TREE) {
  const owned = {};
  for (const id of process.env.TREE.split(",").map(s => s.trim()).filter(Boolean)) owned[id] = true;
  localStorage.setItem("swarm_tree", JSON.stringify(owned));
}
if (process.env.BANKCOINS) localStorage.setItem("swarm_coins", process.env.BANKCOINS);

globalThis.__DBG = process.env.DBGHITS === "1";
const fn = new Function(
  "window", "document", "localStorage", "requestAnimationFrame", "performance", "MouseEvent", "Event", "CanvasRenderingContext2D", "setTimeout",
  src
);
fn(window, document, localStorage, requestAnimationFrame, performance, MouseEvent, Event, CanvasRenderingContext2D, setTimeout_);

const S = window.__swarm;
if (!S) { console.error("no __swarm handle"); process.exit(1); }

function step(dtMs) {
  now += dtMs;
  for (let i = timeouts.length - 1; i >= 0; i--) {
    if (timeouts[i].at <= now) { const t = timeouts.splice(i, 1)[0]; t.fn(); }
  }
  const cb = rafCb; rafCb = null;
  if (cb) cb(now);
}

function runMechanics() {
  const checks = [];
  const check = (name, condition, details) => {
    if (!condition) throw new Error(`${name}: ${details}`);
    checks.push(name);
  };
  const clearRunObjects = () => {
    for (const group of [S.enemies, S.gems, S.pickups, S.projectiles, S.chests, S.mines, S.glaives, S.strikes, S.shells, S.spits]) {
      group.length = 0;
    }
  };
  const disableWeapons = () => {
    for (const weapon of Object.values(S.weapons)) weapon.level = 0;
  };
  const placeEnemy = (x, y, hp = 10000, radius = 50) => {
    const enemy = S.spawnEnemy(0);
    if (!enemy) throw new Error("Unable to add enemy to mechanics fixture");
    enemy.x = x;
    enemy.y = y;
    enemy.hp = enemy.maxHp = hp;
    enemy.r = radius;
    enemy.dmg = 0;
    return enemy;
  };
  const linearNearest = (x, y, maxDist) => {
    let best = null;
    let bestDistance = maxDist * maxDist;
    for (let i = 0; i < S.enemies.length; i++) {
      const enemy = S.enemies[i];
      if (enemy.dead) continue;
      const dx = enemy.x - x;
      const dy = enemy.y - y;
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = enemy;
      }
    }
    return best;
  };
  const checkGridNearest = (name, x, y, maxDist) => {
    S.testing.gridRebuild();
    const expected = linearNearest(x, y, maxDist);
    const actual = S.testing.nearestEnemyTo(x, y, maxDist);
    check(name, actual === expected, `grid target index ${S.enemies.indexOf(actual)}, linear target index ${S.enemies.indexOf(expected)}`);
    return actual;
  };

  S.testing.startRun();
  clearRunObjects();
  S.player.hp = 1;
  S.player.invuln = 0;
  S.player.revives = 0;
  S.spits.push({ x: S.player.x, y: S.player.y, vx: 0, vy: 0, life: 1, dmg: 999, r: 6 });
  S.chests.push({ x: S.player.x, y: S.player.y, t: 0, r: 0 });
  const bankBefore = S.coins;
  S.testing.update(0);
  const deathStats = S.stats();
  check("lethal projectile ends the run", deathStats.state === "dead", `state was ${deathStats.state}`);
  check("later chest phase is skipped after death", S.chests.length === 1, `chest count was ${S.chests.length}`);
  check("death modal is not replaced by chest modal", els.chestScreen._cls.has("hidden"), "chest modal became visible");
  check("death banks the run exactly once", S.coins - bankBefore === deathStats.runCoins, `bank delta ${S.coins - bankBefore}, run coins ${deathStats.runCoins}`);

  S.testing.startRun();
  clearRunObjects();
  S.player.hp = 1;
  S.player.invuln = 0;
  S.player.revives = 1;
  const expectedReviveHp = Math.ceil(S.player.maxHp * 0.5);
  S.spits.push({ x: S.player.x, y: S.player.y, vx: 0, vy: 0, life: 1, dmg: 999, r: 6 });
  S.testing.update(0);
  check("Phoenix keeps the run playing", S.stats().state === "play", `state was ${S.stats().state}`);
  check("Phoenix consumes one revive", S.player.revives === 0, `revives were ${S.player.revives}`);
  check("Phoenix restores half health", S.player.hp === expectedReviveHp, `hp was ${S.player.hp}, expected ${expectedReviveHp}`);

  const levelCoinReward = S.testing.coinCard();
  const chestCoinReward = S.testing.chestRewards.find((reward) => reward.name === "Coin Cache");
  check("chest Coin Cache definition is present", Boolean(chestCoinReward), "Coin Cache reward was missing");

  S.testing.startRun();
  S.player.coinMul = 1;
  S.testing.setState("levelup");
  let coinsBefore = S.stats().runCoins;
  levelCoinReward.apply();
  check("level-up Coin Cache credits 30 coins", S.stats().runCoins - coinsBefore === 30, `credited ${S.stats().runCoins - coinsBefore}`);
  S.testing.setState("chest");
  coinsBefore = S.stats().runCoins;
  chestCoinReward.apply();
  check("chest Coin Cache credits 40 coins", S.stats().runCoins - coinsBefore === 40, `credited ${S.stats().runCoins - coinsBefore}`);

  S.testing.startRun();
  S.player.coinMul = 1.25;
  S.testing.setState("levelup");
  levelCoinReward.apply();
  check("modal reward applies multiplier and rounding", S.stats().runCoins === 38, `run coins were ${S.stats().runCoins}`);
  S.testing.setState("chest");
  for (let i = 0; i < 100; i++) chestCoinReward.apply();
  check("modal rewards respect the run coin cap", S.stats().runCoins === 1500, `run coins were ${S.stats().runCoins}`);

  S.testing.setState("title");
  coinsBefore = S.stats().runCoins;
  levelCoinReward.apply();
  check("title state rejects modal rewards", S.stats().runCoins === coinsBefore, `run coins changed to ${S.stats().runCoins}`);
  S.testing.setState("dead");
  chestCoinReward.apply();
  check("dead state rejects modal rewards", S.stats().runCoins === coinsBefore, `run coins changed to ${S.stats().runCoins}`);

  S.testing.startRun();
  clearRunObjects();
  disableWeapons();
  S.player.critCh = 0;
  const targetX = S.player.x + 100;
  const targetY = S.player.y;
  const firstTarget = placeEnemy(targetX, targetY);
  S.weapons.bolt.level = 6;
  S.testing.fireBolt();
  const boltProjectiles = S.projectiles.filter((projectile) => projectile.src === "bolt");
  check("Bolt projectiles start with per-projectile hit history", boltProjectiles.length > 0 && boltProjectiles.every((projectile) => projectile.hitTargets instanceof Set), "Bolt projectile history was missing");
  const piercingProjectile = boltProjectiles[0];
  S.projectiles.length = 0;
  S.projectiles.push(piercingProjectile);
  disableWeapons();
  piercingProjectile.x = targetX;
  piercingProjectile.y = targetY;
  piercingProjectile.vx = 0;
  piercingProjectile.vy = 0;
  const firstHp = firstTarget.hp;
  S.testing.update(0);
  const hpAfterFirstHit = firstTarget.hp;
  check("piercing projectile damages its first target", hpAfterFirstHit < firstHp, `hp stayed at ${firstHp}`);
  check("piercing projectile survives its first target", S.projectiles.includes(piercingProjectile), "projectile was removed");
  S.testing.update(0);
  check("piercing projectile does not rehit the same target", firstTarget.hp === hpAfterFirstHit, `hp changed from ${hpAfterFirstHit} to ${firstTarget.hp}`);
  const secondTarget = placeEnemy(targetX, targetY);
  const secondHp = secondTarget.hp;
  S.testing.update(0);
  check("piercing projectile damages a distinct target", secondTarget.hp < secondHp, `hp stayed at ${secondHp}`);
  check("distinct target consumes the remaining pierce budget", !S.projectiles.includes(piercingProjectile), "projectile survived exhausted pierce");

  S.testing.startRun();
  clearRunObjects();
  disableWeapons();
  S.player.critCh = 0;
  const sharedTarget = placeEnemy(targetX, targetY);
  S.weapons.bolt.level = 1;
  S.testing.fireBolt();
  S.testing.fireBolt();
  const separateProjectiles = S.projectiles.slice();
  disableWeapons();
  for (const projectile of separateProjectiles) {
    projectile.x = targetX;
    projectile.y = targetY;
    projectile.vx = 0;
    projectile.vy = 0;
  }
  const sharedHp = sharedTarget.hp;
  const expectedTwoHits = separateProjectiles.reduce((sum, projectile) => sum + projectile.dmg, 0);
  S.testing.update(0);
  check("separate projectiles may hit the same target", sharedTarget.hp === sharedHp - expectedTwoHits, `damage was ${sharedHp - sharedTarget.hp}, expected ${expectedTwoHits}`);
  check("non-piercing projectiles still disappear on hit", separateProjectiles.every((projectile) => !S.projectiles.includes(projectile)), `${S.projectiles.length} projectiles remained`);

  S.testing.startRun();
  clearRunObjects();
  disableWeapons();
  placeEnemy(targetX, targetY);
  S.weapons.scatter.level = 1;
  S.weapons.scatter.evolved = true;
  S.testing.fireScatter();
  const scatterProjectiles = S.projectiles.filter((projectile) => projectile.src === "scatter");
  check("Scatter projectiles start with per-projectile hit history", scatterProjectiles.length > 0 && scatterProjectiles.every((projectile) => projectile.hitTargets instanceof Set), "Scatter projectile history was missing");

  const queryX = 1000;
  const queryY = 1000;
  clearRunObjects();
  const adjacentInside = placeEnemy(1008, queryY, 10000, 10);
  placeEnemy(1090, queryY, 10000, 10);
  check("grid homing includes an in-range adjacent-cell enemy", checkGridNearest("grid nearest matches linear reference across adjacent cells", queryX, queryY, 80) === adjacentInside, "in-range adjacent-cell enemy was not selected");

  clearRunObjects();
  placeEnemy(1090, queryY, 10000, 10);
  check("grid homing excludes an out-of-range adjacent-cell enemy", checkGridNearest("grid nearest matches linear reference when an adjacent-cell enemy is outside radius", queryX, queryY, 80) === null, "out-of-range adjacent-cell enemy was selected");

  clearRunObjects();
  const deadCandidate = placeEnemy(queryX + 10, queryY, 10000, 10);
  const liveCandidate = placeEnemy(queryX + 30, queryY, 10000, 10);
  S.testing.gridRebuild();
  deadCandidate.dead = true;
  check("grid homing ignores candidates that die after rebuild", S.testing.nearestEnemyTo(queryX, queryY, 80) === liveCandidate, "dead candidate was selected");

  clearRunObjects();
  checkGridNearest("grid homing returns no target for an empty fixture", queryX, queryY, 80);

  clearRunObjects();
  const firstEqual = placeEnemy(queryX + 60, queryY, 10000, 10);
  placeEnemy(queryX - 60, queryY, 10000, 10);
  check("equal-distance grid ties preserve enemy-array order", checkGridNearest("grid nearest matches linear reference for equal distances", queryX, queryY, 80) === firstEqual, "later enemy won an equal-distance tie");

  clearRunObjects();
  placeEnemy(queryX + 60.0001, queryY, 10000, 10);
  const nearerByFraction = placeEnemy(queryX - 60, queryY, 10000, 10);
  check("near-distance grid selection preserves squared-distance precision", checkGridNearest("grid nearest matches linear reference for near distances", queryX, queryY, 80) === nearerByFraction, "fractionally nearer enemy was not selected");

  clearRunObjects();
  const sparseTarget = placeEnemy(520, 500, 10000, 10);
  placeEnemy(560, 500, 10000, 10);
  placeEnemy(500, 570, 10000, 10);
  placeEnemy(580, 580, 10000, 10);
  for (let i = 4; i < 380; i++) placeEnemy(2800 + (i % 20) * 20, 2800 + ((i / 20) | 0) * 20, 10000, 10);
  S.testing.gridRebuild();
  const sparseMetrics = {};
  const sparseActual = S.testing.nearestEnemyTo(500, 500, 420, sparseMetrics);
  check("sparse homing fixture contains 380 enemies", S.enemies.length === 380, `enemy count was ${S.enemies.length}`);
  check("sparse homing evaluates only queried grid cells", sparseMetrics.evaluated === 4, `evaluated ${sparseMetrics.evaluated} of ${S.enemies.length} enemies`);
  check("sparse grid nearest matches linear reference", sparseActual === sparseTarget && sparseActual === linearNearest(500, 500, 420), "sparse fixture selected a different target");

  S.testing.startRun();
  clearRunObjects();
  disableWeapons();
  const homingTarget = placeEnemy(S.player.x + 180, S.player.y, 10000, 10);
  const homingDecoy = placeEnemy(S.player.x, S.player.y + 300, 10000, 10);
  homingTarget.spd = 0;
  homingDecoy.spd = 0;
  const movingHomingProjectile = {
    x: S.player.x, y: S.player.y, vx: 0, vy: 200, spd: 200,
    life: 2, dmg: 0, r: 4, pierce: 0, crit: 0, homing: true,
    hue: 210, src: "bolt", hitTargets: new Set(),
  };
  S.projectiles.push(movingHomingProjectile);
  const homingDt = 0.05;
  const linearHomingTarget = linearNearest(movingHomingProjectile.x, movingHomingProjectile.y, 420);
  check("moving homing fixture selects the expected linear-reference target", linearHomingTarget === homingTarget, "linear reference selected the decoy");
  const initialAngle = Math.atan2(movingHomingProjectile.vy, movingHomingProjectile.vx);
  const targetAngle = Math.atan2(linearHomingTarget.y - movingHomingProjectile.y, linearHomingTarget.x - movingHomingProjectile.x);
  const expectedAngle = initialAngle + Math.max(-6 * homingDt, Math.min(6 * homingDt, targetAngle - initialAngle));
  S.testing.update(homingDt);
  const actualAngle = Math.atan2(movingHomingProjectile.vy, movingHomingProjectile.vx);
  check("moving homing projectile steers toward the linear-reference target", Math.abs(actualAngle - expectedAngle) < 1e-12, `angle was ${actualAngle}, expected ${expectedAngle}`);
  check("moving homing projectile advances after steering", movingHomingProjectile.x !== S.player.x || movingHomingProjectile.y !== S.player.y, "projectile did not move");

  console.log(JSON.stringify({ suite: "swarm:mechanics", checks: checks.length, passed: checks }));
}

if (mechanicsMode) {
  runMechanics();
  process.exit(0);
}

// start
step(16); step(16);
els.startBtn.dispatchEvent(new MouseEvent("click"));

const mouse = { x: 640, y: 400 };
const WORLD_HALF = 1900; // WORLD=3800 in swarm.html; keeps the AI from hugging map edges
let cardPicks = 0, chestPicks = 0, rerollsUsed = 0, evolutions = 0;
let updateTimeAccum = 0, updateFrames = 0, maxEnemies = 0, peakUpdateMs = 0;
const bossLog = [];
let lastBossName = null;

const RUN_SECONDS = parseFloat(runSecondsArg || "480");
const GOD = process.env.GOD === "1";

// --- skill profile config ---
// max:  perfect dodging, instant reactions, full telegraph awareness
// mid:  human-cadence decisions (~100ms tick) + 250ms extra reaction lag + 20% chance/tick to miss a dodge read
// weak: instant reactions but does NOT react to artillery-shell / bomber telegraphs at all (only general kiting)
const PROFILE = process.env.PROFILE || "max";
const PROFILE_CFG = {
  max:  { skill: 1.8, tickMs: 16.67, reactDelayMs: 0,   missChance: 0,   telegraphW: 1 },
  mid:  { skill: 1.0, tickMs: 100,   reactDelayMs: 250, missChance: 0.2, telegraphW: 1 },
  weak: { skill: 1.0, tickMs: 16.67, reactDelayMs: 0,   missChance: 0,   telegraphW: 0 },
};
const CFG = PROFILE_CFG[PROFILE] || PROFILE_CFG.max;
const SKILL = CFG.skill;
let lastTickAt = -1e9;
let curTargetAng = 0; // held between ticks (models reaction cadence / missed dodges)
const decisionQueue = []; // {readyAt, ang} for reaction-delay modeling

let dead = false, won = false, lastLog = 0;
while (!dead && !won && S.stats().elapsed < RUN_SECONDS) {
  if (GOD) S.player.invuln = 99;
  const stPre = S.stats();
  if ((GOD || process.env.DEBUG) && stPre.elapsed - lastLog >= 10) {
    lastLog = stPre.elapsed;
    console.log("t=" + Math.round(stPre.elapsed) + "s enemies=" + stPre.enemies + " kills=" + stPre.kills + " level=" + S.player.level + " coins=" + stPre.runCoins + " hp=" + Math.round(S.player.hp) + "/" + S.player.maxHp + (stPre.boss ? " BOSS:" + stPre.boss.name + "@" + stPre.boss.hp : ""));
  }
  if (stPre.boss && stPre.boss.name !== lastBossName) { lastBossName = stPre.boss.name; bossLog.push(Math.round(stPre.elapsed) + "s:" + stPre.boss.name); }
  if (!stPre.boss) lastBossName = null;

  // --- gap-seeking kiting AI ---
  const p = S.player;
  const NB = 24;
  const danger = new Array(NB).fill(0);
  const gemScore = new Array(NB).fill(0);
  let nearestEnemyD = 1e9;
  for (let i = 0; i < S.enemies.length; i++) {
    const e = S.enemies[i];
    const dx = e.x - p.x, dy = e.y - p.y;
    const d = Math.hypot(dx, dy);
    if (d < nearestEnemyD) nearestEnemyD = d;
    // fast movers (e.g. SWARM CROSSING's 1.9x-speed rushers, dashers mid-lunge)
    // close distance quickly -- a skilled player clocks them well before they're
    // in "normal" 550-range, so extend the detection radius by how fast they close.
    const speedRange = 550 + Math.max(0, e.spd - 110) * 2.2;
    if (d > speedRange) continue;
    const b = ((Math.atan2(dy, dx) / (Math.PI * 2) + 1.25) * NB | 0) % NB;
    const w = speedRange / (d + 30) * (e.kind === 4 ? 2 : 1);
    danger[b] += w;
    danger[(b + 1) % NB] += w * 0.6; danger[(b + NB - 1) % NB] += w * 0.6;
    danger[(b + 2) % NB] += w * 0.25; danger[(b + NB - 2) % NB] += w * 0.25;
  }
  for (let i = 0; i < S.gems.length; i++) {
    const g = S.gems[i];
    const dx = g.x - p.x, dy = g.y - p.y;
    const d = Math.hypot(dx, dy);
    if (d > 700) continue;
    const b = ((Math.atan2(dy, dx) / (Math.PI * 2) + 1.25) * NB | 0) % NB;
    gemScore[b] += (g.v || 1) * 120 / (d + 60);
  }
  for (let i = 0; i < S.chests.length; i++) {
    const c = S.chests[i];
    const dx = c.x - p.x, dy = c.y - p.y;
    const d = Math.hypot(dx, dy);
    if (d > 900) continue;
    const b = ((Math.atan2(dy, dx) / (Math.PI * 2) + 1.25) * NB | 0) % NB;
    gemScore[b] += 400 / (d + 60);
  }
  // engage boss like a real player would: only once actually built up (early
  // bosses are correctly kited/avoided by a skilled player, not tanked while
  // still at low weapon levels -- forcing early engagement was making the AI
  // eat unnecessary boss-pattern damage on top of the early wave-event gauntlet)
  const boss = S.enemies.find(e => e.kind === 4 && !e.dead);
  if (boss && p.hp > p.maxHp * 0.35 && S.player.level >= 14) {
    const dx = boss.x - p.x, dy = boss.y - p.y;
    const d = Math.hypot(dx, dy);
    if (d > 170) { // stay near, danger buckets keep us from hugging it
      const b = ((Math.atan2(dy, dx) / (Math.PI * 2) + 1.25) * NB | 0) % NB;
      gemScore[b] += 25;
      gemScore[(b + 1) % NB] += 12; gemScore[(b + NB - 1) % NB] += 12;
    }
  }
  // dodge artillery telegraphs and armed bombers (telegraphW=0 models a player who
  // doesn't recognize/react to these telegraphs at all -- "weak" profile)
  const shells = S.shells || [];
  for (let i = 0; i < shells.length; i++) {
    const sh = shells[i];
    const dx = sh.x - p.x, dy = sh.y - p.y;
    const d = Math.hypot(dx, dy);
    if (d < sh.r + 160) {
      const b = ((Math.atan2(dy, dx) / (Math.PI * 2) + 1.25) * NB | 0) % NB;
      const w = 60 * (sh.r + 160) / (d + 40) * CFG.telegraphW;
      danger[b] += w; danger[(b + 1) % NB] += w * 0.6; danger[(b + NB - 1) % NB] += w * 0.6;
      if (d < sh.r + 20) for (let bb = 0; bb < NB; bb++) danger[bb] += 4 * CFG.telegraphW; // inside: get out fast
    }
  }
  for (let i = 0; i < S.enemies.length; i++) {
    const e = S.enemies[i];
    if (e.kind === 8 && e.mode === "arm") {
      const dx = e.x - p.x, dy = e.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d < 300) {
        const b = ((Math.atan2(dy, dx) / (Math.PI * 2) + 1.25) * NB | 0) % NB;
        danger[b] += 80 * CFG.telegraphW; danger[(b + 1) % NB] += 40 * CFG.telegraphW; danger[(b + NB - 1) % NB] += 40 * CFG.telegraphW;
      }
    }
  }
  // dodge incoming bullets (spitter shots + boss burst/spiral spits) -- reflex
  // dodging, not a "telegraph", so it applies at full weight to every profile
  // (mid/weak still fall behind here via SKILL, reaction cadence, and delay)
  const spits = S.spits || [];
  for (let i = 0; i < spits.length; i++) {
    const s = spits[i];
    const dx0 = s.x - p.x, dy0 = s.y - p.y;
    const d0 = Math.hypot(dx0, dy0);
    if (d0 < 220) {
      const b = ((Math.atan2(dy0, dx0) / (Math.PI * 2) + 1.25) * NB | 0) % NB;
      const w = 26 * 220 / (d0 + 30);
      danger[b] += w; danger[(b + 1) % NB] += w * 0.5; danger[(b + NB - 1) % NB] += w * 0.5;
    }
    // lookahead: where will it be in ~0.3s? react to bullets closing in fast.
    const lx = s.x + (s.vx || 0) * 0.3, ly = s.y + (s.vy || 0) * 0.3;
    const dx1 = lx - p.x, dy1 = ly - p.y;
    const d1 = Math.hypot(dx1, dy1);
    if (d1 < 130) {
      const b = ((Math.atan2(dy1, dx1) / (Math.PI * 2) + 1.25) * NB | 0) % NB;
      const w = 34 * 130 / (d1 + 25);
      danger[b] += w; danger[(b + 1) % NB] += w * 0.5; danger[(b + NB - 1) % NB] += w * 0.5;
    }
  }
  const gemW = nearestEnemyD > 200 ? 1.0 : 0.25;

  // a skilled player doesn't let themselves get walled into a corner: bias gently
  // back toward the open center of the map once far out, scaling with distance.
  const CTR = WORLD_HALF, cdx = CTR - p.x, cdy = CTR - p.y;
  const centerD = Math.hypot(cdx, cdy);
  if (centerD > 900) {
    const cb = ((Math.atan2(cdy, cdx) / (Math.PI * 2) + 1.25) * NB | 0) % NB;
    const cw = Math.min(30, (centerD - 900) / 30);
    gemScore[cb] += cw; gemScore[(cb + 1) % NB] += cw * 0.6; gemScore[(cb + NB - 1) % NB] += cw * 0.6;
  }

  // --- decision cadence: recompute the target heading only every CFG.tickMs (models
  // human reaction cadence), with a chance per tick to miss the dodge read entirely
  // (keep stale heading), then queue the decision to land reactDelayMs later. ---
  if (now - lastTickAt >= CFG.tickMs) {
    lastTickAt = now;
    const missedThisTick = CFG.missChance > 0 && Math.random() < CFG.missChance;
    if (!missedThisTick) {
      let bestB = 0, bestScore = -1e18;
      for (let b = 0; b < NB; b++) {
        const a = (b / NB - 0.25) * Math.PI * 2;
        const px = p.x + Math.cos(a) * 400, py = p.y + Math.sin(a) * 400;
        let wall = 0;
        if (px < 60 || px > 3740 || py < 60 || py > 3740) wall = 40;
        else if (px < 250 || px > 3550 || py < 250 || py > 3550) wall = 8;
        const score = -danger[b] * SKILL - wall + gemScore[b] * gemW;
        if (score > bestScore) { bestScore = score; bestB = b; }
      }
      curTargetAng = (bestB / NB - 0.25) * Math.PI * 2;
    }
    decisionQueue.push({ readyAt: now + CFG.reactDelayMs, ang: curTargetAng });
  }
  // pop the most recent decision whose delay has elapsed (models reaction lag)
  let appliedAng = decisionQueue.length ? decisionQueue[0].ang : curTargetAng;
  while (decisionQueue.length && decisionQueue[0].readyAt <= now) {
    appliedAng = decisionQueue.shift().ang;
  }
  mouse.x = 640 + Math.cos(appliedAng) * 300;
  mouse.y = 400 + Math.sin(appliedAng) * 300;
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: mouse.x, clientY: mouse.y }));

  const t0 = process.hrtime.bigint();
  step(16.67);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const st = S.stats();
  if (st.state === "play") { updateTimeAccum += ms; updateFrames++; if (ms > peakUpdateMs) peakUpdateMs = ms;
    if (ms > 15) console.error("SPIKE " + ms.toFixed(1) + "ms t=" + st.elapsed.toFixed(1) + " enemies=" + st.enemies + " proj=" + st.projectiles + " gems=" + st.gems + " boss=" + JSON.stringify(st.boss)); }
  if (st.enemies > maxEnemies) maxEnemies = st.enemies;

  if (st.state === "levelup") {
    if (rerollsUsed === 0 && S.player.rerolls > 0 && Math.random() < 0.5) {
      els.rerollBtn.dispatchEvent(new MouseEvent("click"));
      rerollsUsed++;
    }
    const cards = els.cards.children;
    if (!cards.length) { console.error("LEVELUP with no cards!"); process.exit(1); }
    // simulated skilled-player build priority:
    //  evolution/ascension > core damage/rate passives (scaling, diminishing) >
    //  deepen 2-4 owned weapons > pick up a new weapon (breadth) > defensive
    //  passives (weighted up when hp is low) > utility passives > random
    const NAME2KEY = { Bolt: "bolt", Blades: "orbit", Beam: "beam", Aura: "aura", Nova: "nova", Glaive: "glaive", Mines: "mines", Lightning: "lightning", Scatter: "scatter" };
    const ownedCount = Object.values(S.weapons).filter(w => w.level > 0).length;
    const hpFrac = S.player.hp / S.player.maxHp;
    const pas = S.passives || {};
    const score = (c) => {
      const nm = (c.innerHTML.match(/class="name">([^<]+)</) || [])[1] || "";
      const cls = c.className;
      if (cls.includes("evo") || cls.includes("asc")) return 900 + Math.random(); // evolution/ascension: always best
      const base = nm.replace(/ [IVX]+$/, "");
      const k = NAME2KEY[base];
      if (ownedCount === 0 && k) return 500; // bootstrap: must have at least one weapon
      if (nm === "Sharpen") return 150 - (pas.dmg || 0) * 12;
      if (nm === "Overclock") return 130 - (pas.rate || 0) * 12;
      if (nm === "Plating") return (hpFrac < 0.6 ? 170 : 100) - (pas.armor || 0) * 15;
      if (nm === "Vitality") return (hpFrac < 0.6 ? 160 : 90) - (pas.hp || 0) * 12;
      if (k && S.weapons[k].level > 0) return 70 + S.weapons[k].level * 9;
      if (k) return ownedCount < 3 ? 75 : 25; // new weapon: build breadth up to ~3 core weapons
      if (nm === "Swift Boots") return 60 - (pas.speed || 0) * 7;
      if (nm === "Keen Edge") return 55 - (pas.crit || 0) * 8;
      if (nm === "Magnet") return 20 - (pas.magnet || 0) * 5;
      return Math.random() * 3;
    };
    let pick = cards[0], bs = -1;
    for (const c of cards) { const sc = score(c); if (sc > bs) { bs = sc; pick = c; } }
    if (pick.className.includes("evo")) evolutions++;
    cardPicks++;
    pick.dispatchEvent(new MouseEvent("click"));
  } else if (st.state === "chest") {
    const cards = els.chestCards.children;
    if (!cards.length) { console.error("CHEST with no cards!"); process.exit(1); }
    chestPicks++;
    cards[(Math.random() * cards.length) | 0].dispatchEvent(new MouseEvent("click"));
  } else if (st.state === "dead") dead = true;
  else if (st.state === "win") won = true;
}

const st = S.stats();
const fmt = (t) => Math.floor(t / 60) + ":" + String(Math.floor(t % 60)).padStart(2, "0");
const wl = {};
for (const k in S.weapons) if (S.weapons[k].level > 0) wl[k] = S.weapons[k].level + (S.weapons[k].evolved ? "E" : "");
console.log(JSON.stringify({
  profile: PROFILE, died: dead, won,
  time: fmt(st.elapsed), kills: st.kills, level: S.player.level, hp: Math.round(S.player.hp),
  runCoins: st.runCoins, cardPicks, chestPicks, rerollsUsed, evolutions,
  bosses: bossLog, maxEnemies,
  avgFrameMs: +(updateTimeAccum / updateFrames).toFixed(3), peakFrameMs: +peakUpdateMs.toFixed(2),
  weapons: wl,
}));

if (dead) {
  step(800);
  const deathVisible = !els.deathScreen._cls.has("hidden");
  const dmgRows = (els.dmgTable.innerHTML.match(/dmgrow/g) || []).length;
  const coinsBefore = S.coins;
  els.newRunBtn.dispatchEvent(new MouseEvent("click"));
  step(16.67);
  const st2 = S.stats();
  console.log(JSON.stringify({
    deathOverlayShown: deathVisible, dmgTableRows: dmgRows, coinsBanked: coinsBefore,
    persistedCoins: JSON.parse(localStorage.getItem("swarm_coins") || "0"),
    afterNewRun: { state: st2.state, elapsed: +st2.elapsed.toFixed(2), enemies: st2.enemies, hp: S.player.hp, level: S.player.level, runCoins: st2.runCoins },
  }));
}
