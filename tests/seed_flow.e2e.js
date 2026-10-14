// Stubbed-network browser harness for map seeds. Run with:
//   OPH_VENDOR=<dir containing node_modules/{react,react-dom,@babel/standalone}> node tests/seed_flow.e2e.js
// Needs playwright (global install is found) and the Chromium that comes with it. Prints SKIP and exits 0 when either is missing.
//
// NOTHING live is contacted: every request is answered by a route here (react / babel / firebase from OPH_VENDOR or a stub, the worker's
// REST + auth endpoints from fixtures, tile images from a 1x1 PNG, Discord's authorize URL by a redirect to the local callback page).
// A request to any other host fails the run.
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const VENDOR = process.env.OPH_VENDOR;
let chromium;
try { chromium = require("playwright").chromium; } catch {
  try { chromium = require(path.join(require("child_process").execSync("npm root -g").toString().trim(), "playwright")).chromium; } catch { console.log("SKIP playwright not installed"); process.exit(0); }
}
const vendorFile = rel => (VENDOR ? path.join(VENDOR, "node_modules", rel) : null);
const VENDOR_FILES = {
  "unpkg.com/react@18.3.1/umd/react.production.min.js": vendorFile("react/umd/react.production.min.js"),
  "unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js": vendorFile("react-dom/umd/react-dom.production.min.js"),
  "unpkg.com/@babel/standalone@7.23.10/babel.min.js": vendorFile("@babel/standalone/babel.min.js"),
};
if (!VENDOR || Object.values(VENDOR_FILES).some(f => !fs.existsSync(f))) { console.log("SKIP OPH_VENDOR not set or incomplete"); process.exit(0); }

const MapSeed = require("../map_seed.js");

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────────────
const WORKER = "oph.opheliapp.workers.dev";
const IMG = "https://stub.invalid/img/";
const row = (id, ts, codename, extra = {}) => ({ id, tileset_id: ts, codename, image_url: IMG + codename + ".png", sort_index: 0, folder_key: null, sensor_code: null, sensor_roll: 1, symbol: null, size_multiplier: null, offset_x: null, offset_y: null, rotatable: false, flippable: false, otg_passable: false, mirror_offset: false, bottom_render: false, priority: false, auto_shadow: false, ...extra });
const TILESETS = [
  { id: "ts-0", name: "Snowtel Gifts", seed_id: 0, is_published: true, owner_id: null, folder_path: "Snow", profiles: null },
  { id: "ts-7", name: "Desert", seed_id: 7, is_published: true, owner_id: null, folder_path: "Desert", profiles: null },
];
const TILES = {
  "ts-0": [
    row("a0000000-0000-4000-8000-000000000001", "ts-0", "Wall1", { symbol: "M", sort_index: 1 }),
    row("a0000000-0000-4000-8000-000000000002", "ts-0", "Crate", { symbol: "Y", sort_index: 2 }),
    row("a0000000-0000-4000-8000-000000000003", "ts-0", "ObjA", { symbol: "8", sort_index: 3 }),
    row("a0000000-0000-4000-8000-000000000004", "ts-0", "ObjB", { symbol: "8", sort_index: 4 }),
    row("a0000000-0000-4000-8000-000000000005", "ts-0", "NoSymbol", { sort_index: 5 }),
    row("a0000000-0000-4000-8000-000000000006", "ts-0", "Walls_00000000", { folder_key: "Walls", sensor_code: "00000000", symbol: "X", sort_index: 6 }),
    row("a0000000-0000-4000-8000-000000000007", "ts-0", "Walls_11111111", { folder_key: "Walls", sensor_code: "11111111", symbol: "X", sort_index: 7 }),
  ],
  "ts-7": [
    row("b0000000-0000-4000-8000-000000000001", "ts-7", "Wall1", { symbol: "M", sort_index: 1 }),
    row("b0000000-0000-4000-8000-000000000002", "ts-7", "Cactus", { symbol: "T", sort_index: 2 }),
  ],
};
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const FIREBASE_STUB = `window.firebase={initializeApp(){},auth(){return{onAuthStateChanged(cb){setTimeout(()=>cb(null),0);return()=>{}},signInWithCustomToken:async()=>{},currentUser:{getIdToken:async()=>"id-token"}}}};`;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon" };

