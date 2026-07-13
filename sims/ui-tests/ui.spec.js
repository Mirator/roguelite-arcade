const { test, expect } = require("@playwright/test");

async function noOverflow(page){
  const size = await page.evaluate(() => ({sw:document.documentElement.scrollWidth, iw:innerWidth, sh:document.documentElement.scrollHeight, ih:innerHeight}));
  expect(size.sw, `horizontal overflow: ${JSON.stringify(size)}`).toBeLessThanOrEqual(size.iw + 1);
}

async function visibleInsideViewport(page, selector){
  const el = page.locator(selector).first();
  await expect(el).toBeVisible();
  const b = await el.boundingBox();
  const vp = page.viewportSize();
  expect(b.x).toBeGreaterThanOrEqual(-1); expect(b.y).toBeGreaterThanOrEqual(-1);
  expect(b.x+b.width).toBeLessThanOrEqual(vp.width+1); expect(b.y+b.height).toBeLessThanOrEqual(vp.height+1);
}

async function startDepths(page){
  await page.waitForFunction(() => window.__D && window.__D.titleL && window.__D.titleL.cards.length);
  const p = await page.evaluate(() => { const r=window.__D.titleL.cards[0].rect; return {x:r.x+r.w/2,y:r.y+r.h/2}; });
  await page.mouse.click(p.x,p.y); await page.waitForFunction(() => window.__D.screen === "game");
  const h=page.locator('#tutorialOk');if(await h.isVisible())await h.click();
}
async function startSwarm(page){ await page.locator("#startBtn").click(); const h=page.locator("#steerHintClose"); if(await h.isVisible())await h.click(); await expect(page.locator("#pauseBtn")).toBeVisible(); }
async function startLoopline(page){ await page.locator('[data-act="start"]').click(); const h=page.locator("#tutorial-ok"); if(await h.isVisible())await h.click(); await expect(page.locator("#btn-retreat")).toBeVisible(); }
async function startWarband(page){
  await page.locator('[data-act="start-run"]').first().click();
  await page.locator('[data-act="pick-cmd"]').first().click();
  const got=page.locator('[data-act="rules-close"]'); if(await got.isVisible())await got.click();
  await page.locator('[data-act="map-node"]').first().click();
  await expect(page.locator("#fightBtn")).toBeVisible();
}
async function startDungeon(page){ await page.locator("#btn-start").click(); const h=page.locator("#btn-tutorial-ok"); if(await h.isVisible())await h.click(); await page.waitForTimeout(900); await expect(page.locator('#board [role="button"]').first()).toBeVisible(); }

const games = [
  {name:"Depths", path:"/games/depths.html", start:startDepths, primary:"canvas", nav:"#navBtns", menu:"#menuBtn", menuPanel:"#menuOverlay", resume:"#mResume", mute:"#muteBtn"},
  {name:"Swarm", path:"/games/swarm.html", start:startSwarm, primary:"#pauseBtn", nav:"#arcadeBtn", menu:"#pauseBtn", menuPanel:"#pauseScreen", resume:"#resumeBtn", mute:"#muteBtn"},
  {name:"Loopline", path:"/games/loopline.html", start:startLoopline, primary:"#btn-retreat", nav:"#arcadebtn", menu:"#btn-menu", menuPanel:"#menuov", resume:'[data-mact="resume"]'},
  {name:"Warband", path:"/games/warband.html", start:startWarband, primary:"#fightBtn", nav:'#navBtns a[href="../index.html"]', menu:"#menuBtn", menuPanel:"#menuOv", resume:'[data-act="menu-close"]', mute:"#muteBtn"},
  {name:"Dungeon Deal", path:"/games/dungeondeal.html", start:startDungeon, primary:'#board [role="button"]', nav:'#navbtns a[href="../index.html"]', menu:"#btn-menu", menuPanel:"#menu", resume:"#menu-resume", mute:"#btn-mute"},
];

test.beforeEach(async ({page}) => { await page.addInitScript(() => localStorage.clear()); });

test("hub cards are concise, explicit, and unclipped", async ({page}, info) => {
  await page.goto("/"); await noOverflow(page);
  await expect(page.locator(".card")).toHaveCount(5);
  await expect(page.locator(".play")).toHaveCount(5);
  await visibleInsideViewport(page,".card");
  if(info.project.name === "mobile-390"){
    const min = await page.locator(".card").first().evaluate(el=>({w:el.getBoundingClientRect().width,h:el.getBoundingClientRect().height}));
    expect(min.h).toBeGreaterThanOrEqual(44);
  }
});

