// Run with: node tests/worker_security.test.js   (needs node 18+; the route tests also need the `openssl` CLI and print SKIP without it)
// Security phase: pure helpers extracted from worker.js (<security-helpers>) and auth/callback.html (<oauth-state-check>), plus route-level tests of the
// real Worker with a MOCKED global fetch (nothing live is contacted; a request to any unexpected host fails the test).
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const crypto = require("crypto");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const src = fs.readFileSync(path.join(__dirname, "..", "worker.js"), "utf8");
const block = /\/\/ <security-helpers>([\s\S]*?)\/\/ <\/security-helpers>/.exec(src);
if (!block) throw new Error("security-helpers block not found in worker.js");
const H = new Function(block[1] + "\nreturn { proxyTableFor, isJsonContentType, isSanitisableBody, base64Head, imageMatchesExtension, folderOwnership, discordUserFromOAuthMe };")();
const html = fs.readFileSync(path.join(__dirname, "..", "auth", "callback.html"), "utf8");
const sb = /\/\/ <oauth-state-check>([\s\S]*?)\/\/ <\/oauth-state-check>/.exec(html);
if (!sb) throw new Error("oauth-state-check block not found in callback.html");
const { checkOAuthState } = new Function(sb[1] + "\nreturn { checkOAuthState };")();

const b64 = bytes => Buffer.from(bytes).toString("base64");
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
const JPG = [0xff, 0xd8, 0xff, 0xe0, 0, 16];
const GIF89 = [...Buffer.from("GIF89a"), 1, 0, 1, 0];
const GIF87 = [...Buffer.from("GIF87a"), 1, 0, 1, 0];
const WEBP = [...Buffer.from("RIFF"), 4, 0, 0, 0, ...Buffer.from("WEBP"), 0x56, 0x50];

// ── Pure helpers ──────────────────────────────────────────────────────────────────────────────────────
test("M-1 path allowlist: exactly /rest/v1/{profiles,tilesets,tiles}; rpc, storage, the root and sub-paths are refused", () => {
  for (const t of ["profiles", "tilesets", "tiles"]) assert.strictEqual(H.proxyTableFor("/rest/v1/" + t), t);
  for (const p of ["/rest/v1/", "/rest/v1", "/rest/v1/rpc/delete_everything", "/rest/v1/rpc", "/storage/v1/object/x", "/storage/v1/", "/rest/v1/tiles/x", "/rest/v1/tiles/", "/rest/v1/tilesx",
    "/rest/v1/profiles/../rpc/x", "/rest/v1/tiles%2f..%2frpc", "/rest/v1/other", "/auth/v1/user", "/", "", "/rest/v1/TILES", "//rest/v1/tiles", "/rest/v1/tiles?select=*", "/rest/v1/tiles\n", "/x/rest/v1/tiles", undefined, null])
    assert.strictEqual(H.proxyTableFor(p), null, String(p));
});

test("H-2 content type and body shape", () => {
  for (const ok of ["application/json", "Application/JSON", "application/json; charset=utf-8", " application/json ;x=1"]) assert.strictEqual(H.isJsonContentType(ok), true, ok);
  for (const bad of ["text/plain", "application/x-www-form-urlencoded", "application/jsonp", "application/json+x", "", null, undefined, "multipart/form-data; boundary=a"]) assert.strictEqual(H.isJsonContentType(bad), false, String(bad));
  assert.ok(H.isSanitisableBody({ a: 1 }) && H.isSanitisableBody([{ a: 1 }, { b: 2 }]));
  for (const bad of [null, "str", 5, true, [], [1], [null], [{ a: 1 }, "x"], undefined]) assert.strictEqual(H.isSanitisableBody(bad), false, JSON.stringify(bad));
});

