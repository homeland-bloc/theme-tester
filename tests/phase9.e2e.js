// Phase 9 browser checks on the stubbed-network harness. Run with:
//   OPH_VENDOR=<dir containing node_modules/{react,react-dom,@babel/standalone}> node tests/phase9.e2e.js
// NOTHING live is contacted (see tests/e2e_harness.js). Prints SKIP and exits 0 when the harness cannot run.
const H = require("./e2e_harness.js");
const MapSeed = require("../map_seed.js");
const { row } = H;

const TILESETS = [
  { id: "ts-0", name: "Snowtel Gifts", seed_id: 0, is_published: true, owner_id: "u1", folder_path: "Snow", profiles: { username: "tester" } },
  { id: "ts-7", name: "Desert", seed_id: 7, is_published: true, owner_id: null, folder_path: "Desert", profiles: null },
  { id: "ts-9", name: "Ancient Hell", seed_id: 9, is_published: true, owner_id: null, folder_path: "Ancient", profiles: null },
];
const U = (n, ts = "a") => `${ts}0000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const TILES = {
  "ts-0": [
    row(U(1), "ts-0", "Wall1", { symbol: "M", sort_index: 1 }),
    row(U(2), "ts-0", "Crate", { symbol: "Y", sort_index: 2 }),
    row(U(3), "ts-0", "ObjA", { symbol: "8", sort_index: 3 }),
    row(U(4), "ts-0", "ObjB", { symbol: "8", sort_index: 4 }),
    row(U(5), "ts-0", "NoSymbol", { sort_index: 5 }),
    row(U(6), "ts-0", "Walls_00000000", { folder_key: "Walls", sensor_code: "00000000", symbol: "X", sort_index: 6 }),
    row(U(7), "ts-0", "Walls_11111111", { folder_key: "Walls", sensor_code: "11111111", symbol: "X", sort_index: 7 }),
    row(U(8), "ts-0", "Taker", { symbol: "T", sort_index: 8 }),
  ],
  "ts-7": [
    row(U(1, "b"), "ts-7", "Wall1", { symbol: "M", sort_index: 1 }),
    row(U(2, "b"), "ts-7", "Cactus", { symbol: "T", sort_index: 2 }),
    row(U(3, "b"), "ts-7", "Crate", { symbol: "Y", sort_index: 3 }),
    // a sensor folder with a shared-code pool (rerollable) and diverging symbols (the warning button)
    row(U(4, "b"), "ts-7", "Bars_b", { folder_key: "Bars", sensor_code: "11111111", symbol: "k", sort_index: 11 }),
    row(U(5, "b"), "ts-7", "Bars_a", { folder_key: "Bars", sensor_code: "11111111", symbol: "j", sort_index: 10 }),
    row(U(6, "b"), "ts-7", "Bars_0", { folder_key: "Bars", sensor_code: "00000000", symbol: "j", sort_index: 12 }),
  ],
  // Ancient Hell keeps its Crate as a sensor folder
  "ts-9": [
    row(U(1, "c"), "ts-9", "Wall1", { symbol: "M", sort_index: 1 }),
    row(U(2, "c"), "ts-9", "Crate_00000000", { folder_key: "Crate", sensor_code: "00000000", symbol: "Y", sort_index: 2 }),
    row(U(3, "c"), "ts-9", "Crate_11111111", { folder_key: "Crate", sensor_code: "11111111", symbol: "Y", sort_index: 3 }),
  ],
};

(async () => {
  const h = await H.start({ tilesets: TILESETS, tiles: TILES, role: "admin" });
  const { test, newPage, ready, settle, assert } = h;
  const settle_ = settle;
  const clean = logs => logs.filter(l => !/Failed to load resource|\[BABEL\]/.test(l));

  await test("symbols: tile modal shows 'taken by', no 6/7 hint, dictionary opens; global tiles and warn/space show read-only symbols", async () => {
    const { page, ctx, logs } = await newPage();
    await ready(page);
    await page.click(`[data-tile-info="d:${U(5)}"]`);
    await page.waitForSelector("[data-symbol]");
    const hint = () => page.textContent("[data-symbol-hint]");
    assert.ok(!/6 = warn/.test(await hint()), "old 6/7 hint is gone");
    await page.fill("[data-symbol]", "T");
    assert.ok(/taken by .*(Taker|Cactus)/.test(await hint()), await hint());
    await page.fill("[data-symbol]", "K");
    assert.ok(/taken by Jumppad T \(global\)/.test(await hint()), await hint());
    await page.fill("[data-symbol]", "6");
    assert.ok(/taken by Spawn 6 \(global\)/.test(await hint()) && !/reserved/.test(await hint()), "6 is an ordinary (spawn) symbol now: " + await hint());
    await page.fill("[data-symbol]", "A");
    assert.ok(/reserved for the warn tile/.test(await hint()), await hint());
    await page.fill("[data-symbol]", "S");
    assert.ok(/reserved for the space tile/.test(await hint()), await hint());
    await page.click("[data-symbol-dict-open]");
    await page.waitForSelector("[data-symbol-dict-modal]");
    const dict = await page.textContent("[data-symbol-dict-modal]");
    assert.ok(/Official table/.test(dict) && /Global tileset/.test(dict) && /Snowtel Gifts/.test(dict) && /Free symbols/.test(dict), dict.slice(0, 300));
    assert.ok(await page.locator("[data-symbol-row='A']").count() === 1 && await page.locator("[data-symbol-row='H']").count() === 1);
    await page.click("[data-symbol-dict-modal] button");
    // global tile: file name + symbol read-only
    await page.keyboard.press("Escape");
    await ctx.close();
  });

  await test("symbols: a global tile's info modal shows its image file name and symbol read-only", async () => {
    const { page, ctx } = await newPage();
    await ready(page);
    await page.click("[data-folder-card='global_spawns']");
    await page.locator("[data-tile-info='g:Resources/Global/Spawns/3.png']").first().click({ force: true });
    await page.waitForSelector("[data-global-file]");
    assert.strictEqual(await page.inputValue("[data-global-file]"), "3.png");
    assert.strictEqual(await page.inputValue("[data-global-symbol]"), "3");
    assert.strictEqual(await page.getAttribute("[data-global-symbol]", "readonly"), "");
    await ctx.close();
  });

  await test("symbols: Warn and Space info modals show A / S read-only", async () => {
    const { page, ctx } = await newPage();
    await ready(page);
    for (const [tool, sym] of [["warn", "A"], ["space", "S"]]) {
      await page.click(`[data-tool-info="${tool}"]`);
      await page.waitForSelector("[data-symbol-readonly]");
      assert.strictEqual(await page.inputValue("[data-symbol-readonly]"), sym);
      assert.strictEqual(await page.getAttribute("[data-symbol-readonly]", "readonly"), "");
      await page.click(".modal-box button >> text=×");
    }
    await ctx.close();
  });

  await test("Map seed: one button opens a modal with box, Copy seed, Copy share link, Import, Clear, format help, breakdown and blank warning", async () => {
    const { page, ctx, logs } = await newPage();
    await page.waitForSelector("[data-map-seed-open]");
    assert.strictEqual(await page.locator("[data-seed-row] button").count(), 1, "the crowded row is a single button");
    assert.strictEqual(await page.locator("[data-seed-input]").count(), 0);
    await page.click("[data-map-seed-open]");
    for (const sel of ["[data-seed-input]", "[data-seed-copy]", "[data-seed-link]", "[data-seed-import]", "[data-seed-clear]", "[data-seed-help]"]) assert.ok(await page.locator(sel).isVisible(), sel);
    await page.fill("[data-seed-input]", "3v3/x/4/0//8ZX");
    await page.waitForSelector("[data-seed-breakdown]");
    assert.ok(/21 x 33/.test(await page.textContent("[data-seed-breakdown]")));
    await page.click("[data-seed-clear]");
    assert.strictEqual(await page.inputValue("[data-seed-input]"), "");
    assert.strictEqual(await page.locator("[data-seed-breakdown]").count(), 0);
    assert.ok(await page.locator("[data-seed-import]").isDisabled());
    await page.click("[data-seed-copy]"); await settle(page);
    assert.strictEqual(await page.evaluate(() => navigator.clipboard.readText()), "3v3/x/4/0//8ZX");
    await page.click("[data-seed-box-close]");
    assert.strictEqual(await page.locator("[data-seed-box]").count(), 0);
    assert.deepStrictEqual(clean(logs), []);
    await ctx.close();
  });

  const palette = sv => sv.grid.palette;
  const switchTo = async (page, name) => { await page.click("[data-ts-toggle]"); await page.click(`[data-ts-option="${name}"]`); await settle(page); };
  const gridWith = refs => ({ oph_gridW: 3, oph_gridH: 3, oph_grid: { v: 2, palette: refs, grid: [[1, 1, null], [null, refs.length > 1 ? 2 : 1, null], [null, null, null]] } });

  await test("tileset switch: a Crate from another tileset becomes the Crate sensor folder, and back to a plain Crate, with no compat modal", async () => {
    const { page, ctx, logs } = await newPage({ storage: gridWith([`d:${U(2)}`]) });
    await ready(page); await settle(page);
    await switchTo(page, "Ancient Hell");
    assert.strictEqual(await page.locator("[data-compat-modal]").count(), 0);
    let sv = await h.saved(page);
    assert.deepStrictEqual(palette(sv), ["s:ts-9|Crate"], JSON.stringify(sv.grid));
    assert.strictEqual(sv.ts, "Ancient Hell");
    await switchTo(page, "Desert");
    assert.strictEqual(await page.locator("[data-compat-modal]").count(), 0);
    sv = await h.saved(page);
    assert.deepStrictEqual(palette(sv), [`d:${U(3, "b")}`], "back to the plain Crate of Desert");
    assert.deepStrictEqual(clean(logs), []);
    await ctx.close();
  });

  const BARS = "s:ts-7|Bars";
  const desert = { oph_active_ts: JSON.stringify("Desert"), oph_gridW: 3, oph_gridH: 3, oph_grid: { v: 2, palette: [BARS], grid: [[1, 1, 1], [1, 1, 1], [null, null, null]] } };
  const countImgs = (page, name) => page.locator(`img[src$="${name}.png"]`).count();

  await test("reroll controls: ON/OFF toggle per folder, dice opens 'Choose variants' when OFF, picks and Auto change the map, ON restores random", async () => {
    const { page, ctx, logs } = await newPage({ storage: desert });
    await ready(page); await settle(page);
    const sel = `[data-sensor-card="${BARS}"]`;
    await page.waitForSelector(sel);
    assert.strictEqual(await page.locator(`${sel} [data-sensor-reroll-mode]`).textContent().then(t => t.replace(/\s/g, "")), "ON");
    assert.strictEqual(await page.locator(`${sel} [data-sensor-reroll]`).getAttribute("data-reroll-mode"), "on");
    const baseA = await countImgs(page, "Bars_a"), baseB = await countImgs(page, "Bars_b");
    await page.click(`${sel} [data-sensor-reroll-mode]`); // OFF
    await settle(page);
    assert.strictEqual(await page.locator(`${sel} [data-sensor-reroll-mode]`).textContent().then(t => t.replace(/\s/g, "")), "OFF");
    // OFF + Auto: all six cells use the lowest sortIndex variant (Bars_a, 10); no card click side effects
    const offA = await countImgs(page, "Bars_a"), offB = await countImgs(page, "Bars_b");
    assert.strictEqual(offB, baseB - (baseB - offB), "sanity");
    assert.ok(offA >= baseA && offB <= baseB, `OFF + Auto: every cell is Bars_a (a ${baseA}->${offA}, b ${baseB}->${offB})`);
    await page.click(`${sel} [data-sensor-reroll]`); // dice while OFF -> the modal
    await page.waitForSelector(`[data-variants-modal="${BARS}"]`);
    assert.ok(await page.locator("[data-variants-pool='11111111']").count() === 1);
    assert.ok(/Auto \(Bars_a\)/.test(await page.locator("[data-variants-select]").first().textContent()));
    await page.selectOption("[data-variants-select='11111111']", `d:${U(4, "b")}`);
    await page.click("[data-variants-close]"); await settle(page);
    const pickedB = await countImgs(page, "Bars_b");
    assert.strictEqual(pickedB - offB, 6, `the six cells now show Bars_b (${offB} -> ${pickedB})`);
    await page.click(`${sel} [data-sensor-reroll]`);
    await page.click("[data-variants-reset]");
    await page.click("[data-variants-close]"); await settle(page);
    assert.strictEqual(await countImgs(page, "Bars_b"), offB, "All Auto restores the lowest sortIndex");
    // not persisted: nothing about rerolls in storage
    const store = await page.evaluate(() => JSON.stringify(Object.assign({}, localStorage)));
    assert.ok(!/reroll|variant/i.test(store), "reroll mode and picks are session only");
    // the unfolded panel has the same controls plus the Variants button
    await page.click(`[data-sensor-unfold="${BARS}"]`);
    await page.waitForSelector(`[data-sensor-panel="${BARS}"]`);
    assert.strictEqual(await page.locator(`[data-sensor-reroll-mode-panel="${BARS}"]`).textContent(), "OFF");
    await page.click(`[data-sensor-variants-panel="${BARS}"]`);
    await page.waitForSelector(`[data-variants-modal="${BARS}"]`);
    await page.click("[data-variants-close]");
    await page.click(`[data-sensor-reroll-mode-panel="${BARS}"]`); // back ON
    assert.strictEqual(await page.locator(`[data-sensor-reroll-mode-panel="${BARS}"]`).textContent(), "ON");
    assert.deepStrictEqual(clean(logs), []);
    await ctx.close();
  });

  await test("reroll controls on mobile: ~24px visible, larger invisible tap area, clear of the corner button and the card border", async () => {
    const { page, ctx } = await newPage({ storage: desert, viewport: { width: 390, height: 800 } });
    await page.waitForSelector("text=▶", { timeout: 30000 });
    await settle(page);
    const sel = `[data-sensor-card="${BARS}"]`;
    await page.locator("text=▶").first().click(); // the left rail's arrow opens the Tiles panel on a phone
    await page.waitForSelector(sel);
    const box = loc => page.locator(loc).first().boundingBox();
    const card = await box(sel), dice = await box(`${sel} [data-sensor-reroll]`), tog = await box(`${sel} [data-sensor-reroll-mode]`), corner = await box(`${sel} [data-sensor-unfold]`);
    assert.ok(dice.width <= 26 && dice.height <= 26 && dice.width >= 20, JSON.stringify(dice));
    assert.ok(tog.width <= 26 && tog.height <= 26, JSON.stringify(tog));
    const tap = await page.locator(`${sel} [data-sensor-reroll] span[aria-hidden]`).boundingBox();
    assert.ok(tap.width >= 30 && tap.height >= 30, "invisible tap area is larger: " + JSON.stringify(tap));
    const inside = b => b.x >= card.x && b.y >= card.y && b.x + b.width <= card.x + card.width && b.y + b.height <= card.y + card.height;
    assert.ok(inside(dice) && inside(tog), "inside the card border");
    const hit = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    assert.ok(!hit(dice, corner) && !hit(tog, corner), "clear of the corner button");
    assert.ok(!hit(dice, tog), "dice and toggle do not overlap");
    // the invisible area stays inside the card too (does not cover the selection outline)
    assert.ok(tap.x >= card.x - 1 && tap.y + tap.height <= card.y + card.height + 1, JSON.stringify([tap, card]));
    await ctx.close();
  });

  await test("the global Rails folder shows neither dice nor toggle (manifest reroll:false)", async () => {
    const { page, ctx } = await newPage({ storage: desert });
    await ready(page); await settle(page);
    await page.waitForSelector("[data-sensor-card='s:global|rails']");
    assert.strictEqual(await page.locator("[data-sensor-card='s:global|rails'] [data-sensor-reroll]").count(), 0);
    assert.strictEqual(await page.locator("[data-sensor-card='s:global|rails'] [data-sensor-reroll-mode]").count(), 0);
    await page.click("[data-sensor-unfold='s:global|rails']");
    await page.waitForSelector("[data-sensor-panel='s:global|rails']");
    assert.strictEqual(await page.locator("[data-sensor-reroll-mode-panel]").count(), 0);
    await ctx.close();
  });

  // Plain (Wall1), sensor folder (Walls, with a composed/derived neighbourhood) and global tiles (spawn, water folder) on the map.
  const MIX = { oph_gridW: 5, oph_gridH: 4, oph_grid: { v: 2, palette: [`d:${U(1)}`, "s:ts-0|Walls", "Resources/Global/Spawns/1.png", "s:global|water", "s:global|rails"], grid: [[1, 2, 2, 3, 4], [1, 2, 2, 3, 4], [5, null, 1, null, 5], [null, 1, null, 2, null]] } };
  const clickTool = async (page, label) => { await page.getByText(label, { exact: label.length <= 4 && label !== "Fill" && label !== "Line" }).first().click({ timeout: 5000 }); await page.waitForTimeout(250); };
  const closeModal = async page => {
    for (let i = 0; i < 3 && await page.locator(".modal-backdrop").count(); i++) {
      const x = page.locator(".modal-backdrop button:has-text('×')").first();
      if (await x.count()) await x.click(); else await page.keyboard.press("Escape");
      await page.waitForTimeout(150);
    }
  };

  await test("OTG Check with plain, sensor and global tiles on the map does not throw (the 'reading current' crash)", async () => {
    const { page, ctx, logs } = await newPage({ storage: MIX });
    await ready(page); await settle(page);
    await clickTool(page, "OTG Check");
    await page.waitForTimeout(600);
    assert.deepStrictEqual(clean(logs), [], "no render error");
    assert.ok(await page.locator("[data-seed-row]").count() > 0, "the app is still rendered");
    // it also survives a map edit and a sensor-layer change while OTG is on (reroll mode toggle, undo)
    await page.keyboard.press("z"); await page.waitForTimeout(300);
    await clickTool(page, "OTG Check"); // off again
    assert.deepStrictEqual(clean(logs), []);
    await ctx.close();
  });

  await test("smoke: every Tools-section button can be clicked on a map with plain, sensor and global tiles without an error", async () => {
    const { page, ctx, logs } = await newPage({ storage: MIX });
    await ready(page); await settle(page);
    const tools = ["Single", "Line", "Rectangle", "Fill", "Horizontal", "Vertical", "Diagonal", "Guides", "Mirror Spawns", "Block Overwrite", "Offset Centers", "OTG Check", "Replace", "Convert", "Tile Counter", "Hotkeys"];
    const failed = [];
    for (const label of tools) {
      try { await clickTool(page, label); await closeModal(page); } catch (e) { failed.push(label + ": " + String(e.message).split("\n")[0]); }
      const errs = clean(logs); if (errs.length) { failed.push(label + " -> " + errs[0].split("\n")[0]); logs.length = 0; }
    }
    // toggle the toggles back off, plus undo / redo / zoom
    for (const label of ["Horizontal", "Vertical", "Diagonal", "Guides", "Block Overwrite", "Offset Centers", "OTG Check"]) { try { await clickTool(page, label); } catch {} }
    for (const label of ["Undo", "Redo", "+", "−"]) { // bottom bar: only an ENABLED button is clicked (Undo / Redo may be disabled)
      const b = page.locator("button").filter({ hasText: label }).filter({ has: page.locator("xpath=self::*[normalize-space(.)=\"" + label + "\"]") }).first();
      if (await b.count() && await b.isEnabled()) await b.click({ timeout: 5000 });
      await page.waitForTimeout(200);
    }
    const errs = clean(logs); if (errs.length) failed.push("end -> " + errs[0].split("\n")[0]);
    assert.deepStrictEqual(failed, []);
    await ctx.close();
  });

  await test("Tools: no Tools Settings modal; Mirror Spawns is its own starrable toggle (on by default); Memory moved to the Tiles settings", async () => {
    const { page, ctx, logs } = await newPage();
    await ready(page);
    assert.strictEqual(await page.locator("[title='Mirroring settings']").count(), 0, "the Tools gear is gone");
    assert.strictEqual(await page.getAttribute("[data-mirror-spawns]", "aria-pressed"), "true");
    await page.click("[data-mirror-spawns]");
    assert.strictEqual(await page.getAttribute("[data-mirror-spawns]", "aria-pressed"), "false");
    await page.click("[data-mirror-spawns]");
    assert.strictEqual(await page.getAttribute("[data-mirror-spawns]", "aria-pressed"), "true");
    // starrable through its info modal (a badge emoji is the shortcut)
    await page.locator("[data-mirror-spawns] + span").click();
    await page.waitForSelector(".modal-box >> text=Mirror Spawns");
    await page.locator(".modal-box label:has-text('Starred shortcut') input").check();
    await page.click(".modal-box button:has-text('×')");
    assert.ok(await page.locator("[title^='Mirror Spawns'], button:has-text('🚩')").count() > 0, "the starred shortcut shows the 🚩 badge");
    assert.ok(JSON.parse(await page.evaluate(() => localStorage.getItem("oph_starred") || "[]")).includes("mirrorSpawns"));
    // Memory… is reachable from the Tiles settings modal
    await page.click("[title='Tile panel settings']");
    await page.click("[data-memory-open]");
    await page.waitForSelector(".modal-box >> text=Storage Usage");
    assert.deepStrictEqual(clean(logs), []);
    await ctx.close();
  });

  await test("mobile: the tileset list extends over the tiles area (wider than the panel) and stays on screen", async () => {
    const { page, ctx } = await newPage({ viewport: { width: 390, height: 800 } });
    await page.waitForSelector("text=▶", { timeout: 30000 }); await settle(page);
    await page.locator("text=▶").first().click();
    await page.waitForSelector("[data-ts-toggle]");
    const btnBox = await page.locator("[data-ts-toggle]").boundingBox();
    await page.click("[data-ts-toggle]");
    await page.waitForSelector("[data-ts-list]");
    const list = await page.locator("[data-ts-list]").boundingBox();
    assert.ok(list.width > btnBox.width + 20, `list ${list.width} wider than the button ${btnBox.width}`);
    assert.ok(list.x >= 0 && list.x + list.width <= 390, "inside the screen");
    const opt = await page.locator("[data-ts-option='Snowtel Gifts']").boundingBox();
    const sw = await page.locator("[data-ts-option='Snowtel Gifts'] [data-ts-bg]").boundingBox();
    assert.ok(sw.x + sw.width <= list.x + list.width && opt.width >= 200, "colour squares and name fit");
    await ctx.close();
  });

  await h.finish();

  // Effective role: the ⚖️ warning button is for editors only (a plain user does not see it; the owner/admin does)
  const hu = await H.start({ tilesets: TILESETS, tiles: TILES, role: "user" });
  await hu.test("the sensor folder warning button is hidden from non-editors and shown to admins", async () => {
    const { page, ctx } = await hu.newPage({ storage: desert });
    await hu.ready(page); await hu.settle(page);
    await page.click(`[data-sensor-unfold="${BARS}"]`);
    await page.waitForSelector(`[data-sensor-panel="${BARS}"]`);
    assert.strictEqual(await page.locator("[data-sensor-warn]").count(), 0, "plain user");
    await ctx.close();
  });
  await hu.finish();
  const ha = await H.start({ tilesets: TILESETS, tiles: TILES, role: "admin" });
  await ha.test("the sensor folder warning button is shown to admins", async () => {
    const { page, ctx } = await ha.newPage({ storage: desert });
    await ha.ready(page); await ha.settle(page);
    await page.click(`[data-sensor-unfold="${BARS}"]`);
    await page.waitForSelector(`[data-sensor-panel="${BARS}"]`);
    assert.strictEqual(await page.locator("[data-sensor-warn]").count(), 1);
    await ctx.close();
  });
  await ha.finish();
})();

// ── Duplicate tile ───────────────────────────────────────────────────────────────────────────────────
const assert = require("assert");
(async () => {
  let failUpload = false;
  const hd = await H.start({ tilesets: TILESETS, tiles: TILES, role: "admin", onWorker: async (route, url, reply) => {
    const m = route.request().method();
    if (url.pathname === "/rest/v1/tiles" && m === "POST") { reply(201, [{ id: "new-row-1" }]); return true; }
    if (url.pathname === "/rest/v1/tiles" && m === "DELETE") { reply(204, ""); return true; }
    if (url.pathname === "/github/upload") { if (failUpload) reply(500, { error: "boom" }); else reply(200, { ok: true }); return true; }
    return false;
  } });
  const BARS = "s:ts-7|Bars";
  const store = { oph_active_ts: JSON.stringify("Desert") };
  const openVariantInfo = async page => {
    await page.waitForSelector(`[data-sensor-unfold="${BARS}"]`);
    await page.click(`[data-sensor-unfold="${BARS}"]`);
    await page.click(`[data-tile-info="d:${U(5, "b")}"]`); // Bars_a
    await page.waitForSelector("[data-duplicate]");
  };
  await hd.test("Duplicate tile > This tileset: DB row first (new codename, same pool, flags, symbol, next sortIndex), then its own image file via /github/upload", async () => {
    const { page, ctx } = await hd.newPage({ storage: store });
    await hd.ready(page); await hd.settle(page);
    await openVariantInfo(page);
    hd.requests.length = 0;
    await page.click("[data-duplicate-tileset]");
    await page.waitForFunction(() => /Created Bars_a_copy \(Bars_11111111\.png\)/.test(document.body.textContent));
    const posts = hd.requests.filter(r => r.method === "POST" && (r.path === "/rest/v1/tiles" || r.path === "/github/upload"));
    assert.deepStrictEqual(posts.map(r => r.path), ["/rest/v1/tiles", "/github/upload"], "row first, then the file");
    const row = JSON.parse(posts[0].body), up = JSON.parse(posts[1].body);
    assert.deepStrictEqual([row.tileset_id, row.codename, row.folder_key, row.sensor_code, row.symbol, row.sort_index], ["ts-7", "Bars_a_copy", "Bars", "11111111", "j", 13]);
    assert.ok(row.image_url.includes("Bars_11111111.png") && !row.image_url.includes("stub.invalid"), row.image_url);
    assert.strictEqual(up.filePath, "Resources/Desert/Bars_11111111.png");
    assert.strictEqual(up.overwrite, false);
    assert.ok(up.contentBase64 && up.contentBase64.length > 20, "the image bytes are sent");
    await ctx.close();
  });
  await hd.test("Duplicate tile: a failed upload deletes the new row again and says so", async () => {
    failUpload = true;
    const { page, ctx } = await hd.newPage({ storage: store });
    await hd.ready(page); await hd.settle(page);
    await openVariantInfo(page);
    hd.requests.length = 0;
    await page.click("[data-duplicate-tileset]");
    await page.waitForSelector("[data-duplicate-msg]");
    assert.ok(/the copy was not created/.test(await page.textContent("[data-duplicate-msg]")), await page.textContent("[data-duplicate-msg]"));
    assert.ok(hd.requests.some(r => r.method === "DELETE" && r.query.includes("id=eq.new-row-1")), "cleanup DELETE sent");
    failUpload = false;
    await ctx.close();
  });
  await hd.test("Duplicate tile > Local uploads: a new u:<n> tile appears (canvas copy, max 256px)", async () => {
    const { page, ctx } = await hd.newPage({ storage: store });
    await hd.ready(page); await hd.settle(page);
    await openVariantInfo(page);
    await page.click("[data-duplicate-local]");
    await page.waitForSelector("[data-duplicate-msg]");
    assert.ok(/Added to Local uploads \(1x1\)/.test(await page.textContent("[data-duplicate-msg]")), await page.textContent("[data-duplicate-msg]"));
    await hd.settle(page);
    const tiles = JSON.parse(await page.evaluate(() => localStorage.getItem("oph_user_tiles") || "[]"));
    assert.strictEqual(tiles.length, 1);
    assert.ok(/^data:image\/png/.test(tiles[0].src));
    await ctx.close();
  });
  await hd.finish();
})();
