// Phase 12 browser checks on the stubbed-network harness. Run with:
//   OPH_VENDOR=<dir containing node_modules/{react,react-dom,@babel/standalone}> node tests/phase12.e2e.js
// NOTHING live is contacted (see tests/e2e_harness.js). Prints SKIP and exits 0 when the harness cannot run.
// Tile images are served from here: 100x130 PNGs, 30 transparent rows above a square 100x100 art block (solid colour per tile).
const H = require("./e2e_harness.js");
const { row } = H;

const TILESETS = [{ id: "ts-0", name: "Snowtel Gifts", seed_id: 0, is_published: true, owner_id: "u1", folder_path: "Snow", profiles: { username: "tester" } }];
const U = n => `a0000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const CODES = ["00001011", "01111111", "01101011", "11111111"];
const TILES = { "ts-0": [row(U(1), "ts-0", "Wall1", { sort_index: 1 }),
  ...CODES.map((c, i) => row(U(20 + i), "ts-0", "Pond_" + c, { folder_key: "Pond", sensor_code: c, sort_index: 20 + i, symbol: "W", rotatable: true }))] };
const W = 100, HH = 130, MARGIN = 30;
const tallPng = tag => {
  const zlib = require("zlib"), crc = require("../sensor_ui.js").crc32;
  const chunk = (t, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4, "ascii"); d.copy(b, 8); b.writeUInt32BE(crc(Buffer.concat([Buffer.from(t), d])), 8 + d.length); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(HH, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((W * 4 + 1) * HH), n = [...tag].reduce((a, ch) => a + ch.charCodeAt(0), 0);
  for (let y = MARGIN; y < HH; y++) for (let x = 0; x < W; x++) { const o = y * (W * 4 + 1) + 1 + x * 4; raw[o] = 40 + (n * 7) % 200; raw[o + 1] = 40 + (n * 13) % 200; raw[o + 2] = 40 + (n * 29) % 200; raw[o + 3] = 255; }
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
};

(async () => {
  const h = await H.start({ tilesets: TILESETS, tiles: TILES, role: "user", image: url => (/Pond_/.test(url.pathname) ? tallPng(url.pathname) : null) });
  const { test, newPage, ready, settle, assert } = h;
  const clean = logs => logs.filter(l => !/Failed to load resource|\[BABEL\]/.test(l));
  // opacity of the rows of an image given as a URL / bytes: -> { w, h, rows: [alpha-min, alpha-max] per row }
  const rowsOf = (page, src) => page.evaluate(async src => {
    const bmp = await createImageBitmap(await (await fetch(src)).blob());
    const cv = document.createElement("canvas"); cv.width = bmp.width; cv.height = bmp.height;
    const ctx = cv.getContext("2d"); ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data, rows = [];
    for (let y = 0; y < cv.height; y++) { let lo = 255, hi = 0; for (let x = 0; x < cv.width; x++) { const a = d[(y * cv.width + x) * 4 + 3]; lo = Math.min(lo, a); hi = Math.max(hi, a); } rows.push([lo, hi]); }
    return { w: cv.width, h: cv.height, rows };
  }, src);

  await test("layout: Map seed and View history on one row with two distinct theme colours; Clear map is gone from the bottom panel and lives in the history modal behind its confirmation", async () => {
    const colours = {};
    for (const theme of ["warm", "cold"]) {
      const { page, ctx, logs } = await newPage();
      await ready(page); await settle(page);
      await page.click("button:has-text('tester')");
      await page.click(theme === "warm" ? "button:has-text('Warm')" : "button:has-text('Cold')");
      await page.mouse.click(5, 300); await settle(page);
      assert.strictEqual(await page.locator("[data-seed-row] button").count(), 2);
      assert.ok(/Map seed/.test(await page.textContent("[data-map-seed-open]")) && /View history/.test(await page.textContent("[data-history-open]")));
      const c = await page.$$eval("[data-seed-row] button", els => els.map(e => getComputedStyle(e).color));
      assert.notStrictEqual(c[0], c[1], "two distinct accents");
      colours[theme] = c;
      assert.ok(!(await page.locator("button", { hasText: /^Clear Map$/i }).count()), "no Clear map in the bottom panel");
      await page.click("[data-history-open]");
      await page.waitForSelector("[data-history-danger]");
      assert.ok(await page.locator("[data-history-danger] [data-clear-map]").count() === 1);
      await page.click("[data-clear-map]");
      await page.waitForSelector("text=This will remove all tiles from the canvas");
      assert.strictEqual(await page.locator("[data-history-danger]").count(), 0, "the history modal makes way for the confirmation");
      await page.click("button:has-text('Cancel')");
      assert.deepStrictEqual(clean(logs), []);
      await ctx.close();
    }
    assert.notDeepStrictEqual(colours.warm, colours.cold, "the colours follow the theme");
  });

  await test("composed variant of tall tiles (100x130, 30 transparent rows, square art): seam at 30 + 50, spin keeps the art in place, the rows above the art stay transparent; overlay shows the real regions", async () => {
    const { page, ctx, logs } = await newPage();
    await ready(page); await settle(page);
    await page.click("[data-sensor-unfold='s:ts-0|Pond']");
    await page.locator("[data-sensor-sim-open='s:ts-0|Pond']").first().click();
    await page.waitForSelector("[data-testid='sim-grid']");
    for (const b of ["N", "W", "E", "S"]) await page.click(`[data-bit='${b}']`);
    await page.waitForFunction(() => { const i = document.querySelector("[data-testid='sim-chosen'] img"); return i && i.src.startsWith("blob:"); }, null, { timeout: 15000 });
    const src = await page.getAttribute("[data-testid='sim-chosen'] img", "src");
    const r = await rowsOf(page, src);
    assert.deepStrictEqual([r.w, r.h], [W, HH]);
    assert.ok(r.rows.slice(0, MARGIN).every(([lo, hi]) => hi === 0), "rows above the art are transparent");
    assert.ok(r.rows.slice(MARGIN).every(([lo]) => lo === 255), "the art block is fully covered (no gaps, no shifts)");
    await page.click("[data-quad-show='TL']");
    const box = await page.locator("[data-testid='sim-chosen']").boundingBox(), hl = await page.locator("[data-quad-highlight='TL']").boundingBox();
    const k = 94 / HH;
    assert.ok(Math.abs(hl.height - 80 * k) < 1.5 && Math.abs(hl.width - 50 * k) < 1.5, `TL overlay ${hl.width}x${hl.height}`);
    assert.ok(Math.abs(hl.y - (box.y + 1)) < 1.5, "TL starts at the very top (transparent rows included)");
    await page.click("[data-quad-show='BR']");
    const br = await page.locator("[data-quad-highlight='BR']").boundingBox();
    assert.ok(Math.abs((br.y + br.height) - (box.y + 1 + 94)) < 1.5, "BR reaches the bottom");
    assert.deepStrictEqual(clean(logs), []);
    await ctx.close();
  });

  await test("top edge that cannot be read (canvas taint): the old centred layout and a warning, nothing crashes", async () => {
    const { page, ctx, logs } = await newPage();
    const warns = []; page.on("console", m => { if (m.type() === "warning") warns.push(m.text()); });
    await page.addInitScript(() => { CanvasRenderingContext2D.prototype.getImageData = function () { throw new DOMException("tainted", "SecurityError"); }; });
    await page.reload();
    await ready(page); await settle(page);
    await page.click("[data-sensor-unfold='s:ts-0|Pond']");
    await page.locator("[data-sensor-sim-open='s:ts-0|Pond']").first().click();
    await page.waitForSelector("[data-testid='sim-grid']");
    for (const b of ["N", "W", "E", "S"]) await page.click(`[data-bit='${b}']`);
    await page.waitForFunction(() => { const i = document.querySelector("[data-testid='sim-chosen'] img"); return i && i.src.startsWith("blob:"); }, null, { timeout: 15000 });
    await page.click("[data-quad-show='TL']");
    const box = await page.locator("[data-testid='sim-chosen']").boundingBox(), hl = await page.locator("[data-quad-highlight='TL']").boundingBox();
    assert.ok(Math.abs(hl.height - 65 * (94 / HH)) < 1.5, `centred: TL is half the height, got ${hl.height}`);
    assert.ok(warns.some(w => /top edge/.test(w)), warns.join("|"));
    await ctx.close();
  });

  await test("export: sensor tiles are <code>.png in the sensor folder's directory, tiles.json is off by default, composed tall variants use the shared geometry", async () => {
    const { page, ctx } = await newPage();
    await ready(page); await settle(page);
    await page.locator("button[title='Tileset settings']").first().click();
    await page.click("[data-export-open]");
    await page.waitForSelector("[data-export-options]");
    assert.strictEqual(await page.isChecked("[data-export-opt='json']"), false);
    await page.uncheck("[data-export-opt='offsets']").catch(() => {}); await page.uncheck("[data-export-opt='shadow']").catch(() => {});
    const dl = page.waitForEvent("download");
    await page.click("[data-export-run]");
    const fs = require("fs"), cp = require("child_process"), os = require("os"), path = require("path");
    const tmp = path.join(os.tmpdir(), "oph_p12_" + process.pid + ".zip");
    fs.copyFileSync(await (await dl).path(), tmp);
    const z = JSON.parse(cp.execFileSync("python3", ["-I", "-c", "import sys,zipfile,json\nz=zipfile.ZipFile(sys.argv[1])\nprint(json.dumps({i.filename:z.read(i).hex() for i in z.infolist()}))", tmp]).toString());
    fs.unlinkSync(tmp);
    const names = Object.keys(z);
    assert.ok(!names.some(n => n.endsWith("tiles.json")), "no tiles.json by default");
    assert.ok(names.includes("Snowtel Gifts/Wall1.png") && names.includes("Snowtel Gifts/Pond/00001011.png"), names.join());
    assert.ok(names.filter(n => n.includes("/Pond/")).every(n => /\/Pond\/[01]{8}(_\d+)?\.png$/.test(n)), names.join());
    assert.ok("Snowtel Gifts/Pond/11010010.png" in z, "a composed code is exported");
    const r = await rowsOf(page, "data:image/png;base64," + Buffer.from(z["Snowtel Gifts/Pond/11010010.png"], "hex").toString("base64"));
    assert.deepStrictEqual([r.w, r.h], [W, HH]);
    assert.ok(r.rows.slice(0, MARGIN).every(([lo, hi]) => hi === 0) && r.rows.slice(MARGIN).every(([lo]) => lo === 255), "composed export: transparent top rows, art block intact");
    await ctx.close();
  });

  // Modals taller than the viewport scroll inside themselves and keep their primary button reachable.
  const solidPng = (w, h) => {
    const zlib = require("zlib"), crc = require("../sensor_ui.js").crc32;
    const chunk = (t, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4, "ascii"); d.copy(b, 8); b.writeUInt32BE(crc(Buffer.concat([Buffer.from(t), d])), 8 + d.length); return b; };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
    const raw = Buffer.alloc((w * 4 + 1) * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 4 + 1) + 1 + x * 4; raw[o] = 200; raw[o + 3] = 255; }
    return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  };
  const TALL = solidPng(200, 1600);
  const fillAndCheck = async (page, vp, submitText, fields) => {
    const modal = page.locator(".modal-box").last();
    await modal.locator("input[type=file]").setInputFiles({ name: "tall.png", mimeType: "image/png", buffer: TALL });
    for (const [ph, v] of fields) await modal.locator(`input[placeholder='${ph}']`).fill(v);
    await page.waitForTimeout(300);
    const m = await modal.boundingBox();
    assert.ok(m.y >= 0 && m.y + m.height <= vp.height + 0.5, `dialog fits the viewport: y ${m.y}, h ${m.height}, vh ${vp.height}`);
    const img = await modal.locator("img").first().boundingBox();
    assert.ok(img.height <= vp.height * 0.4 + 1, `preview height ${img.height}`);
    const btn = modal.locator(`button:has-text('${submitText}')`).last();
    // wheel scrolling inside the dialog works
    await modal.hover(); await page.mouse.wheel(0, 3000); await page.waitForTimeout(150);
    const bb = await btn.boundingBox();
    assert.ok(bb && bb.y >= 0 && bb.y + bb.height <= vp.height, `${submitText} inside the viewport: ${JSON.stringify(bb)}`);
    const hit = await btn.evaluate(el => { const r = el.getBoundingClientRect(), e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!e && (e === el || el.contains(e)); });
    assert.ok(hit, `${submitText} is not covered by anything`);
    assert.ok(await btn.isEnabled(), `${submitText} is enabled once the form is filled`);
  };
  const h2 = await H.start({ tilesets: TILESETS, tiles: TILES, role: "creator" }); // creators see Create Tileset and Add Tile
  for (const vp of [{ width: 1280, height: 720 }, { width: 1280, height: 500 }, { width: 390, height: 700 }]) {
    await h2.test(`modals scroll at ${vp.width}x${vp.height}: Create Tileset and Add Tile keep their button reachable after a tall upload`, async () => {
      const { page, ctx, logs } = await h2.newPage({ viewport: vp });
      if (vp.width < 600) { await page.waitForTimeout(3000); await page.mouse.click(19, 415); await page.waitForSelector("[data-ts-toggle]"); } // mobile: the tile panel starts folded
      else { await h2.ready(page); await h2.settle(page); }
      await page.click("[data-ts-toggle]");
      await page.locator("text=Create Tileset").first().click();
      await page.waitForSelector("input[placeholder='My Tileset']");
      await page.fill("input[placeholder='My Tileset']", "Tall Set");
      await fillAndCheck(page, vp, "Create Tileset", [["e.g. MyTileset_Wall1", "Tall_1"]]);
      await page.locator("button:has-text('Cancel')").last().click();
      await page.waitForSelector("input[placeholder='My Tileset']", { state: "detached" });
      await page.click("[title='Add tile to Snowtel Gifts']");
      await page.waitForSelector("input[placeholder='e.g. MyTileset_Wall1']");
      await fillAndCheck(page, vp, "Add Tile", [["e.g. MyTileset_Wall1", "Tall_2"]]);
      assert.deepStrictEqual(clean(logs), []);
      await ctx.close();
    });
  }

  await h2.finish();
  await h.finish();
})();