test("L-2 magic bytes: each extension accepts its format and rejects the others", () => {
  const files = { ".png": PNG, ".jpg": JPG, ".jpeg": JPG, ".gif": GIF89, ".webp": WEBP };
  const all = { png: PNG, jpg: JPG, gif89: GIF89, gif87: GIF87, webp: WEBP };
  for (const [ext, bytes] of Object.entries(files)) {
    assert.strictEqual(H.imageMatchesExtension(ext, H.base64Head(b64(bytes))), true, ext);
    assert.strictEqual(H.imageMatchesExtension(ext.toUpperCase(), H.base64Head(b64(bytes))), true, ext + " upper");
  }
  assert.strictEqual(H.imageMatchesExtension(".gif", H.base64Head(b64(GIF87))), true);
  for (const [ext, bytes] of Object.entries({ ".png": [...Buffer.from("<html>")], ".jpg": PNG, ".gif": WEBP, ".webp": [...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WAVE")], ".jpeg": GIF89 })) {
    assert.strictEqual(H.imageMatchesExtension(ext, H.base64Head(b64([...bytes, 0, 0, 0, 0, 0, 0]))), false, ext);
  }
  assert.strictEqual(H.imageMatchesExtension(".svg", H.base64Head(b64(PNG))), false, "unknown extension");
  assert.strictEqual(H.imageMatchesExtension(".png", null), false);
  assert.strictEqual(H.imageMatchesExtension(".png", H.base64Head(b64(PNG.slice(0, 4)))), false, "truncated signature");
  assert.strictEqual(H.imageMatchesExtension(".webp", H.base64Head(b64(WEBP.slice(0, 10)))), false, "RIFF without WEBP");
  assert.strictEqual(H.base64Head("!!!not base64!!!"), null);
  assert.strictEqual(H.base64Head(42), null);
  assert.strictEqual(H.base64Head(b64(PNG).slice(0, 4)).length >= 3, true, "short / unpadded heads decode");
  // whitespace inside the head is ignored (GitHub accepts wrapped base64)
  assert.strictEqual(H.imageMatchesExtension(".png", H.base64Head(b64(PNG).replace(/^(.{8})/, "$1\n"))), true);
});

test("M-2 folder ownership: all rows (case-insensitive) must be the caller's, at least one row", () => {
  const rows = [{ folder_path: "Desert", owner_id: "u1" }, { folder_path: "desert", owner_id: "u2" }, { folder_path: "Snow", owner_id: "u1" }, { folder_path: "Sn_w", owner_id: "u9" }];
  assert.strictEqual(H.folderOwnership(rows, "Snow", "u1").ok, true);
  assert.strictEqual(H.folderOwnership(rows, "SNOW", "u1").ok, true, "case-insensitive match of the caller's own row");
  assert.strictEqual(H.folderOwnership(rows, "Desert", "u1").ok, false, "a case-variant row owned by someone else blocks it");
  assert.strictEqual(H.folderOwnership(rows, "desert", "u2").ok, false);
  assert.strictEqual(H.folderOwnership(rows, "Sn_w", "u1").ok, false, "'_' is not a wildcard here");
  assert.strictEqual(H.folderOwnership(rows, "Nope", "u1").ok, false, "no row at all");
  assert.strictEqual(H.folderOwnership([], "Snow", "u1").ok, false);
  assert.strictEqual(H.folderOwnership([{ folder_path: "Snow", owner_id: null }], "Snow", "u1").ok, false, "unowned");
  assert.strictEqual(H.folderOwnership([{ folder_path: "Snow", owner_id: "u1" }], "Snow", "").ok, false, "no uid");
  assert.strictEqual(H.folderOwnership(null, "Snow", "u1").ok, false);
  assert.match(H.folderOwnership(rows, "Nope", "u1").error, /No tileset you can access/);
  assert.match(H.folderOwnership(rows, "Desert", "u1").error, /do not own/);
});

test("H-1 oauth2/@me answer: our application id and a numeric user id, nothing else", () => {
  const good = { application: { id: "123" }, user: { id: "999", username: "a" }, scopes: ["identify"] };
  assert.deepStrictEqual(H.discordUserFromOAuthMe(good, "123"), { id: "999", username: "a" });
  assert.strictEqual(H.discordUserFromOAuthMe({ ...good, application: { id: "124" } }, "123"), null, "another app's token");
  assert.strictEqual(H.discordUserFromOAuthMe({ ...good, application: undefined }, "123"), null);
  assert.strictEqual(H.discordUserFromOAuthMe({ ...good, application: { id: 123 } }, "123") !== null, true, "numeric id compares as string");
  assert.strictEqual(H.discordUserFromOAuthMe({ ...good, user: undefined }, "123"), null, "no identify scope");
  assert.strictEqual(H.discordUserFromOAuthMe({ ...good, user: { id: "abc" } }, "123"), null);
  assert.strictEqual(H.discordUserFromOAuthMe({ ...good, user: { id: 999 } }, "123"), null);
  assert.strictEqual(H.discordUserFromOAuthMe(good, undefined), null, "fails closed without a configured client id");
  assert.strictEqual(H.discordUserFromOAuthMe(good, ""), null);
  assert.strictEqual(H.discordUserFromOAuthMe(null, "123"), null);
  assert.strictEqual(H.discordUserFromOAuthMe("x", "123"), null);
});

test("I-1 state check: equal non-empty strings only", () => {
  assert.strictEqual(checkOAuthState("abc_DEF-123", "abc_DEF-123"), true);
  for (const [a, b] of [["abc", "abd"], ["abc", "abcd"], ["abcd", "abc"], ["", ""], [null, "x"], ["x", null], [undefined, undefined], ["x", undefined], [1, 1], ["abc", "ABC"]]) assert.strictEqual(checkOAuthState(a, b), false, JSON.stringify([a, b]));
});

test("I-1 callback.html wiring: state checked before the code exchange; redirect_uri no longer sent; deep-link stash untouched", () => {
  const i = html.indexOf("checkOAuthState(storedState"), j = html.indexOf("/discord-token");
  assert.ok(i > 0 && j > i, "state is verified before the token request");
  assert.ok(!/redirect_uri/.test(html.slice(j)), "the client does not send a redirect_uri");
  assert.ok(!/oph_return/.test(html), "the callback never touches the deep-link stash (index.html restores it)");
  const idx = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const login = idx.slice(idx.indexOf("const loginWithDiscord"), idx.indexOf("const logout"));
  assert.ok(/sessionStorage\.setItem\('oph_oauth_state'/.test(login) && /state: oauthState/.test(login) && /pkce_verifier/.test(login) && /oph_return/.test(login));
});

// ── Route tests: the real worker.js with a mocked fetch ───────────────────────────────────────────────
const haveOpenssl = (() => { try { cp.execSync("openssl version", { stdio: "ignore" }); return true; } catch { return false; } })();
const route = (name, fn) => test(name, async () => { if (!haveOpenssl) { console.log("SKIP " + name + " (no openssl)"); passed--; return; } await fn(); });

let W, certPem, signKey, env, calls, handlers;
const setup = async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wsec-"));
  cp.execSync(`openssl req -x509 -newkey rsa:2048 -nodes -subj /CN=test -keyout ${dir}/k.pem -out ${dir}/c.pem -days 2`, { stdio: "ignore" });
  certPem = fs.readFileSync(dir + "/c.pem", "utf8");
  signKey = fs.readFileSync(dir + "/k.pem", "utf8");
  fs.copyFileSync(path.join(__dirname, "..", "worker.js"), dir + "/worker.mjs");
  W = (await import("file://" + dir + "/worker.mjs")).default;
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  env = {
    SUPABASE_URL: "https://sb.test", SUPABASE_ANON_KEY: "anon", DISCORD_CLIENT_ID: "123", DISCORD_CLIENT_SECRET: "secret", GITHUB_BOT_TOKEN: "ghp",
    FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ client_email: "svc@x.iam", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) }),
  };
};
const b64u = o => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
const jwt = (uid, over = {}) => {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u({ alg: "RS256", kid: "k1", typ: "JWT" }), p = b64u({ aud: "opheliapp-wow", iss: "https://securetoken.google.com/opheliapp-wow", sub: uid, iat: now - 5, exp: now + 3600, ...over });
  const sig = crypto.createSign("RSA-SHA256").update(`${h}.${p}`).sign(signKey).toString("base64url");
  return `${h}.${p}.${sig}`;
};
const realFetch = global.fetch;
const mockFetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  const method = (init.method || (typeof input !== "string" && input.method) || "GET").toUpperCase();
  let body = init.body;
  if (typeof input !== "string" && body === undefined && input.body) body = await input.clone().text();
  calls.push({ url, method, body: typeof body === "string" ? body : body instanceof URLSearchParams ? body.toString() : body, headers: init.headers || (typeof input !== "string" ? Object.fromEntries(input.headers) : {}) });
  for (const h of handlers) { const r = await h(url, method, body, init); if (r) return r; }
  throw new Error("UNEXPECTED fetch " + method + " " + url);
};
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
const baseHandlers = () => [
  url => url.startsWith("https://www.googleapis.com/robot/v1/metadata/x509/") ? json({ k1: certPem }) : null,
  url => /^https:\/\/sb\.test\/rest\/v1\/profiles\?id=eq\.([^&]+)&select=role/.exec(url) ? json([{ role: ROLES[decodeURIComponent(/eq\.([^&]+)/.exec(url)[1])] }].filter(r => r.role)) : null,
];
let ROLES = {};
const call = (method, p, { headers = {}, body } = {}) => W.fetch(new Request("https://worker.test" + p, { method, headers, body }), env);
const authH = (uid, extra = {}) => ({ Authorization: "Bearer " + jwt(uid), ...extra });