for(const game of games){
  test(`${game.name}: title to first playable state stays usable`, async ({page}, info) => {
    await page.goto(game.path); await noOverflow(page); await visibleInsideViewport(page,game.nav);
    await game.start(page); await noOverflow(page); await visibleInsideViewport(page,game.primary);
    const arcade = page.locator('a[href="../index.html"]').first(); await expect(arcade).toHaveAttribute("aria-label",/arcade/i);
    if(info.project.name === "desktop-1440"){
      if(game.mute){const before=await page.locator(game.mute).textContent();await page.locator(game.mute).click();expect(await page.locator(game.mute).textContent()).not.toBe(before);}
      await page.locator(game.menu).click();await expect(page.locator(game.menuPanel)).toBeVisible();await expect(page.locator(game.menuPanel).getByText(/Arcade/)).toBeVisible();await page.locator(game.resume).click();
    }
    if(info.project.name === "mobile-390"){
      const targets = await page.locator('#navBtns a,#navBtns button,#navbtns a,#navbtns button,.topbtn,#homebtn,#arcadebtn').evaluateAll(els=>els.filter(e=>getComputedStyle(e).display!=="none").map(e=>({w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height})));
      for(const t of targets){expect(t.w).toBeGreaterThanOrEqual(43);expect(t.h).toBeGreaterThanOrEqual(43);}
      if(game.name === "Dungeon Deal"){
        const overlaps=await page.evaluate(()=>{const nav=[...document.querySelectorAll('#navbtns>*')].map(e=>e.getBoundingClientRect());const hud=[...document.querySelectorAll('#topbar .logo,#topbar .chip')].map(e=>e.getBoundingClientRect());return nav.some(a=>hud.some(b=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top));});
        expect(overlaps).toBe(false);
      }
    }
    await page.locator('a[href="../index.html"]:visible').first().click();await expect(page).toHaveURL(/\/index\.html$/);
  });
}

test("keyboard focus reveals Dungeon Deal outcome details", async ({page}, info) => {
  test.skip(info.project.name !== "desktop-1440");
  await page.goto("/games/dungeondeal.html"); await startDungeon(page);
  const target=page.locator('#board [role="button"]').first(); await target.focus();
  await expect(page.locator("#tooltip")).toBeVisible();
  const before=await page.evaluate(()=>DD.state.heroCell); await page.keyboard.press("Enter");
  await page.waitForTimeout(80); expect(await page.evaluate(()=>DD.state.heroCell)).not.toBe(before);
});

test("coarse pointer previews Dungeon Deal before confirming", async ({page}, info) => {
  test.skip(info.project.name !== "mobile-390");
  await page.goto("/games/dungeondeal.html"); await startDungeon(page);
  const target=page.locator('#board [role="button"]').first(); const before=await page.evaluate(()=>DD.state.heroCell);
  await target.click(); expect(await page.evaluate(()=>DD.state.heroCell)).toBe(before); await expect(page.locator("#tooltip")).toBeVisible();
  await target.click(); await page.waitForTimeout(80); expect(await page.evaluate(()=>DD.state.heroCell)).not.toBe(before);
});

test("reduced motion disables long UI animation", async ({page}, info) => {
  test.skip(info.project.name !== "desktop-1440");
  await page.emulateMedia({reducedMotion:"reduce"}); await page.goto("/games/warband.html");
  const duration=await page.locator(".logo").evaluate(el=>getComputedStyle(el).animationDuration);
  expect(parseFloat(duration)||0).toBeLessThan(0.01);
  await info.attach("reduced-motion",{body:await page.screenshot(),contentType:"image/png"});
});

test("reliable gameplay glyph fallbacks render without emoji support", async ({page}, info) => {
  test.skip(info.project.name !== "mobile-390");
  await page.goto("/games/dungeondeal.html");await startDungeon(page);
  await expect(page.locator("#topbar .gold-chip")).toContainText("Gold");
  await expect(page.locator(".card.hero .c-icon")).toHaveText("@");
  await info.attach("glyph-fallbacks",{body:await page.screenshot(),contentType:"image/png"});
});
