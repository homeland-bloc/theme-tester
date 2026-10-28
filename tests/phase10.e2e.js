// Phase 10 browser checks on the stubbed-network harness. Run with:
//   OPH_VENDOR=<dir containing node_modules/{react,react-dom,@babel/standalone}> node tests/phase10.e2e.js
// NOTHING live is contacted (see tests/e2e_harness.js). Prints SKIP and exits 0 when the harness cannot run.
const assert = require("assert");
const H = require("./e2e_harness.js");
const { row } = H;

const TILESETS = [{ id: "ts-0", name: "Snowtel Gifts", seed_id: 0, is_published: true, owner_id: "u1", folder_path: "Snow", profiles: { username: "tester" } }];
const MO = "a0000000-0000-4000-8000-000000000009";
const NOMO = "a0000000-0000-4000-8000-00000000000a";
const TILES = { "ts-0": [
  row("a0000000-0000-4000-8000-000000000001", "ts-0", "Wall1", { symbol: "M", sort_index: 1 }),
  row(MO, "ts-0", "Lamp", { symbol: "D", sort_index: 2, mirror_offset: true, offset_x: 10, offset_y: 20 }),
  row(NOMO, "ts-0", "Rock", { symbol: "E", sort_index: 3, mirror_offset: false, offset_x: 7, offset_y: 7 }),
] };
const JP = f => `Resources/Global/Jumppads/${f}.png`;     // stored form of a global ref
const TP = n => `Resources/Global/Teleporters/${n}.png`;
const FILES = ["R", "L", "B", "T", "BR", "TL", "BL", "TR"];