route("setup: the real worker.js loads with a mocked fetch", async () => { await setup(); global.fetch = mockFetch; assert.strictEqual(typeof W.fetch, "function"); });

const fresh = (extra = []) => { calls = []; ROLES = { admin1: "admin", creator1: "creator", user1: "user" }; handlers = [...extra, ...baseHandlers()]; };

route("M-1 proxy: only the three tables are forwarded; rpc / storage / root / sub-paths / odd casing are 403 and nothing reaches Supabase", async () => {
  fresh([url => url.startsWith("https://sb.test/rest/v1/tiles") ? json([{ id: 1 }]) : null]);
  for (const p of ["/rest/v1/rpc/x", "/rest/v1/", "/rest/v1", "/storage/v1/object/public/x", "/rest/v1/tiles/extra", "/rest/v1/other", "/rest/v1/tiles%2f..%2frpc"]) {
    const r = await call("GET", p);
    assert.strictEqual(r.status, 403, p);
    assert.deepStrictEqual(await r.json(), { error: "Forbidden" });
  }
  assert.strictEqual(calls.length, 0, "no upstream request for refused paths");
  const ok = await call("GET", "/rest/v1/tiles?select=*&limit=1");
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(calls[0].url, "https://sb.test/rest/v1/tiles?select=*&limit=1", "the path is rebuilt from the allowlisted table");
  const mixed = await call("GET", "//REST/v1/Tiles?select=id");
  assert.strictEqual(mixed.status, 200);
  assert.strictEqual(calls[1].url, "https://sb.test/rest/v1/tiles?select=id", "casing and doubled slashes are normalised before forwarding, never forwarded as typed");
});

