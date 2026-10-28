// Shared stubbed-network browser harness (same stubs as seed_flow.e2e.js; NOTHING live is contacted).
//   const H = require("./e2e_harness.js");
//   const h = await H.start({ tilesets, tiles, role, onWorker });   // prints SKIP and exits 0 without OPH_VENDOR / playwright
//   h.newPage({ user, storage, hash, viewport }) -> { page, ctx, logs };  h.test(name, fn);  await h.finish();
// onWorker(route, url, reply) may answer extra worker endpoints (return true when handled). Every worker request is kept in h.requests.
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


const WORKER = "oph.opheliapp.workers.dev";
const IMG = "https://stub.invalid/img/";
const row = (id, ts, codename, extra = {}) => ({ id, tileset_id: ts, codename, image_url: IMG + codename + ".png", sort_index: 0, folder_key: null, sensor_code: null, sensor_roll: 1, symbol: null, size_multiplier: null, offset_x: null, offset_y: null, rotatable: false, flippable: false, otg_passable: false, mirror_offset: false, bottom_render: false, priority: false, auto_shadow: false, ...extra });
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


const start = async ({ tilesets, tiles, role = "user", onWorker, image } = {}) => {
  let passed = 0, failed = 0;
  const unexpected = [], requests = [];
  const srv = await startServer();
  const ORIGIN = "http://127.0.0.1:" + srv.address().port;
  const browser = await chromium.launch();
  const test = async (name, fn) => {
    try { await fn(); passed++; console.log("ok   " + name); } catch (e) { failed++; process.exitCode = 1; console.error("FAIL " + name + "\n" + (e.stack || e)); }
  };
  const newPage = async ({ user = "valid", storage = {}, hash = "", viewport = { width: 1280, height: 900 } } = {}) => {
    const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"], viewport });
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
      if (url.host === "stub.invalid") return reply(200, (image && image(url)) || PNG, "image/png"); // image(url) -> Buffer lets a test serve its own pixels
      if (url.host === "discord.com" && url.pathname === "/oauth2/authorize") return route.fulfill({ status: 302, headers: { location: ORIGIN + "/auth/callback.html?code=stub-code" + (url.searchParams.get("state") ? "&state=" + encodeURIComponent(url.searchParams.get("state")) : "") } });
      if (url.host === WORKER) {
        const q = url.searchParams;
        requests.push({ method: route.request().method(), path: url.pathname, query: url.search, body: route.request().postData() });
        if (onWorker && await onWorker(route, url, reply)) return;
        if (url.pathname === "/rest/v1/tilesets") return reply(200, tilesets);
        if (url.pathname === "/rest/v1/tiles") {
          const ts = (q.get("tileset_id") || "").replace(/^eq\./, "");
          if (ts) return reply(200, tiles[ts] || []);
          const id = (q.get("id") || "").replace(/^eq\./, "");
          const hit = Object.values(tiles).flat().find(r => r.id === id);
          return reply(200, hit ? [{ tileset_id: hit.tileset_id }] : []);
        }
        if (url.pathname === "/rest/v1/profiles") return reply(200, route.request().method() === "GET" ? [{ id: "u1", username: "tester", role, theme: "auto" }] : []);
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
  const ready = async page => { await page.waitForSelector("[data-seed-row], [data-map-seed-open]", { timeout: 30000 }); await page.waitForTimeout(300); };
  const saved = page => page.evaluate(() => ({ grid: JSON.parse(localStorage.getItem("oph_grid") || "null"), w: JSON.parse(localStorage.getItem("oph_gridW") || "null"), h: JSON.parse(localStorage.getItem("oph_gridH") || "null"), ts: JSON.parse(localStorage.getItem("oph_active_ts") || "null"), cc: JSON.parse(localStorage.getItem("oph_custom_center") || "null"), ccs: JSON.parse(localStorage.getItem("oph_custom_center_size") || "null"), mirror: JSON.parse(localStorage.getItem("oph_mirror") || "null") }));
  const settle = page => page.waitForTimeout(600);
  const finish = async () => {
    await browser.close();
    srv.close();
    const bad = [...new Set(unexpected)];
    if (bad.length) { failed++; process.exitCode = 1; console.error("FAIL unexpected network requests:\n  " + bad.join("\n  ")); }
    console.log(`\n${passed} passed, ${failed} failed; unexpected network requests: ${bad.length}`);
  };
  return { test, newPage, ready, saved, settle, finish, requests, ORIGIN, assert };
};
module.exports = { start, row, IMG, PNG, WORKER };