(async () => {
  const h = await H.start({ tilesets: TILESETS, tiles: TILES, role: "admin" });
  const { test, newPage, ready, settle } = h;
  const clean = logs => logs.filter(l => !/Failed to load resource|\[BABEL\]/.test(l));
  const W = 9, HH = 9; // odd x odd: the centre is cell (4,4); the mirror of (r, c) is (8-r, 8-c)
  const mirrorStore = flags => ({ oph_gridW: W, oph_gridH: HH, oph_mirror: { v: flags.includes("v"), h: flags.includes("h"), d: flags.includes("d") } });
  // v = left-right ("Horizontal" button), h = top-bottom ("Vertical" button), d = point reflection

  const openFolder = async (page, key) => { await page.click(`[data-folder-card='${key}']`); };
  const placeGlobal = async (page, folderKey, ref, r, c) => {
    await openFolder(page, folderKey);
    await page.click(`[data-tile-card='g:${ref}']`);
    await page.click(`[data-cell='${r},${c}']`);
    await settle(page);
  };
  const placeDb = async (page, id, r, c) => {
    await page.click(`[data-tile-card='d:${id}']`);
    await page.click(`[data-cell='${r},${c}']`);
    await settle(page);
  };
  // -> { at(r, c) -> { ref (stored form), off: { ox, oy } | null } }
  const readMap = async page => {
    const sv = await page.evaluate(() => ({ grid: JSON.parse(localStorage.getItem("oph_grid") || "null"), off: JSON.parse(localStorage.getItem("oph_grid_off") || "{}") }));
    return { raw: sv, at: (r, c) => { const i = sv.grid && sv.grid.grid[r][c]; return { ref: i == null ? null : sv.grid.palette[i - 1], off: sv.off[`${r},${c}`] ?? null }; } };
  };
  // Rendered offset of the tile drawn in a cell, in % of a cell, read off the DOM (what the user sees).
  const renderedOffset = (page, ref, r, c) => page.evaluate(([src, r, c]) => {
    const cell = document.querySelector(`[data-cell='${r},${c}']`);
    const cellPx = parseFloat(cell.style.width), cellLeft = parseFloat(cell.style.left), cellTop = parseFloat(cell.style.top);
    const img = [...document.querySelectorAll("img")].find(i => i.getAttribute("src") && i.getAttribute("src").includes(src) && i.style.position === "absolute" && parseFloat(i.style.width) > 0
      && Math.abs((parseFloat(i.style.left) + parseFloat(i.style.width) / 2) - (cellLeft + cellPx / 2)) < cellPx * 1.5 && Math.abs(parseFloat(i.style.top) - (cellTop + cellPx / 2)) < cellPx * 1.5 && !i.closest("[data-folder-panel]"));
    if (!img) return null;
    const cx = parseFloat(img.style.left) + parseFloat(img.style.width) / 2, cy = parseFloat(img.style.top);
    return { ox: Math.round(((cx - (cellLeft + cellPx / 2)) / cellPx) * 100), oy: Math.round(((cy - (cellTop + cellPx / 2)) / cellPx) * 100) };
  }, [ref, r, c]);

  await test("REPRO + FIX: a jumppad drawn with H+V+D mirroring gets mirrored copies whose offsets are negated on the flipped axes (they used to be left unmirrored)", async () => {
    const { page, ctx, logs } = await newPage({ storage: mirrorStore("vhd") });
    await ready(page);
    await placeGlobal(page, "global_jumppads", JP("T"), 1, 1);
    const m = await readMap(page);
    // refs: left-right keeps T, rows reflecting makes it B
    assert.deepStrictEqual([m.at(1, 1).ref, m.at(1, 7).ref, m.at(7, 1).ref, m.at(7, 7).ref], [JP("T"), JP("T"), JP("B"), JP("B")]);
    // offsets: the source uses the tile's own (50, 66); the copies are negated on the flipped axes (B's own offset is the same 50, 66)
    assert.strictEqual(m.at(1, 1).off, null);
    assert.deepStrictEqual(m.at(1, 7).off, { ox: -50, oy: 66 });
    assert.deepStrictEqual(m.at(7, 1).off, { ox: 50, oy: -66 });
    assert.deepStrictEqual(m.at(7, 7).off, { ox: -50, oy: -66 });
    // and that is what is drawn
    assert.deepStrictEqual(await renderedOffset(page, "Jumppads/T.png", 1, 1), { ox: 50, oy: 66 });
    assert.deepStrictEqual(await renderedOffset(page, "Jumppads/T.png", 1, 7), { ox: -50, oy: 66 });
    assert.deepStrictEqual(await renderedOffset(page, "Jumppads/B.png", 7, 1), { ox: 50, oy: -66 });
    assert.deepStrictEqual(await renderedOffset(page, "Jumppads/B.png", 7, 7), { ox: -50, oy: -66 });
    assert.deepStrictEqual(clean(logs), []);
    await ctx.close();
  });

  await test("teleporter (a global tile with a path-rule offset): same tile on every image, offset negated per flipped axis", async () => {
    const { page, ctx } = await newPage({ storage: mirrorStore("vhd") });
    await ready(page);
    await placeGlobal(page, "global_teleporters", TP("Blue"), 2, 1);
    const m = await readMap(page);
    for (const [r, c] of [[2, 1], [2, 7], [6, 1], [6, 7]]) assert.strictEqual(m.at(r, c).ref, TP("Blue"));
    assert.strictEqual(m.at(2, 1).off, null);
    assert.deepStrictEqual(m.at(2, 7).off, { ox: -50, oy: 60 });
    assert.deepStrictEqual(m.at(6, 1).off, { ox: 50, oy: -60 });
    assert.deepStrictEqual(m.at(6, 7).off, { ox: -50, oy: -60 });
    await ctx.close();
  });

  await test("DB tile with mirror_offset true and a non-zero offset: negated per flipped axis; mirror_offset false: copies keep the plain offset", async () => {
    const { page, ctx } = await newPage({ storage: mirrorStore("vhd") });
    await ready(page);
    await placeDb(page, MO, 1, 2);
    await placeDb(page, NOMO, 3, 3);
    const m = await readMap(page);
    assert.strictEqual(m.at(1, 2).off, null);
    assert.deepStrictEqual(m.at(1, 6).off, { ox: -10, oy: 20 });
    assert.deepStrictEqual(m.at(7, 2).off, { ox: 10, oy: -20 });
    assert.deepStrictEqual(m.at(7, 6).off, { ox: -10, oy: -20 });
    for (const [r, c] of [[3, 3], [3, 5], [5, 3], [5, 5]]) assert.strictEqual(m.at(r, c).off, null, `no override for the mirror_offset=false tile at ${r},${c}`);
    assert.deepStrictEqual(await renderedOffset(page, "Lamp.png", 1, 6), { ox: -10, oy: 20 });
    await ctx.close();
  });

  for (const [flags, axes] of [["v", { x: 1, y: 0 }], ["h", { x: 0, y: 1 }], ["d", { x: 1, y: 1 }]]) {
    await test(`every jumppad with mirror "${flags}" (${flags === "v" ? "left-right" : flags === "h" ? "top-bottom" : "point reflection"}): the image is the direction-mirrored jumppad with its own offset negated`, async () => {
      const { page, ctx } = await newPage({ storage: mirrorStore(flags) });
      await ready(page);
      // 8 pads in rows 0..1 (left half), none on a mirror axis
      const spots = FILES.map((f, i) => [f, Math.floor(i / 4), i % 4]);
      for (const [f, r, c] of spots) await placeGlobal(page, "global_jumppads", JP(f), r, c);
      const m = await readMap(page);
      const X = { R: "L", L: "R", TR: "TL", TL: "TR", BR: "BL", BL: "BR" }, Y = { T: "B", B: "T", TL: "BL", BL: "TL", TR: "BR", BR: "TR" };
      const mirrorFile = f => { let o = f; if (axes.x && X[o]) o = X[o]; if (axes.y && Y[o]) o = Y[o]; return o; };
      for (const [f, r, c] of spots) {
        const tr = axes.y ? HH - 1 - r : r, tc = axes.x ? W - 1 - c : c;
        assert.strictEqual(m.at(r, c).ref, JP(f), `source ${f}`);
        assert.strictEqual(m.at(tr, tc).ref, JP(mirrorFile(f)), `${flags}: ${f} -> ${mirrorFile(f)} at ${tr},${tc}`);
        assert.deepStrictEqual(m.at(tr, tc).off, { ox: axes.x ? -50 : 50, oy: axes.y ? -66 : 66 }, `${flags}: offset of the image of ${f}`);
      }
      await ctx.close();
    });
  }

  await test("team tiles unchanged: spawn 1 keeps its team on a left-right image and swaps to 2 when rows reflect; spawn 3 (Solo) never swaps and respawn 5 swaps to 6", async () => {
    const { page, ctx } = await newPage({ storage: mirrorStore("vhd") });
    await ready(page);
    await placeGlobal(page, "global_spawns", "Resources/Global/Spawns/1.png", 1, 1);
    await placeGlobal(page, "global_spawns", "Resources/Global/Spawns/3.png", 2, 2);
    await placeGlobal(page, "global_spawns", "Resources/Global/Spawns/5.png", 3, 3);
    const m = await readMap(page);
    const S = n => `Resources/Global/Spawns/${n}.png`;
    assert.deepStrictEqual([m.at(1, 1).ref, m.at(1, 7).ref, m.at(7, 1).ref, m.at(7, 7).ref], [S(1), S(1), S(2), S(2)]);
    assert.deepStrictEqual([m.at(2, 2).ref, m.at(2, 6).ref, m.at(6, 2).ref, m.at(6, 6).ref], [S(3), S(3), S(3), S(3)]);
    assert.deepStrictEqual([m.at(3, 3).ref, m.at(3, 5).ref, m.at(5, 3).ref, m.at(5, 5).ref], [S(5), S(5), S(6), S(6)]);
    await ctx.close();
  });

  await test("drag-drop (pick a tile up from the map and drop it) places the mirrored jumppads with the right offsets too", async () => {
    const { page, ctx } = await newPage({ storage: mirrorStore("vhd") });
    await ready(page);
    await placeGlobal(page, "global_jumppads", JP("TL"), 1, 1); // TL at 1,1 and its images
    const from = await page.locator("[data-cell='1,1']").boundingBox();
    const to = await page.locator("[data-cell='2,2']").boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 12, { steps: 4 });
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
    await page.mouse.up();
    await settle(page);
    const m = await readMap(page);
    assert.deepStrictEqual([m.at(1, 1).ref, m.at(1, 7).ref, m.at(7, 1).ref, m.at(7, 7).ref], [null, null, null, null], "the picked-up pads left their cells");
    assert.deepStrictEqual([m.at(2, 2).ref, m.at(2, 6).ref, m.at(6, 2).ref, m.at(6, 6).ref], [JP("TL"), JP("TR"), JP("BL"), JP("BR")], "TL / TR (x) / BL (y) / BR (both)");
    assert.strictEqual(m.at(2, 2).off, null);
    assert.deepStrictEqual([m.at(2, 6).off, m.at(6, 2).off, m.at(6, 6).off], [{ ox: -50, oy: 66 }, { ox: 50, oy: -66 }, { ox: -50, oy: -66 }]);
    await ctx.close();
  });

  await test("undo restores the offsets of the mirrored copies together with the tiles", async () => {
    const { page, ctx } = await newPage({ storage: mirrorStore("vhd") });
    await ready(page);
    await placeGlobal(page, "global_jumppads", JP("R"), 1, 1);
    let m = await readMap(page);
    assert.deepStrictEqual(m.at(1, 7).off, { ox: -50, oy: 66 });
    await page.keyboard.press("z"); await settle(page);
    m = await readMap(page);
    assert.deepStrictEqual([m.at(1, 1).ref, m.at(1, 7).ref], [null, null]);
    assert.deepStrictEqual(m.raw.off, {}, "no stray offsets after undo");
    await page.keyboard.press("x"); await settle(page);
    m = await readMap(page);
    assert.deepStrictEqual([m.at(1, 1).ref, m.at(1, 7).ref], [JP("R"), JP("L")]);
    assert.deepStrictEqual(m.at(1, 7).off, { ox: -50, oy: 66 });
    await ctx.close();
  });

  await h.finish();
})();