route("H-2 proxy writes: JSON only (415), unparseable or non-object bodies 400 and never forwarded, sanitising still applies", async () => {
  fresh([(url, method) => url.startsWith("https://sb.test/rest/v1/tiles") ? json([{ id: "n" }], 201) : null]);
  let r = await call("POST", "/rest/v1/tiles", { headers: authH("user1", { "Content-Type": "text/plain" }), body: '{"codename":"x"}' });
  assert.strictEqual(r.status, 415); assert.deepStrictEqual(await r.json(), { error: "Content-Type must be application/json" });
  r = await call("POST", "/rest/v1/tiles", { headers: authH("user1"), body: '{"codename":"x"}' }); // fetch sets text/plain for string bodies
  assert.strictEqual(r.status, 415);
  r = await call("PATCH", "/rest/v1/tiles?id=eq.1", { headers: authH("user1", { "Content-Type": "application/json" }), body: "{not json" });
  assert.strictEqual(r.status, 400); assert.deepStrictEqual(await r.json(), { error: "Invalid or unreadable JSON body" });
  for (const bad of ['"str"', "5", "null", "[]", "[1]"]) {
    r = await call("POST", "/rest/v1/tiles", { headers: authH("user1", { "Content-Type": "application/json" }), body: bad });
    assert.strictEqual(r.status, 400, bad);
  }
  assert.strictEqual(calls.filter(c => c.url.startsWith("https://sb.test/rest/v1/tiles")).length, 0, "nothing forwarded");
  r = await call("PUT", "/rest/v1/tiles", { headers: authH("user1", { "Content-Type": "application/json; charset=utf-8" }), body: JSON.stringify({ codename: "x", last_updated_by: "someone-else", owner_id: "victim", role: "admin" }) });
  assert.strictEqual(r.status, 201);
  const fwd = JSON.parse(calls.find(c => c.url.startsWith("https://sb.test/rest/v1/tiles")).body);
  assert.strictEqual(fwd.last_updated_by, "user1", "last_updated_by is the verified uid"); assert.strictEqual(fwd.owner_id, "user1", "owner_id forced for a non-admin"); assert.ok(!("role" in fwd), "role stripped");
});

