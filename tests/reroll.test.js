// Run with: node tests/reroll.test.js   (no dependencies)
// Reroll mode OFF (deterministic ties), variant picks, and the manifest tie-break ("tieBreak" / "reroll": false) of the Rails block.
const assert = require("assert");
const S = require("../sensor.js");
const U = require("../sensor_ui.js");
const manifest = require("../Resources/manifest.json").global;
let passed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log("ok   " + name); } catch (e) { console.error("FAIL " + name + "\n" + e.stack); process.exitCode = 1; } };

const T = (ref, sensorCode, sortIndex = 0, extra = {}) => ({ ref, codename: ref, sensorCode, sensorRoll: 1, sortIndex, ...extra });
const folderOf = (tiles, cfg = {}) => U.engineFolder(U.makeFolder({ scope: "t", folderKey: "F", tiles, cfg }));
const pick = (folder, nb, ctx = {}) => S.resolve(folder, nb, { x: 0, y: 0, salt: "F", ...ctx });

// ── Rails from the real manifest ──────────────────────────────────────────────────────────────────────
const rails = () => {
  const cfg = manifest.sensor.rails;
  const files = U.globalFolderFiles(manifest.folders.rails, cfg);
  const tiles = files.map((f, i) => ({ ref: "g:Resources/Global/Rails/" + f, codename: cfg.names[f], sensorCode: cfg.codes[f], sensorRoll: 1, sortIndex: i, dbRotatable: false, dbFlippable: false }));
  return U.makeFolder({ scope: "global", folderKey: "rails", label: "Rails", tiles, cfg });
};
const HORIZ = "g:Resources/Global/Rails/Fence.png", VERT = "g:Resources/Global/Rails/Ver.png";

test("manifest: the rails block carries tieBreak and reroll false, and they reach the engine folder", () => {
  assert.deepStrictEqual(manifest.sensor.rails.tieBreak, ["00011000", "01000010"]);
  assert.strictEqual(manifest.sensor.rails.reroll, false);
  const f = U.engineFolder(rails());
  assert.deepStrictEqual(S.tieBreakOf(f), ["00011000", "01000010"]);
  assert.strictEqual(S.isRerollable(f), false);
  assert.strictEqual(S.hasRerollableTies(f), false, "no hash-decided pick is left");
  // water has neither
  assert.strictEqual(S.isRerollable(U.engineFolder(U.makeFolder({ scope: "global", folderKey: "water", tiles: [T("w", "00001011")], cfg: manifest.sensor.water }))), true);
});

test("rails: E-only, W-only and a lone rail are horizontal; N-only and S-only are vertical; W+E horizontal, N+S vertical", () => {
  const f = U.engineFolder(rails());
  const cases = [["00001000", HORIZ, "E"], ["00010000", HORIZ, "W"], ["00000000", HORIZ, "lone"], ["01000000", VERT, "N"], ["00000010", VERT, "S"], ["00011000", HORIZ, "W+E"], ["01000010", VERT, "N+S"]];
  for (const [nb, want, label] of cases) {
    for (const ctx of [{}, { reroll: 7 }, { reroll: -12345, x: 5, y: 9 }, { deterministic: true }]) {
      const r = pick(f, nb, ctx);
      assert.strictEqual(r.ref, want, `${label} ${JSON.stringify(ctx)} -> ${r.ref}`);
    }
  }
});

test("rails: corners still pick the corner (exact codes win outright)", () => {
  const f = U.engineFolder(rails());
  assert.strictEqual(pick(f, "01001000").ref, "g:Resources/Global/Rails/TR.png");
  assert.strictEqual(pick(f, "00010010").ref, "g:Resources/Global/Rails/BL.png");
});

// ── tieBreak rule ─────────────────────────────────────────────────────────────────────────────────────
test("tieBreak: the first LISTED code that is among the tied ones wins, otherwise the normal rule", () => {
  const tiles = [T("a", "00011000", 0), T("b", "01000010", 1), T("c", "01001000", 2), T("d", "00001010", 3)];
  const withTb = folderOf(tiles, { tieBreak: ["01000010", "00011000"] });
  const noTb = folderOf(tiles, {});
  // E-only ties a (W,E), c (N,E), d (E,S)
  assert.strictEqual(pick(withTb, "00001000").ref, "a");
  const seen = new Set();
  for (let rr = 0; rr < 40; rr++) seen.add(pick(noTb, "00001000", { reroll: rr }).ref);
  assert.ok(seen.size > 1, "without a tieBreak the hash decides");
  // a list that names no tied code falls back to the normal rule
  const unrelated = folderOf(tiles, { tieBreak: ["01000010"] });
  const seen2 = new Set();
  for (let rr = 0; rr < 40; rr++) seen2.add(pick(unrelated, "00001000", { reroll: rr }).ref);
  assert.ok(seen2.size > 1);
  // list order matters
  const swapped = folderOf(tiles, { tieBreak: ["00001010", "00011000"] });
  assert.strictEqual(pick(swapped, "00001000").ref, "d");
  // codes in the list are normalised; garbage entries are ignored
  assert.deepStrictEqual(S.tieBreakOf(folderOf(tiles, { tieBreak: ["00011000", "nope", 5] })), ["00011000"]);
});

