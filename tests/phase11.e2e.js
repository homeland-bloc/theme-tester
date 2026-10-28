// Phase 11 browser checks on the stubbed-network harness. Run with:
//   OPH_VENDOR=<dir containing node_modules/{react,react-dom,@babel/standalone}> node tests/phase11.e2e.js
// NOTHING live is contacted (see tests/e2e_harness.js). Prints SKIP and exits 0 when the harness cannot run.
const H = require("./e2e_harness.js");
const { row } = H;

const TILESETS = [
  { id: "ts-0", name: "Snowtel Gifts", seed_id: 0, is_published: true, owner_id: "u1", folder_path: "Snow", profiles: { username: "tester" } },
  { id: "ts-5", name: "Export Set", seed_id: 5, is_published: true, owner_id: "u1", folder_path: "Exp", profiles: { username: "tester" } },
];
const RAWLAMP = "https://raw.githubusercontent.com/bicipikay/ophelia/main/Resources/Exp/Lamp.png?v=1";
const U = n => `a0000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const TILES = { "ts-0": [
  row(U(1), "ts-0", "Wall1", { sort_index: 1 }),
  row(U(2), "ts-0", "Crate", { symbol: "Z", sort_index: 2 }),
  row(U(3), "ts-0", "Spotlight", { sort_index: 3 }),
  row(U(4), "ts-0", "Fence_h", { folder_key: "Fence", sensor_code: "00011000", sort_index: 4 }),
  row(U(5), "ts-0", "Fence_v", { folder_key: "Fence", sensor_code: "01000010", sort_index: 5 }),
  ...["00001011", "01111111", "01101011", "11111111"].map((c, i) => row(U(20 + i), "ts-0", "Pond_" + c, { folder_key: "Pond", sensor_code: c, sort_index: 20 + i, symbol: "W", rotatable: true })),
], "ts-5": [
  row(U(40), "ts-5", "Plain", { sort_index: 1, symbol: "M" }),
  row(U(41), "ts-5", "Lamp", { image_url: RAWLAMP, sort_index: 2, offset_x: 10, offset_y: 20, auto_shadow: true, size_multiplier: 2, symbol: "D" }),
  ...["00001011", "01111111", "01101011", "11111111"].map((c, i) => row(U(50 + i), "ts-5", "Pond_" + c, { folder_key: "Pond", sensor_code: c, sort_index: 20 + i, symbol: "W", rotatable: true })),
] };

(async () => {
  const uploads = [];
  const h = await H.start({ tilesets: TILESETS, tiles: TILES, role: "user", onWorker: async (route, url, reply) => {
    if (url.pathname === "/github/upload") { uploads.push(JSON.parse(route.request().postData())); reply(200, { ok: true }); return true; }
    if (url.pathname === "/rest/v1/tiles" && route.request().method() === "PATCH" && /^eq\./.test(url.searchParams.get("id") || "")) { // the stub database keeps what it is sent
      const hit = Object.values(TILES).flat().find(r => r.id === url.searchParams.get("id").slice(3));
      if (hit) Object.assign(hit, JSON.parse(route.request().postData()));
      reply(204, ""); return true;
    }
    return false;
  } });
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

  await test("simulator: every composed quadrant line has a 'show' button; tapping it highlights that quarter and it stays after the pointer leaves; tapping again clears", async () => {
    const { page, ctx, logs } = await newPage();
    await ready(page); await settle(page);
    await page.click("[data-sensor-unfold='s:ts-0|Pond']");
    const open = page.locator("[data-sensor-sim-open='s:ts-0|Pond']");
    await open.first().click();
    await page.waitForSelector("[data-testid='sim-grid']");
    for (const b of ["N", "W", "E", "S"]) await page.click(`[data-bit='${b}']`); // a plus shape: not a base tile, so it is composed
    await settle(page);
    assert.strictEqual(await page.locator("[data-quad-show]").count(), 4);
    await page.click("[data-quad-show='TR']");
    assert.strictEqual(await page.locator("[data-quad-highlight='TR']").count(), 1);
    await page.mouse.move(5, 5);
    assert.strictEqual(await page.locator("[data-quad-highlight='TR']").count(), 1, "stays highlighted");
    await page.click("[data-quad-show='BL']");
    assert.strictEqual(await page.locator("[data-quad-highlight]").count(), 1);
    assert.strictEqual(await page.locator("[data-quad-highlight='BL']").count(), 1);
    await page.click("[data-quad-show='BL']");
    await page.mouse.move(5, 5); // the hover highlight (desktop extra) ends with the pointer
    assert.strictEqual(await page.locator("[data-quad-highlight]").count(), 0);
    await ctx.close();
  });

  const openGear = async (page, name) => { // only the active tileset's section carries its gear
    await page.click("[data-ts-toggle]"); await page.click(`[data-ts-option="${name}"]`); await settle(page);
    await page.locator("button[title='Tileset settings']").first().click();
    await page.waitForSelector(`input[value="${name}"]`);
  };
  const unzip = (buf) => { // the zip written by the app, read by python's zipfile (an independent reader)
    const fs = require("fs"), cp = require("child_process"), os = require("os"), path = require("path");
    const tmp = path.join(os.tmpdir(), "oph_e2e_" + process.pid + ".zip");
    fs.writeFileSync(tmp, buf);
    try { return JSON.parse(cp.execFileSync("python3", ["-I", "-c", "import sys,zipfile,json\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nprint(json.dumps({i.filename:[i.compress_type,z.read(i).hex()] for i in z.infolist()}))", tmp]).toString()); } finally { fs.unlinkSync(tmp); }
  };

  // a solid 10x10 red PNG (so baked sizes can be checked from the IHDR)
  const solidPng = (w, h) => {
    const zlib = require("zlib"), crc = require("../sensor_ui.js").crc32;
    const chunk = (t, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4, "ascii"); d.copy(b, 8); b.writeUInt32BE(crc(Buffer.concat([Buffer.from(t), d])), 8 + d.length); return b; };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
    const raw = Buffer.alloc((w * 4 + 1) * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 4 + 1) + 1 + x * 4; raw[o] = 255; raw[o + 3] = 255; }
    return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  };
  const dims = hex => [parseInt(hex.slice(32, 40), 16), parseInt(hex.slice(40, 48), 16)];

  await test("Export tileset (zip): read-only, native-size images grouped by folder, derived + composed sensor variants as PNG, tiles.json, defaults follow the data", async () => {
    const { page, ctx, logs } = await newPage();
    await page.route("**/raw.githubusercontent.com/**/Lamp.png*", route => route.fulfill({ status: 200, contentType: "image/png", body: solidPng(10, 10), headers: { "access-control-allow-origin": "*" } }));
    await ready(page); await settle(page);
    await openGear(page, "Export Set");
    const before = requests.length;
    await page.click("[data-export-open]");
    await page.waitForSelector("[data-export-options]");
    // defaults: some tile has an offset and one uses auto-shadow -> both ON; tiles.json ON
    assert.deepStrictEqual(await page.$$eval("[data-export-opt]", els => els.map(e => [e.dataset.exportOpt, e.checked])), [["offsets", true], ["shadow", true], ["json", true]]);
    assert.ok(/can change how sensor quadrants split/.test(await page.textContent("[data-export-options]")));
    const dl = page.waitForEvent("download");
    await page.click("[data-export-run]");
    const download = await dl;
    const buf = require("fs").readFileSync(await download.path());
    await page.waitForFunction(() => /exported/.test(document.querySelector("[data-export-status]")?.textContent || ""));
    const z = unzip(buf);
    const names = Object.keys(z);
    assert.ok(names.every(n => n.startsWith("Export Set/")), names.join());
    assert.ok(names.includes("Export Set/Plain.png") && names.includes("Export Set/Lamp.png") && names.includes("Export Set/tiles.json"), names.join());
    assert.ok(names.filter(n => n.startsWith("Export Set/Pond/Pond_")).length > 40, "47 codes: 4 real + derived + composed");
    assert.ok(z["Export Set/Plain.png"][0] === 0, "stored, not compressed");
    const PNG_SIG = "89504e470d0a1a0a";
    for (const n of names.filter(n => n.endsWith(".png"))) assert.ok(z[n][1].startsWith(PNG_SIG), n);
    // Plain has no offset or shadow: the original bytes. Lamp is baked: bigger than the 1x1 stub, and PNG
    assert.strictEqual(z["Export Set/Plain.png"][1], H.PNG.toString("hex"));
    assert.notStrictEqual(z["Export Set/Lamp.png"][1], H.PNG.toString("hex"));
    // 10x10 tile, offset (10%, 20%) = (1px, 2px), shadow 3px lower: padding goes opposite, canvas stays centred on the cell -> 12 x 20
    assert.deepStrictEqual(dims(z["Export Set/Lamp.png"][1]), [12, 20]);
    assert.deepStrictEqual(dims(z["Export Set/Pond/Pond_00001011.png"][1]), [1, 1], "native size, no multiplier");
    const doc = JSON.parse(Buffer.from(z["Export Set/tiles.json"][1], "hex").toString());
    const lamp = doc.tiles.find(t => t.codename === "Lamp"), plain = doc.tiles.find(t => t.codename === "Plain");
    assert.deepStrictEqual([lamp.bakedOffsets, lamp.bakedShadow, lamp.offsetX, lamp.offsetY, lamp.sizeMultiplier, lamp.sizeApplied, lamp.symbol, lamp.file], [true, true, 10, 20, 2, false, "D", "Export Set/Lamp.png"]);
    assert.deepStrictEqual([plain.bakedOffsets, plain.bakedShadow], [false, false]);
    assert.deepStrictEqual(doc.failed, []);
    assert.ok(doc.tiles.some(t => t.kind === "derived") && doc.tiles.some(t => t.kind === "composed"));
    // read-only: nothing but GETs went to the worker, and the images came from the CDN stub
    const sent = requests.slice(before);
    assert.ok(sent.every(r => r.method === "GET"), JSON.stringify(sent.filter(r => r.method !== "GET")));
    await ctx.close();
  });

  await test("Export tileset (zip): a failing image is reported per tile and the export still completes; options can be switched off", async () => {
    const { page, ctx } = await newPage();
    await page.route("**/raw.githubusercontent.com/**/Lamp.png*", route => route.fulfill({ status: 404, body: "no" }));
    await ready(page); await settle(page);
    await openGear(page, "Export Set");
    await page.click("[data-export-open]");
    await page.waitForSelector("[data-export-options]");
    await page.uncheck("[data-export-opt='offsets']"); await page.uncheck("[data-export-opt='shadow']"); await page.uncheck("[data-export-opt='json']");
    const dl = page.waitForEvent("download");
    await page.click("[data-export-run]");
    const z = unzip(require("fs").readFileSync(await (await dl).path()));
    await page.waitForSelector("[data-export-failures]");
    assert.ok(/Export Set\/Lamp\.png: download failed \(404\)/.test(await page.textContent("[data-export-failures]")));
    assert.ok(!("Export Set/Lamp.png" in z) && "Export Set/Plain.png" in z && !("Export Set/tiles.json" in z));
    await ctx.close();
  });

  await test("REPRO + FIX: after Replace Image the editor sees the uploaded bytes at once (blob), although the CDN still serves the old file; every replace gets a new ?v=", async () => {
    const { page, ctx, logs } = await newPage();
    const OLD = solidPng(4, 4), NEW = solidPng(6, 6);
    await page.route("**/raw.githubusercontent.com/**", route => route.fulfill({ status: 200, contentType: "image/png", body: OLD, headers: { "access-control-allow-origin": "*" } })); // the stale CDN
    await ready(page); await settle(page);
    await page.click("[data-ts-toggle]"); await page.click('[data-ts-option="Export Set"]'); await settle(page);
    const card = `[data-tile-card="d:${U(41)}"] img`;
    await page.waitForSelector(card);
    assert.ok((await page.getAttribute(card, "src")).startsWith("https://raw.githubusercontent.com/"), "before: the CDN url");
    const stamps = [];
    for (const png of [NEW, solidPng(8, 8)]) {
      await page.click(`[data-tile-info="d:${U(41)}"]`);
      await page.waitForSelector("#replace-img-input", { state: "attached" });
      await page.setInputFiles("#replace-img-input", { name: "x.png", mimeType: "image/png", buffer: png });
      const before = requests.length;
      await page.getByText("Confirm Replace").click();
      await page.waitForFunction(() => !document.body.innerText.includes("Confirm Replace") || /Failed to replace/.test(document.body.innerText));
      const shown = await page.innerText("body");
      assert.ok(!/Failed to replace/.test(shown), (/Failed to replace[^\n]*/.exec(shown) || [""])[0]);
      await settle(page);
      const patch = requests.slice(before).find(r => r.method === "PATCH" && /tiles\?id=/.test(r.path + r.query));
      stamps.push(Number(/\?v=(\d+)/.exec(JSON.parse(patch.body).image_url)[1]));
      const src = await page.getAttribute(card, "src");
      assert.ok(src.startsWith("blob:"), "the tile shows the uploaded bytes, not the CDN copy: " + src);
      const got = await page.evaluate(async u => { const b = new Uint8Array(await (await fetch(u)).arrayBuffer()); return Array.from(b.slice(16, 24)); }, src);
      assert.deepStrictEqual(Buffer.from(got).readUInt32BE(0), png.readUInt32BE(16), "width in the IHDR is the uploaded image's");
    }
    assert.ok(stamps[1] > stamps[0] && stamps[0] > 1, "a new ?v= every time: " + stamps);
    assert.strictEqual(uploads.length, 2);
    await ctx.close();
  });

  // ── Map geometry: panning and seams ──────────────────────────────────────────────────────────────────────
  const FLAT = U(70);
  const flatRow = row(FLAT, "ts-0", "Flat", { sort_index: 90, image_url: "https://stub.invalid/img/Flat.png" });
  TILES["ts-0"].push(flatRow);
  const filled = (r0, r1, c0, c1) => Array.from({ length: 33 }, (_, r) => Array.from({ length: 21 }, (_, c) => (r >= r0 && r <= r1 && c >= c0 && c <= c1 ? 1 : null)));
  const FLATMAP = { v: 2, palette: [`d:${FLAT}`], grid: filled(8, 17, 4, 14) };
  const zoomText = page => page.evaluate(() => { const t = [...document.querySelectorAll("span")].find(e => /^\d+%$/.test(e.textContent.trim()) && e.title === "Click to reset zoom to fit"); return t ? parseInt(t.textContent, 10) : null; });
  const zoomTo = async (page, pct) => {
    for (let i = 0; i < 120 && (await zoomText(page)) !== pct; i++) { await page.keyboard.press((await zoomText(page)) < pct ? "+" : "-"); await page.waitForTimeout(30); }
    assert.strictEqual(await zoomText(page), pct);
    await page.waitForTimeout(150);
  };

  await test("REPRO + FIX: with both panels folded on a 390px phone at 300% zoom, every edge of the map can be scrolled into view (left and right, top and bottom)", async () => {
    const { page, ctx } = await newPage({ viewport: { width: 390, height: 844 }, storage: { oph_gridW: 21, oph_gridH: 33, oph_grid: FLATMAP } });
    await page.waitForSelector("[data-map-scroll]", { timeout: 30000 }); await settle(page);
    await zoomTo(page, 300);
    const edges = () => page.evaluate(() => {
      const sc = document.querySelector("[data-map-scroll]"), box = sc.getBoundingClientRect();
      const res = {};
      for (const [name, sl, st, cell] of [["tl", 0, 0, "0,0"], ["br", 1e9, 1e9, "32,20"], ["tr", 1e9, 0, "0,20"], ["bl", 0, 1e9, "32,0"]]) {
        sc.scrollLeft = sl; sc.scrollTop = st;
        const r = document.querySelector(`[data-cell='${cell}']`).getBoundingClientRect();
        res[name] = { left: r.left - box.left, right: box.right - r.right, top: r.top - box.top, bottom: box.bottom - r.bottom };
      }
      return { res, scrollW: sc.scrollWidth, clientW: sc.clientWidth };
    });
    const { res, scrollW, clientW } = await edges();
    assert.ok(scrollW > clientW * 2, "the map is much wider than the screen: " + scrollW + " vs " + clientW);
    assert.ok(res.tl.left >= -0.5 && res.tl.top >= -0.5, "top-left cell reachable: " + JSON.stringify(res.tl));
    assert.ok(res.bl.left >= -0.5 && res.bl.bottom >= -0.5, "bottom-left cell reachable: " + JSON.stringify(res.bl));
    assert.ok(res.tr.right >= -0.5 && res.tr.top >= -0.5, "top-right cell reachable: " + JSON.stringify(res.tr));
    assert.ok(res.br.right >= -0.5 && res.br.bottom >= -0.5, "bottom-right cell reachable: " + JSON.stringify(res.br));
    // symmetric: the same padding on the left as on the right
    assert.ok(Math.abs(res.tl.left - res.tr.right) <= 1, `left ${res.tl.left} right ${res.tr.right}`);
    await ctx.close();
  });

  await test("seams: no dark gap pixels between neighbouring tiles at any zoom (counted inside a 4x4 block of identical opaque tiles)", async () => {
    const { page, ctx } = await newPage({ storage: { oph_gridW: 21, oph_gridH: 33, oph_grid: FLATMAP, oph_colors: { bg1: "#000000", bg2: "#000000" } } });
    await page.route("**/stub.invalid/img/Flat.png", route => route.fulfill({ status: 200, contentType: "image/png", body: solidPng(32, 32), headers: { "access-control-allow-origin": "*" } }));
    await ready(page); await settle(page);
    const counts = {};
    for (const pct of [100, 110, 150, 170, 230, 300]) {
      await zoomTo(page, pct);
      await page.evaluate(() => { const sc = document.querySelector("[data-map-scroll]"), c = document.querySelector("[data-cell='13,9']").getBoundingClientRect(), b = sc.getBoundingClientRect(); sc.scrollLeft += c.left - (b.left + b.width / 2) + 40; sc.scrollTop += c.top - (b.top + b.height / 2) + 40; });
      await page.waitForTimeout(150);
      const clip = await page.evaluate(() => { const a = document.querySelector("[data-cell='11,7']").getBoundingClientRect(), z = document.querySelector("[data-cell='14,10']").getBoundingClientRect(); return { x: Math.ceil(a.left), y: Math.ceil(a.top), width: Math.floor(z.right) - Math.ceil(a.left), height: Math.floor(z.bottom) - Math.ceil(a.top) }; });
      const png = await page.screenshot({ clip });
      counts[pct] = await page.evaluate(async b64 => {
        const im = new Image(); await new Promise(r => { im.onload = r; im.src = "data:image/png;base64," + b64; });
        const cv = document.createElement("canvas"); cv.width = im.width; cv.height = im.height; const ctx = cv.getContext("2d"); ctx.drawImage(im, 0, 0);
        const d = ctx.getImageData(0, 0, im.width, im.height).data; let dark = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] < 200) dark++; // the tiles are pure red (255,0,0); anything not red is the background showing through
        return dark;
      }, png.toString("base64"));
    }
    console.log("     dark gap pixels per zoom:", JSON.stringify(counts));
    for (const [pct, n] of Object.entries(counts)) assert.strictEqual(n, 0, `${pct}%: ${n} dark pixels between tiles`);
    await ctx.close();
  });

  await h.finish();

  // ── Hidden (unpublished) tileset on refresh ─────────────────────────────────────────────────────────────
  // An admin sees every tileset, but only once the profile (role) has arrived: the list asked for earlier leaves hidden ones out. The profile answer is slow here.
  const HID = [
    { id: "ts-0", name: "Snowtel Gifts", seed_id: 0, is_published: true, owner_id: "u2", folder_path: "Snow", profiles: { username: "other" } },
    { id: "ts-h", name: "Hidden Set", seed_id: 4, is_published: false, owner_id: "u2", folder_path: "Hid", bg_color_light: "#112233", bg_color_dark: "#223344", profiles: { username: "other" } },
  ];
  const HT = { "ts-0": [row(U(1), "ts-0", "Wall1", { symbol: "M", sort_index: 1 })], "ts-h": [row(U(60), "ts-h", "Wall1", { symbol: "M", sort_index: 1 }), row(U(61), "ts-h", "Lamp", { symbol: "D", sort_index: 2 })] };
  const tsRequests = [];
  const h2 = await H.start({ tilesets: HID, tiles: HT, role: "admin", onWorker: async (route, url, reply) => {
    const m = route.request().method();
    if (url.pathname === "/rest/v1/profiles" && m === "GET") { await new Promise(r => setTimeout(r, 1200)); reply(200, [{ id: "u1", username: "tester", role: "admin", theme: "auto" }]); return true; }
    if (url.pathname === "/rest/v1/tilesets" && m === "GET") {
      tsRequests.push(url.search);
      const filtered = url.searchParams.has("or") || url.searchParams.has("is_published");
      reply(200, filtered ? HID.filter(t => t.is_published) : HID); return true;
    }
    return false;
  } });
  const SAVED = { v: 2, palette: [`d:${U(61)}`], grid: Array.from({ length: 5 }, (_, r) => Array.from({ length: 5 }, (_, c) => (r === 2 && c === 2 ? 1 : null))) };
  const store = (ts, colors) => ({ oph_active_ts: JSON.stringify(ts), oph_gridW: 5, oph_gridH: 5, oph_grid: SAVED, oph_colors: colors });
  const lsGet = (page, k) => page.evaluate(k => localStorage.getItem(k), k);

  await h2.test("REPRO + FIX: refreshing on a hidden tileset keeps it (and its background) although the first tileset list would not contain it", async () => {
    const { page, ctx, logs } = await h2.newPage({ storage: store("Hidden Set", { bg1: "#112233", bg2: "#223344" }) });
    await h2.ready(page); await h2.settle(page);
    assert.strictEqual(JSON.parse(await lsGet(page, "oph_active_ts")), "Hidden Set", "still on the hidden tileset");
    assert.ok((await page.textContent("[data-ts-toggle]")).includes("Hidden Set"));
    assert.deepStrictEqual(JSON.parse(await lsGet(page, "oph_colors")), { bg1: "#112233", bg2: "#223344" });
    assert.ok(tsRequests.length >= 1 && tsRequests.every(q => !q.includes("or=") && !q.includes("is_published")), "the list was only asked for once the role was known: " + tsRequests.join(" | "));
    assert.deepStrictEqual(JSON.parse(await lsGet(page, "oph_grid")).palette, [`d:${U(61)}`], "the saved map is intact");
    await ctx.close();
  });

  await h2.test("a saved tileset that is genuinely absent: fall back to the default tileset WITH its own background, the saved map is neither converted nor overwritten, and a notice says so", async () => {
    const { page, ctx } = await h2.newPage({ storage: store("Gone Set", { bg1: "#aa0000", bg2: "#bb0000" }) });
    const before = JSON.stringify(SAVED);
    await h2.ready(page); await h2.settle(page);
    assert.strictEqual(JSON.parse(await lsGet(page, "oph_active_ts")), "Snowtel Gifts");
    const bg = JSON.parse(await lsGet(page, "oph_colors"));
    assert.ok(bg.bg1 !== "#aa0000" && bg.bg2 !== "#bb0000", "the old tileset's colours are gone: " + JSON.stringify(bg));
    assert.strictEqual(await lsGet(page, "oph_grid"), before, "the stored map is byte-for-byte the saved one");
    assert.ok(/not available to you/.test(await page.innerText("body")));
    await ctx.close();
  });

  await h2.finish();
})();