route("L-4 proxy writes need a VERIFIED Firebase token: forged / unsigned / wrong-audience tokens are 401", async () => {
  fresh([url => url.startsWith("https://sb.test/rest/v1/tiles") ? json([{ id: 1 }]) : null]);
  const forged = `${b64u({ alg: "RS256", kid: "k1" })}.${b64u({ aud: "opheliapp-wow", iss: "https://securetoken.google.com/opheliapp-wow", sub: "admin1", exp: 9999999999, iat: 1 })}.AAAA`;
  const wrongAud = jwt("admin1", { aud: "other" });
  for (const tok of [forged, wrongAud, "garbage", jwt("admin1", { exp: 1 })]) {
    const r = await call("DELETE", "/rest/v1/tiles?id=eq.1", { headers: { Authorization: "Bearer " + tok } });
    assert.strictEqual(r.status, 401, tok.slice(0, 20));
    assert.deepStrictEqual(await r.json(), { error: "Invalid token" });
  }
  assert.strictEqual((await call("DELETE", "/rest/v1/tiles?id=eq.1")).status, 401);
  const ok = await call("DELETE", "/rest/v1/tiles?id=eq.1", { headers: authH("user1") });
  assert.strictEqual(ok.status, 200);
  // admin-only table delete: the X-Discord-Token fallback is gone
  fresh([url => url.startsWith("https://discord.com/") ? json({ application: { id: "123" }, user: { id: "777" } }) : null, url => url.startsWith("https://sb.test/rest/v1/profiles?id=eq.u9") ? json([]) : null]);
  ROLES["777"] = "admin";
  const noFallback = await call("DELETE", "/rest/v1/profiles?id=eq.u9", { headers: authH("user1", { "X-Discord-Token": "any" }) });
  assert.strictEqual(noFallback.status, 403);
  assert.ok(!calls.some(c => c.url.startsWith("https://discord.com/")), "X-Discord-Token never triggers a Discord call");
  const adminDel = await call("DELETE", "/rest/v1/profiles?id=eq.u9", { headers: authH("admin1") });
  assert.notStrictEqual(adminDel.status, 403);
  // uid is URL-encoded in the role lookup
  fresh([url => url.startsWith("https://sb.test/rest/v1/profiles?id=eq.") ? json([]) : null]);
  await call("DELETE", "/rest/v1/profiles?id=eq.u9", { headers: authH("a&select=*&x=b") });
  const lookup = calls.find(c => c.url.startsWith("https://sb.test/rest/v1/profiles?id=eq."));
  assert.ok(lookup && lookup.url.includes("id=eq.a%26select%3D*%26x%3Db&select=role"), lookup && lookup.url);
});