// ── Deterministic mode (reroll OFF) ───────────────────────────────────────────────────────────────────
test("OFF: a shared-code pool takes its lowest sortIndex (or the picked variant); ON stays random", () => {
  const f = folderOf([T("hi", "11111111", 9), T("lo", "11111111", 2), T("mid", "11111111", 5)]);
  for (let x = 0; x < 30; x++) assert.strictEqual(pick(f, "11111111", { x, y: x * 3, deterministic: true }).ref, "lo");
  const on = new Set();
  for (let x = 0; x < 60; x++) on.add(pick(f, "11111111", { x, y: x * 3 }).ref);
  assert.ok(on.size === 3, "ON picks all variants");
  for (let x = 0; x < 10; x++) assert.strictEqual(pick(f, "11111111", { x, deterministic: true, picks: { "11111111": "mid" } }).ref, "mid");
  assert.strictEqual(pick(f, "11111111", { deterministic: true, picks: { "11111111": "missing" } }).ref, "lo", "an unknown pick falls back to Auto");
  // roll-0 variants are never chosen
  const f0 = folderOf([T("zero", "11111111", 0, { sensorRoll: 0 }), T("one", "11111111", 4)]);
  assert.strictEqual(pick(f0, "11111111", { deterministic: true }).ref, "one");
});

test("OFF: cross-code ties take the code whose first variant has the lowest sortIndex", () => {
  // nb E-only ties W+E (a), N+E (b), E+S (c); no 00000000 tile, no tieBreak
  const f = folderOf([T("a", "00011000", 7), T("b", "01001000", 3), T("c", "00001010", 5)]);
  for (let i = 0; i < 20; i++) assert.strictEqual(pick(f, "00001000", { x: i, y: i, deterministic: true }).ref, "b");
  // a code's first variant is its lowest-sortIndex variant
  const g = folderOf([T("a1", "00011000", 8), T("a2", "00011000", 1), T("b", "01001000", 3), T("c", "00001010", 5)]);
  assert.strictEqual(pick(g, "00001000", { deterministic: true }).ref, "a2");
  // equal sortIndex: the smaller code
  const h = folderOf([T("a", "00011000", 4), T("b", "01001000", 4)]);
  assert.strictEqual(pick(h, "00001000", { deterministic: true }).ref, "a"); // "00011000" < "01001000"
});

test("OFF: a 00000000 tile still wins ties; exact mode and fence folders honour picks", () => {
  const f = folderOf([T("zero", "00000000", 9), T("a", "00011000", 1), T("b", "01000010", 2)]);
  assert.strictEqual(pick(f, "00001000", { deterministic: true }).ref, "zero", "fence rule: no exact cardinal match -> 00000000");
  const fz = folderOf([T("zeroHi", "00000000", 9), T("zeroLo", "00000000", 3), T("a", "00011000", 1), T("b", "01000010", 2)]);
  assert.strictEqual(pick(fz, "00001000", { deterministic: true }).ref, "zeroLo");
  assert.strictEqual(pick(fz, "00001000", { deterministic: true, picks: { "00000000": "zeroHi" } }).ref, "zeroHi");
  const g = folderOf([T("zero", "00000000", 9), T("x", "01001000", 1), T("y", "00001010", 2)]); // not a fence: scoring; 00000000 wins the tie
  assert.strictEqual(pick(g, "00001000", { deterministic: true }).ref, "zero");
  const ex = folderOf([T("fb1", S.FALLBACK_CODE, 6), T("fb0", S.FALLBACK_CODE, 2), T("x", "11111111", 1)]);
  assert.strictEqual(pick(ex, "00000001", { deterministic: true }).ref, "fb0");
  assert.strictEqual(pick(ex, "00000001", { deterministic: true, picks: { [S.FALLBACK_CODE]: "fb1" } }).ref, "fb1");
});

test("sharedPools: explicit codes with two or more usable variants, Auto = lowest sortIndex", () => {
  const f = folderOf([T("b", "11111111", 4), T("a", "11111111", 1), T("solo", "00000000", 0), T("off", "01000010", 3, { sensorRoll: 0 }), T("on", "01000010", 6), T("f1", S.FALLBACK_CODE, 3), T("f2", S.FALLBACK_CODE, 2)]);
  const pools = S.sharedPools(f);
  assert.deepStrictEqual(pools.map(p => [p.code, p.entries.map(e => e.ref), p.auto.ref]), [["11111111", ["a", "b"], "a"], [S.FALLBACK_CODE, ["f2", "f1"], "f2"]]);
  assert.deepStrictEqual(S.sharedPools(folderOf([T("a", "11111111", 1), T("b", "00000000", 2)])), []);
});

test("deriveLayer: deterministic and picks flow through per folder; the screen and Download Map read the same layer", () => {
  const f = U.makeFolder({ scope: "global", folderKey: "pool", tiles: ["a", "b", "c"].map((n, i) => T("p" + n, "11111111", i + 1)), cfg: {} });
  const ef = U.engineFolder(f), folders = new Map([[f.ref, { folder: ef, candidates: S.buildCandidates(ef) }]]);
  const grid = Array.from({ length: 10 }, () => Array(10).fill(0)), refs = [f.ref];
  const refsAt = L => [...L.values()].map(v => v.ref);
  const off = refsAt(U.deriveLayer({ grid, refs, folders, deterministic: new Map([[f.ref, true]]) }));
  assert.ok(off.every(r => r === "pa"));
  const picked = refsAt(U.deriveLayer({ grid, refs, folders, deterministic: { [f.ref]: true }, picks: new Map([[f.ref, { "11111111": "pc" }]]) }));
  assert.ok(picked.every(r => r === "pc"));
  assert.ok(new Set(refsAt(U.deriveLayer({ grid, refs, folders }))).size > 1, "ON is random");
});

console.log(`${passed} passed`);