const startServer = () => new Promise(resolve => {
  const srv = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split("?")[0]);
    const f = path.join(ROOT, p === "/" ? "index.html" : p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  }).listen(0, "127.0.0.1", () => resolve(srv));
});

let passed = 0, failed = 0;
const results = [];
const test = async (name, fn) => {
  try { await fn(); passed++; console.log("ok   " + name); } catch (e) { failed++; process.exitCode = 1; console.error("FAIL " + name + "\n" + (e.stack || e)); }
};

(async () => {
  const srv = await startServer();
  const ORIGIN = "http://127.0.0.1:" + srv.address().port;
  const browser = await chromium.launch();
  const unexpected = [];
  const newPage = async ({ user = "valid", storage = {}, hash = "", seedSession = null } = {}) => {
    const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"], viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const logs = [];
    page.on("console", m => { if (m.type() === "error") logs.push(m.text()); });
    page.on("pageerror", e => logs.push("pageerror: " + e.message));
    await ctx.route("**/*", async route => {
      const url = new URL(route.request().url());
      const key = url.host + url.pathname;
      const reply = (status, body, type = "application/json") => route.fulfill({ status, contentType: type, body: typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body), headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
      if (route.request().method() === "OPTIONS") return reply(204, "");
      if (url.origin === ORIGIN) return route.continue();
      if (VENDOR_FILES[key]) return route.fulfill({ status: 200, contentType: "text/javascript", body: fs.readFileSync(VENDOR_FILES[key]) });
      if (url.host === "www.gstatic.com" && url.pathname.includes("firebase")) return reply(200, url.pathname.includes("app-compat") ? FIREBASE_STUB : "", "text/javascript");
      if (url.host === "fonts.googleapis.com" || url.host === "fonts.gstatic.com") return reply(200, "", "text/css");
      if (url.host === "stub.invalid") return reply(200, PNG, "image/png");
      if (url.host === "discord.com" && url.pathname === "/oauth2/authorize") return route.fulfill({ status: 302, headers: { location: ORIGIN + "/auth/callback.html?code=stub-code" } });
      if (url.host === WORKER) {
        const q = url.searchParams;
        if (url.pathname === "/rest/v1/tilesets") return reply(200, TILESETS);
        if (url.pathname === "/rest/v1/tiles") {
          const ts = (q.get("tileset_id") || "").replace(/^eq\./, "");
          if (ts) return reply(200, TILES[ts] || []);
          const id = (q.get("id") || "").replace(/^eq\./, "");
          const hit = Object.values(TILES).flat().find(r => r.id === id);
          return reply(200, hit ? [{ tileset_id: hit.tileset_id }] : []);
        }
        if (url.pathname === "/rest/v1/profiles") return reply(200, route.request().method() === "GET" ? [{ id: "u1", username: "tester", role: "user", theme: "auto" }] : []);
        if (url.pathname === "/discord-refresh") return reply(200, { access_token: "a2", refresh_token: "r2", expires_in: 3600 });
        if (url.pathname === "/firebase-refresh") return reply(200, { firebase_token: "custom" });
        if (url.pathname === "/discord-token") return reply(200, { firebase_token: "custom", access_token: "a", refresh_token: "r", expires_in: 3600, discord_user: { id: "u1", username: "tester", avatar: null } });
        unexpected.push("worker " + route.request().method() + " " + url.pathname);
        return reply(404, {});
      }
      unexpected.push(route.request().method() + " " + url.href);
      return route.abort();
    });
    const now = Date.now();
    const users = {
      valid: { id: "u1", username: "tester", firebaseToken: "t", firebaseTokenExpiry: now + 3600e3, accessToken: "a", refreshToken: "r", tokenExpiry: now + 7200e3 },
      expired: { id: "u1", username: "tester", firebaseToken: "old", firebaseTokenExpiry: now - 60e3, accessToken: "a", refreshToken: "r", tokenExpiry: now + 7200e3 },
    };
    await page.addInitScript(([u, s]) => {
      if (!sessionStorage.getItem("__init")) {
        sessionStorage.setItem("__init", "1");
        if (u) localStorage.setItem("oph_user", JSON.stringify(u));
        for (const [k, v] of Object.entries(s)) localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v));
      }
    }, [user ? users[user] : null, storage]);
    await page.goto(ORIGIN + "/index.html" + hash);
    return { page, ctx, logs };
  };
  const ready = async page => { await page.waitForSelector("[data-seed-row]", { timeout: 30000 }); await page.waitForFunction(() => document.querySelectorAll("[data-seed-row]").length > 0); };
  const saved = page => page.evaluate(() => ({ grid: JSON.parse(localStorage.getItem("oph_grid") || "null"), w: JSON.parse(localStorage.getItem("oph_gridW") || "null"), h: JSON.parse(localStorage.getItem("oph_gridH") || "null"), ts: JSON.parse(localStorage.getItem("oph_active_ts") || "null"), cc: JSON.parse(localStorage.getItem("oph_custom_center") || "null"), ccs: JSON.parse(localStorage.getItem("oph_custom_center_size") || "null"), mirror: JSON.parse(localStorage.getItem("oph_mirror") || "null") }));
  const settle = page => page.waitForTimeout(600);
  const symAt = (sv, r, c, tilesetRows) => { // palette entry (stored) at a cell, as a codename or ref
    const i = sv.grid.grid[r][c]; if (i == null) return null;
    const ref = sv.grid.palette[i - 1];
    const m = /^d:(.+)$/.exec(ref);
    if (m) { const hit = Object.values(TILES).flat().find(x => x.id === m[1]); return hit ? hit.codename : ref; }
    return ref;
  };
  const blank = (w, h) => Array.from({ length: h }, () => Array(w).fill(null));
  const encode = (w, h, cells, tileset, magnet) => { const g = blank(w, h); for (const [r, c, s] of cells) g[r][c] = s; return MapSeed.encode({ w, h, grid: g, tileset, magnet }).seed; };
  const SEED_A = encode(7, 5, [[0, 0, "M"], [0, 6, "M"], [2, 3, "Y"], [4, 0, "M"], [4, 6, "M"], [1, 1, "X"], [3, 5, "W"], [3, 1, "6"], [2, 2, "7"]], 0);
  const importViaField = async (page, seed) => { await page.fill("[data-seed-input]", seed); await page.waitForSelector("[data-seed-breakdown]"); await page.click("[data-seed-import]"); };

  await test("copy seed and share link on an empty map; export warns about tiles without symbols", async () => {
    const { page, ctx, logs } = await newPage();
    await ready(page);
    await page.click("[data-seed-copy]");
    await page.waitForSelector("[data-seed-status]");
    assert.strictEqual(await page.evaluate(() => navigator.clipboard.readText()), "3v3/x/4/0//8ZX");
    await page.click("[data-seed-link]");
    await settle(page);
    const link = await page.evaluate(() => navigator.clipboard.readText());
    assert.ok(link.startsWith(ORIGIN + "/index.html#seed=3v3%2Fx%2F4%2F0%2F%2F8ZX"), link);
    assert.strictEqual(await page.locator("[data-seed-blank]").count(), 0);
    await ctx.close();
  });

  await test("import via field: live breakdown, tiles by symbol, sensor folder, global tiles, warn/space, mirroring and size set", async () => {
    const { page, ctx, logs } = await newPage();
    await ready(page);
    await page.fill("[data-seed-input]", SEED_A);
    const bd = await page.waitForSelector("[data-seed-breakdown]");
    await page.waitForFunction(() => /Wall1/.test(document.querySelector("[data-seed-breakdown]").textContent));
    const text = await bd.textContent();
    assert.ok(/7 x 5/.test(text) && /default centre/.test(text) && /Snowtel Gifts \(seed_id 0\)/.test(text), text);
    assert.ok(/Y.*Crate/.test(text) && /X.*Walls \(sensor folder\)/.test(text) && /W.*water \(sensor folder\)/i.test(text), text);
    assert.ok(/35 = 7 x 5 OK/.test(text), text);
    await page.click("[data-seed-import]");
    await settle(page);
    const sv = await saved(page);
    assert.deepStrictEqual([sv.w, sv.h], [7, 5]);
    assert.strictEqual(symAt(sv, 0, 0), "Wall1");
    assert.strictEqual(symAt(sv, 0, 6), "Wall1");
    assert.strictEqual(symAt(sv, 2, 3), "Crate");
    assert.ok(/^s:ts-0\|Walls$/.test(symAt(sv, 1, 1)), symAt(sv, 1, 1));
    assert.strictEqual(symAt(sv, 3, 5), "s:global|water");
    assert.strictEqual(symAt(sv, 3, 1), "warn");
    assert.strictEqual(symAt(sv, 2, 2), "space");
    assert.strictEqual(symAt(sv, 1, 0), null);
    // the seed was symmetric left-right -> only the Horizontal (mirrorV) flag is on... the map also has top-bottom pairs; whichever class was chosen drives the flags
    const cls = MapSeed.decode(SEED_A).mirror;
    assert.deepStrictEqual([sv.mirror.v, sv.mirror.h, sv.mirror.d], [MapSeed.CLASS_FLAGS[cls].mirrorV, MapSeed.CLASS_FLAGS[cls].mirrorH, MapSeed.CLASS_FLAGS[cls].mirrorD]);
    // exporting the imported map gives the same seed back
    await page.click("[data-seed-copy]"); await settle(page);
    assert.strictEqual(await page.evaluate(() => navigator.clipboard.readText()), SEED_A);
    assert.deepStrictEqual(logs.filter(l => !/Failed to load resource|\[BABEL\]/.test(l)), []);
    await ctx.close();
  });

  await test("importing onto a non-empty map asks first; Cancel keeps the map; Import is ONE undo step; redo works", async () => {
    const { page, ctx } = await newPage();
    await ready(page);
    await importViaField(page, SEED_A); await settle(page);
    const before = await saved(page);
    const seedB = encode(4, 4, [[0, 0, "Y"], [3, 3, "Y"]], 0);
    await importViaField(page, seedB);
    await page.waitForSelector("[data-seed-import-modal]");
    assert.ok(/replaces your current map/.test(await page.textContent("[data-seed-import-modal]")));
    await page.click("[data-seed-import-modal] >> text=Cancel"); await settle(page);
    assert.deepStrictEqual(await saved(page), before);
    await page.click("[data-seed-import]");
    await page.click("[data-seed-confirm]"); await settle(page);
    let sv = await saved(page);
    assert.deepStrictEqual([sv.w, sv.h], [4, 4]);
    assert.strictEqual(symAt(sv, 0, 0), "Crate");
    await page.locator("body").press("Control+z"); await settle(page);
    sv = await saved(page);
    assert.deepStrictEqual([sv.w, sv.h], [7, 5]);
    assert.strictEqual(symAt(sv, 2, 3), "Crate");
    assert.strictEqual(symAt(sv, 3, 5), "s:global|water");
    await page.locator("body").press("Control+y"); await settle(page);
    sv = await saved(page);
    assert.deepStrictEqual([sv.w, sv.h], [4, 4]);
    await ctx.close();
  });

  await test("a symbol that matches several tiles opens the chooser; the chosen tile is used; unknown symbols are counted", async () => {
    const { page, ctx } = await newPage();
    await ready(page);
    const seed = encode(5, 3, [[0, 0, "8"], [1, 1, "8"], [2, 2, "?"], [0, 4, "M"]], 0);
    await importViaField(page, seed);
    await page.waitForSelector("[data-seed-import-modal]");
    const cards = page.locator("[data-seed-choose='8'] [data-seed-card]");
    assert.strictEqual(await cards.count(), 2);
    assert.ok(await page.locator("[data-seed-confirm]").isDisabled());
    await cards.nth(1).click();
    await page.click("[data-seed-confirm]"); await settle(page);
    const sv = await saved(page);
    assert.strictEqual(symAt(sv, 0, 0), "ObjB");
    assert.strictEqual(symAt(sv, 1, 1), "ObjB");
    assert.strictEqual(symAt(sv, 2, 2), null); // "?" matched nothing: blank
    assert.strictEqual(symAt(sv, 0, 4), "Wall1");
    assert.ok(/1 symbol \(\?\) matched no tile, 1 cell left blank/.test(await page.textContent("body")));
    await ctx.close();
  });

  await test("8 with no tileset match falls to the global objectives and asks too", async () => {
    const { page, ctx } = await newPage();
    await ready(page);
    const seed = encode(3, 3, [[1, 1, "c"]], 7); // tileset 7 (Desert) has no 8; "c" = blue teleporter (global)
    await importViaField(page, seed); await settle(page);
    const sv = await saved(page);
    assert.strictEqual(symAt(sv, 1, 1), "Resources/Global/Teleporters/Blue.png"); // stored form of a global ref is the bare path
    const seed8 = encode(3, 3, [[1, 1, "8"]], 7);
    await importViaField(page, seed8);
    await page.waitForSelector("[data-seed-import-modal]");
    assert.strictEqual(await page.locator("[data-seed-choose='8'] [data-seed-card]").count(), 8);
    await ctx.close();
  });

  await test("tileset switch through import: other tileset's tiles only, magnet + mirror set, unknown seed_id falls back with the notice", async () => {
    const { page, ctx } = await newPage();
    await ready(page);
    const seed = encode(9, 9, [[0, 0, "T"], [8, 8, "T"], [4, 4, "M"]], 7, { col: 3, row: 2, size: 2 });
    await importViaField(page, seed); await settle(page);
    let sv = await saved(page);
    assert.strictEqual(sv.ts, "Desert");
    assert.strictEqual(symAt(sv, 0, 0), "Cactus");
    assert.deepStrictEqual(sv.grid.palette.filter(r => r.startsWith("d:")).every(r => r.startsWith("d:b0000000")), true, "no tiles of two tilesets");
    // 'M' resolved in the Desert tileset (its own Wall1), not Snowtel's
    assert.ok(sv.grid.palette.some(r => r === "d:b0000000-0000-4000-8000-000000000001"));
    assert.deepStrictEqual(sv.cc, { r: 2, c: 3 });
    assert.strictEqual(sv.ccs, 2);
    // unknown seed_id -> tileset 0 with the notice
    const unknown = encode(3, 3, [[1, 1, "M"]], 99);
    await importViaField(page, unknown);
    await page.waitForSelector("[data-seed-import-modal]");
    assert.ok(/tileset not found, showing the default tileset/.test(await page.textContent("[data-seed-import-modal]")));
    await page.click("[data-seed-confirm]"); await settle(page);
    sv = await saved(page);
    assert.strictEqual(sv.ts, "Snowtel Gifts");
    assert.ok(/tileset not found, showing Snowtel Gifts/.test(await page.textContent("body")));
    assert.strictEqual(sv.cc, null);
    // undo goes back to the Desert map in one step
    await page.locator("body").press("Control+z"); await settle(page);
    sv = await saved(page);
    assert.strictEqual(sv.ts, "Desert");
    assert.deepStrictEqual(sv.cc, { r: 2, c: 3 });
    await ctx.close();
  });

  await test("bad input: every error is shown live, the Import button stays disabled, nothing is applied", async () => {
    const { page, ctx } = await newPage();
    await ready(page);
    const before = await saved(page);
    const good = SEED_A, f = good.split("/");
    const cases = [["junk", /6 parts/], [f.slice(0, 5).join("/"), /6 parts/], ["0x5/" + f.slice(1).join("/"), /Size/], [f[0] + "/9,9/" + f.slice(2).join("/"), /Magnet/], [f.slice(0, 5).join("/") + "/", /code is missing/], [f.slice(0, 5).join("/") + "/zzzzzzzzzz", /./]];
    for (const [text, re] of cases) {
      await page.fill("[data-seed-input]", text);
      await page.waitForSelector("[data-seed-breakdown]");
      const err = await page.textContent("[data-seed-breakdown]");
      assert.ok(re.test(err), text + " -> " + err);
      assert.ok(await page.locator("[data-seed-import]").isDisabled(), text);
    }
    assert.deepStrictEqual(await saved(page), before);
    await ctx.close();
  });

  await test("help button opens the explainer", async () => {
    const { page, ctx } = await newPage();
    await ready(page);
    await page.click("[data-seed-help]");
    assert.ok(/size \/ magnet \/ mirror \/ tileset \/ palette \/ code/.test(await page.textContent("[data-seed-help-modal]")));
    await ctx.close();
  });

  await test("share link, signed in, cold load: imported after tilesets load, fragment cleared", async () => {
    const hash = "#seed=" + encodeURIComponent(SEED_A);
    const { page, ctx } = await newPage({ hash });
    await ready(page); await settle(page);
    const sv = await saved(page);
    assert.deepStrictEqual([sv.w, sv.h], [7, 5]);
    assert.strictEqual(symAt(sv, 2, 3), "Crate");
    assert.strictEqual(new URL(page.url()).hash, "");
    await page.reload(); await ready(page); await settle(page);
    assert.deepStrictEqual([(await saved(page)).w, (await saved(page)).h], [7, 5], "a reload does not import again or lose the map");
    await ctx.close();
  });

  await test("share link, cold load with an EXPIRED token: refresh first, then import", async () => {
    const hash = "#seed=" + encodeURIComponent(SEED_A);
    const { page, ctx } = await newPage({ user: "expired", hash });
    await ready(page); await settle(page);
    const sv = await saved(page);
    assert.deepStrictEqual([sv.w, sv.h], [7, 5]);
    assert.strictEqual(new URL(page.url()).hash, "");
    await ctx.close();
  });

  await test("share link, signed OUT: login card first, the seed survives the Discord round trip and is imported afterwards", async () => {
    const hash = "#seed=" + encodeURIComponent(SEED_A);
    const { page, ctx } = await newPage({ user: null, hash });
    await page.waitForSelector("text=Login with Discord", { timeout: 30000 });
    assert.strictEqual(await page.locator("[data-seed-row]").count(), 0, "nothing is imported while signed out");
    await Promise.all([page.waitForURL(u => u.pathname.endsWith("/index.html") && !u.search, { timeout: 30000 }).catch(() => {}), page.click("text=Login with Discord")]);
    await ready(page); await settle(page);
    const sv = await saved(page);
    assert.deepStrictEqual([sv.w, sv.h], [7, 5], "imported after login");
    assert.strictEqual(symAt(sv, 2, 3), "Crate");
    assert.strictEqual(new URL(page.url()).hash, "");
    assert.strictEqual(await page.evaluate(() => sessionStorage.getItem("oph_return")), null);
    await ctx.close();
  });

  await test("share link onto a non-empty saved map asks before replacing", async () => {
    const hash = "#seed=" + encodeURIComponent(encode(4, 4, [[0, 0, "Y"]], 0));
    const { page, ctx } = await newPage();
    await ready(page);
    await importViaField(page, SEED_A); await settle(page);
    await page.evaluate(h => { location.hash = h; }, hash);
    await page.waitForSelector("[data-seed-import-modal]", { timeout: 10000 });
    assert.strictEqual(new URL(page.url()).hash, "");
    assert.deepStrictEqual([(await saved(page)).w], [7]);
    await page.click("[data-seed-confirm]"); await settle(page);
    assert.deepStrictEqual([(await saved(page)).w], [4]);
    await ctx.close();
  });

  await test("a broken share link shows the error and still clears the fragment", async () => {
    const { page, ctx } = await newPage({ hash: "#seed=3v3%2Fx%2F4" });
    await ready(page); await settle(page);
    assert.ok(/Seed not imported/.test(await page.textContent("body")));
    assert.strictEqual(new URL(page.url()).hash, "");
    await ctx.close();
  });

  await test("export counts tiles without symbols and says so", async () => {
    // a saved map holding the symbol-less tile: place it by importing a palette-less route is impossible, so seed the saved grid directly
    const storage = { oph_user_tiles: [{ id: 1, src: "data:image/png;base64," + PNG.toString("base64") }], oph_gridW: 3, oph_gridH: 3, oph_grid: { v: 2, palette: ["d:a0000000-0000-4000-8000-000000000005", "d:a0000000-0000-4000-8000-000000000001", "u:1"], grid: [[1, 2, null], [null, 1, 3], [null, null, 2]] } };
    const { page, ctx } = await newPage({ storage });
    await ready(page); await settle(page);
    const txt = await page.textContent("[data-seed-blank]");
    assert.ok(/3 cells use tiles without symbols or local uploads and will be blank/.test(txt) && /1 local upload/.test(txt) && /2 without a symbol/.test(txt), txt);
    await page.click("[data-seed-copy]"); await settle(page);
    const seed = await page.evaluate(() => navigator.clipboard.readText());
    const d = MapSeed.decode(seed);
    assert.ok(d.ok, seed + " " + d.error);
    assert.deepStrictEqual(d.grid, [[null, "M", null], [null, null, null], [null, null, "M"]]);
    await ctx.close();
  });

  await browser.close();
  srv.close();
  const bad = [...new Set(unexpected)];
  if (bad.length) { failed++; process.exitCode = 1; console.error("FAIL unexpected network requests:\n  " + bad.join("\n  ")); }
  console.log(`\n${passed} passed, ${failed} failed; unexpected network requests: ${bad.length}`);
})();