route("H-1 /firebase-refresh and /discord-token: the Discord token must belong to OUR application (else 401)", async () => {
  const me = (app, user = { id: "55", username: "n", avatar: null }) => url => url === "https://discord.com/api/oauth2/@me" ? json({ application: { id: app }, user }) : null;
  fresh([me("999")]); // another application's token
  let r = await call("POST", "/firebase-refresh", { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ access_token: "foreign" }) });
  assert.strictEqual(r.status, 401); assert.deepStrictEqual(await r.json(), { error: "Invalid Discord access token" });
  assert.ok(calls.some(c => c.url === "https://discord.com/api/oauth2/@me" && c.headers.Authorization === "Bearer foreign"), "oauth2/@me is the check");
  assert.ok(!calls.some(c => c.url === "https://discord.com/api/users/@me"), "the old users/@me check is gone");
  fresh([me("123", { id: "not-numeric" })]);
  r = await call("POST", "/firebase-refresh", { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ access_token: "t" }) });
  assert.strictEqual(r.status, 401);
  fresh([url => url === "https://discord.com/api/oauth2/@me" ? new Response("nope", { status: 401 }) : null]);
  r = await call("POST", "/firebase-refresh", { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ access_token: "t" }) });
  assert.strictEqual(r.status, 401);
  fresh([url => { if (url === "https://discord.com/api/oauth2/@me") throw new Error("network down"); return null; }]);
  r = await call("POST", "/firebase-refresh", { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ access_token: "t" }) });
  assert.strictEqual(r.status, 401, "fails closed on a network error");
  const saved = env.DISCORD_CLIENT_ID; delete env.DISCORD_CLIENT_ID;
  fresh([me("123")]);
  r = await call("POST", "/firebase-refresh", { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ access_token: "t" }) });
  assert.strictEqual(r.status, 401, "fails closed without DISCORD_CLIENT_ID"); env.DISCORD_CLIENT_ID = saved;
  r = await call("POST", "/firebase-refresh", { headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
  assert.strictEqual(r.status, 400);
  fresh([me("123")]); // ours -> a Firebase custom token
  r = await call("POST", "/firebase-refresh", { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ access_token: "good" }) });
  assert.strictEqual(r.status, 200);
  const tok = (await r.json()).firebase_token;
  assert.strictEqual(JSON.parse(Buffer.from(tok.split(".")[1], "base64url")).uid, "55");
});

route("I-2 /discord-token: the redirect_uri is fixed in the Worker (a client value is ignored), and the token is checked against our app", async () => {
  const tokenHandler = url => url === "https://discord.com/api/oauth2/token" ? json({ access_token: "at", refresh_token: "rt", expires_in: 604800 }) : null;
  const me = app => url => url === "https://discord.com/api/oauth2/@me" ? json({ application: { id: app }, user: { id: "55", username: "n", global_name: "N", avatar: "av" } }) : null;
  fresh([tokenHandler, me("123")]);
  let r = await call("POST", "/discord-token", { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "c", code_verifier: "v", redirect_uri: "https://evil.example/cb" }) });
  assert.strictEqual(r.status, 200);
  const form = new URLSearchParams(calls.find(c => c.url === "https://discord.com/api/oauth2/token").body);
  assert.strictEqual(form.get("redirect_uri"), "https://bicipikay.github.io/ophelia/auth/callback.html");
  assert.strictEqual(form.get("client_id"), "123");
  const out = await r.json();
  assert.deepStrictEqual([out.discord_user.id, out.discord_user.username, out.access_token], ["55", "N", "at"]);
  // the redirect_uri is no longer required from the client
  fresh([tokenHandler, me("123")]);
  r = await call("POST", "/discord-token", { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "c", code_verifier: "v" }) });
  assert.strictEqual(r.status, 200);
  r = await call("POST", "/discord-token", { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "c" }) });
  assert.strictEqual(r.status, 400); assert.deepStrictEqual(await r.json(), { error: "Missing required fields: code, code_verifier" });
  fresh([tokenHandler, me("999")]);
  r = await call("POST", "/discord-token", { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "c", code_verifier: "v" }) });
  assert.strictEqual(r.status, 401); assert.deepStrictEqual(await r.json(), { error: "Failed to verify Discord user" });
});

route("L-2 /github/upload: magic bytes must match the extension (400 bad_content); a matching image goes through", async () => {
  const gh = (url, method) => {
    if (!url.startsWith("https://api.github.com/repos/bicipikay/ophelia/contents/")) return null;
    return method === "GET" ? new Response("{}", { status: 404 }) : json({ content: { sha: "s" } }, 201);
  };
  fresh([gh, url => url.includes("/rest/v1/tilesets?folder_path=ilike.") ? json([{ id: "t1", owner_id: "creator1", folder_path: "Snow" }]) : null]);
  const up = (file, content) => call("POST", "/github/upload", { headers: authH("creator1", { "Content-Type": "application/json" }), body: JSON.stringify({ filePath: "Resources/Snow/" + file, contentBase64: content, commitMessage: "m" }) });
  let r = await up("a.png", b64([...Buffer.from("<html><script>")]));
  assert.strictEqual(r.status, 400);
  assert.deepStrictEqual(await r.json(), { error: "File content does not match its extension (.png)", code: "bad_content" });
  r = await up("a.jpg", b64(PNG)); assert.strictEqual(r.status, 400);
  r = await up("a.png", "!!!"); assert.strictEqual(r.status, 400);
  assert.deepStrictEqual(await r.json(), { error: "contentBase64 is not valid base64", code: "bad_content" });
  assert.ok(!calls.some(c => c.url.startsWith("https://api.github.com/") && c.method === "PUT"), "nothing is written to GitHub on a mismatch");
  for (const [f, bytes] of [["b.png", PNG], ["b.jpg", JPG], ["b.jpeg", JPG], ["b.gif", GIF89], ["b.webp", WEBP]]) {
    r = await up(f, b64([...bytes, 1, 2, 3, 4, 5, 6, 7, 8]));
    assert.strictEqual(r.status, 201, f);
  }
});

