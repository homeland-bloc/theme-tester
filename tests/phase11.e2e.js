// Phase 11 browser checks on the stubbed-network harness. Run with:
//   OPH_VENDOR=<dir containing node_modules/{react,react-dom,@babel/standalone}> node tests/phase11.e2e.js
// NOTHING live is contacted (see tests/e2e_harness.js). Prints SKIP and exits 0 when the harness cannot run.
const H = require("./e2e_harness.js");
const { row } = H;

const TILESETS = [{ id: "ts-0", name: "Snowtel Gifts", seed_id: 0, is_published: true, owner_id: "u1", folder_path: "Snow", profiles: { username: "tester" } }];
const U = n => `a0000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const TILES = { "ts-0": [
  row(U(1), "ts-0", "Wall1", { sort_index: 1 }),
  row(U(2), "ts-0", "Crate", { symbol: "Z", sort_index: 2 }),
  row(U(3), "ts-0", "Spotlight", { sort_index: 3 }),
  row(U(4), "ts-0", "Fence_h", { folder_key: "Fence", sensor_code: "00011000", sort_index: 4 }),
  row(U(5), "ts-0", "Fence_v", { folder_key: "Fence", sensor_code: "01000010", sort_index: 5 }),
] };

(async () => {
  const h = await H.start({ tilesets: TILESETS, tiles: TILES, role: "user" });
  const { test, newPage, ready, settle, assert, requests } = h;
  const clean = logs => logs.filter(l => !/Failed to load resource|\[BABEL\]/.test(l));

  await test("Backfill symbols: preview says what it will set / cannot decide, applies only empty symbols, sensor folder in one PATCH, nothing else touched", async () => {
    const { page, ctx, logs } = await newPage();
    await ready(page); await settle(page);
    await page.click("button[title='Tileset settings']");
    await page.click("[data-backfill-symbols]");
    await page.waitForSelector("[data-backfill-preview]");
    const summary = await page.textContent("[data-backfill-summary]");
    assert.ok(/will set 3, cannot decide 1/.test(summary), summary); // Wall1 + the two Fence rows; Spotlight undecided; Crate already has Z
    assert.ok(/Spotlight/.test(await page.textContent("[data-backfill-undecided]")));
    const before = requests.length;
    await page.click("[data-backfill-apply]"); await settle(page);
    const patches = requests.slice(before).filter(r => r.method === "PATCH");
    assert.strictEqual(patches.length, 2, JSON.stringify(patches.map(p => p.query)));
    const fence = patches.find(p => /folder_key=eq\.Fence/.test(p.query)), plain = patches.find(p => /id=in\./.test(p.query));
    assert.ok(fence && /tileset_id=eq\.ts-0/.test(fence.query) && /symbol=is\.null/.test(fence.query) && JSON.parse(fence.body).symbol === "N");
    assert.ok(plain && plain.query.includes(U(1)) && !plain.query.includes(U(2)) && /symbol=is\.null/.test(plain.query) && JSON.parse(plain.body).symbol === "M");
    assert.deepStrictEqual(clean(logs), []);
    await ctx.close();
  });

  await test("tile modal: an empty, untouched symbol takes the codename's symbol on blur; a typed symbol is never overwritten", async () => {
    const { page, ctx } = await newPage();
    await ready(page); await settle(page);
    await page.click(`[data-tile-info="d:${U(3)}"]`);
    await page.waitForSelector("[data-symbol]");
    await page.locator("input[placeholder='Enter codename…'], input[value='Spotlight']").first().fill("Wall1_new");
    await page.locator("input[value='Wall1_new']").blur();
    assert.strictEqual(await page.inputValue("[data-symbol]"), "M");
    await page.fill("[data-symbol]", "Q");
    await page.locator("input[value='Wall1_new']").fill("Crate_new");
    await page.locator("input[value='Crate_new']").blur();
    assert.strictEqual(await page.inputValue("[data-symbol]"), "Q", "typed symbol stays");
    await ctx.close();
  });

  await h.finish();
})();
