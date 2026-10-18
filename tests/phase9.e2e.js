// Phase 9 browser checks on the stubbed-network harness. Run with:
//   OPH_VENDOR=<dir containing node_modules/{react,react-dom,@babel/standalone}> node tests/phase9.e2e.js
// NOTHING live is contacted (see tests/e2e_harness.js). Prints SKIP and exits 0 when the harness cannot run.
const H = require("./e2e_harness.js");
const MapSeed = require("../map_seed.js");
const { row } = H;

const TILESETS = [
  { id: "ts-0", name: "Snowtel Gifts", seed_id: 0, is_published: true, owner_id: "u1", folder_path: "Snow", profiles: { username: "tester" } },
  { id: "ts-7", name: "Desert", seed_id: 7, is_published: true, owner_id: null, folder_path: "Desert", profiles: null },
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

  await h.finish();
})();