route("M-2 /github/*: ownership needs ALL rows (case-insensitive) to be the caller's; rows hidden from the caller's token are still seen; Global stays admin-only", async () => {
  const gh = (url, method) => url.startsWith("https://api.github.com/repos/bicipikay/ophelia/contents/") ? (method === "GET" ? new Response("{}", { status: 404 }) : json({ ok: 1 }, 201)) : null;
  const png = b64([...PNG, 1, 2, 3, 4]);
  const up = (uid, folder) => call("POST", "/github/upload", { headers: authH(uid, { "Content-Type": "application/json" }), body: JSON.stringify({ filePath: `Resources/${folder}/a.png`, contentBase64: png }) });
  // own row only
  fresh([gh, url => url.includes("/tilesets?folder_path=ilike.") ? json([{ id: "t1", owner_id: "creator1", folder_path: "Snow" }]) : null]);
  assert.strictEqual((await up("creator1", "Snow")).status, 201);
  assert.ok(calls.some(c => c.url.includes("folder_path=ilike.Snow") && c.headers.Authorization === "Bearer " + calls.find(x => x.url.includes("ilike")).headers.Authorization.slice(7)));
  // a case-variant row owned by someone else
  fresh([gh, url => url.includes("/tilesets?folder_path=ilike.") ? json([{ id: "t1", owner_id: "creator1", folder_path: "Snow" }, { id: "t2", owner_id: "other", folder_path: "snow" }]) : null]);
  let r = await up("creator1", "Snow");
  assert.strictEqual(r.status, 403); assert.match((await r.json()).error, /^Forbidden: You do not own the tileset for folder "Snow"/);
  // the other row is visible only to the anon read (RLS hides it from the caller's token): still blocks
  fresh([gh, (url, m, b, init) => !url.includes("/tilesets?folder_path=ilike.") ? null : (String(init.headers.Authorization).includes("anon") ? json([{ id: "t1", owner_id: "creator1", folder_path: "Snow" }, { id: "t2", owner_id: "other", folder_path: "SNOW" }]) : json([{ id: "t1", owner_id: "creator1", folder_path: "Snow" }]))]);
  assert.strictEqual((await up("creator1", "Snow")).status, 403);
  // no row at all
  fresh([gh, url => url.includes("/tilesets?folder_path=ilike.") ? json([]) : null]);
  r = await up("creator1", "Ghost"); assert.strictEqual(r.status, 403); assert.match((await r.json()).error, /No tileset you can access uses folder "Ghost"/);
  // Global: admin only, no lookup needed; the admin passes
  fresh([gh]);
  r = await up("creator1", "Global"); assert.strictEqual(r.status, 403); assert.match((await r.json()).error, /Resources\/Global is admin-only/);
  assert.strictEqual((await up("admin1", "Global")).status, 201);
  // a plain user is not a creator
  assert.strictEqual((await up("user1", "Snow")).status, 403);
});

route("CORS: X-Discord-Token is no longer an allowed header", async () => {
  fresh();
  const r = await call("OPTIONS", "/rest/v1/tiles");
  assert.strictEqual(r.status, 204);
  assert.ok(!/x-discord-token/i.test(r.headers.get("Access-Control-Allow-Headers")));
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log("ok   " + name); } catch (e) { console.error("FAIL " + name + "\n" + (e.stack || e)); process.exitCode = 1; }
  }
  global.fetch = realFetch;
  console.log(`\n${passed} passed`);
})();
