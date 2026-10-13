// Run with: node tests/palette.test.js   (no dependencies)
const assert = require("assert");
const P = require("../tile_palette.js");

let passed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log("ok   " + name); } catch (e) { console.error("FAIL " + name + "\n" + e.stack); process.exitCode = 1; } };

test("makeRef / parseRef round trip, kinds and specials", () => {
  assert.strictEqual(P.makeRef("d", "abc-123"), "d:abc-123");
  assert.strictEqual(P.makeRef("g", "Resources/Global/Water/1.png"), "g:Resources/Global/Water/1.png");
  assert.strictEqual(P.makeRef("u", 7), "u:7");
  assert.strictEqual(P.makeRef("s", "ts1|Walls"), "s:ts1|Walls");
  assert.deepStrictEqual(P.parseRef("u:7"), { kind: "u", key: "7" });
  assert.deepStrictEqual(P.parseRef("s:ts1|Walls"), { kind: "s", key: "ts1|Walls" });
  assert.deepStrictEqual(P.parseRef("g:Resources/a:b.png"), { kind: "g", key: "Resources/a:b.png" });
  assert.deepStrictEqual(P.parseRef("space"), { kind: "x", key: "space" });
  assert.strictEqual(P.parseRef("x:1"), null);
  assert.strictEqual(P.parseRef("d:"), null);
  assert.strictEqual(P.parseRef(5), null);
  assert.throws(() => P.makeRef("q", "1"));
});

test("add on first use; same ref returns same index", () => {
  const p = P.createPalette();
  assert.strictEqual(P.paletteIndexFor(p, "d:a"), 0);
  assert.strictEqual(P.paletteIndexFor(p, "g:Resources/x.png"), 1);
  assert.strictEqual(P.paletteIndexFor(p, "d:a"), 0);
  assert.strictEqual(P.paletteIndexFor(p, "u:5"), 2);
  assert.deepStrictEqual(p.refs, ["d:a", "g:Resources/x.png", "u:5"]);
  assert.strictEqual(P.refAt(p, 1), "g:Resources/x.png");
  assert.strictEqual(P.refAt(p, 9), null);
  assert.strictEqual(P.refAt(p, null), null);
  assert.throws(() => P.paletteIndexFor(p, "nonsense"));
});

test("removeUnused leaves gaps and never moves other indexes", () => {
  const p = P.createPalette();
  ["d:a", "d:b", "d:c", "d:d"].forEach(r => P.paletteIndexFor(p, r));
  const grid = [[0, 1, 2], [3, null, 2]];
  const grid2 = [[0, null, 2], [3, null, 2]]; // 1 (d:b) no longer used
  const q = P.removeUnused(p, grid2);
  assert.deepStrictEqual(q.refs, ["d:a", null, "d:c", "d:d"]);
  assert.deepStrictEqual(p.refs, ["d:a", "d:b", "d:c", "d:d"], "input palette untouched");
  assert.strictEqual(P.paletteIndexFor(q, "d:c"), 2, "untouched entry keeps its index");
  assert.strictEqual(P.paletteIndexFor(q, "d:d"), 3);
  assert.strictEqual(P.paletteIndexFor(q, "d:new"), 4, "new entries append; gap is not reused");
  // undo: the earlier palette still has d:b at 1 for the earlier grid
  assert.strictEqual(P.refAt(p, grid[0][1]), "d:b");
});

test("compactForExport renumbers only on export and drops unused/free entries", () => {
  const p = { refs: ["d:a", null, "d:c", "d:unused", "d:e"] };
  const grid = [[0, 2, 4], [4, null, 2]];
  const c = P.compactForExport(p, grid);
  assert.deepStrictEqual(c.refs, ["d:a", "d:c", "d:e"]);
  assert.deepStrictEqual(c.grid, [[0, 1, 2], [2, null, 1]]);
  assert.deepStrictEqual(p.refs, ["d:a", null, "d:c", "d:unused", "d:e"], "live palette untouched");
  // cell pointing at a free slot becomes null
  assert.deepStrictEqual(P.compactForExport(p, [[1, 0]]).grid, [[null, 0]]);
});

test("remapEntry rewrites in place when target is new", () => {
  const p = { refs: ["d:a", "d:b", "d:c"] };
  const grid = [[0, 1, 2]];
  const r = P.remapEntry(p, "d:b", "d:x", grid);
  assert.strictEqual(r.merged, false);
  assert.deepStrictEqual(r.palette.refs, ["d:a", "d:x", "d:c"]);
  assert.strictEqual(r.grid, grid, "cells untouched");
  assert.deepStrictEqual(p.refs, ["d:a", "d:b", "d:c"], "input untouched");
});

test("remapEntry merges when target already exists", () => {
  const p = { refs: ["d:a", "d:b", "d:c"] };
  const grid = [[0, 1, 2], [1, 1, null]];
  const r = P.remapEntry(p, "d:b", "d:c", grid);
  assert.strictEqual(r.merged, true);
  assert.deepStrictEqual(r.palette.refs, ["d:a", null, "d:c"]);
  assert.deepStrictEqual(r.grid, [[0, 2, 2], [2, 2, null]]);
  assert.deepStrictEqual(grid, [[0, 1, 2], [1, 1, null]], "input grid untouched");
});

test("remapEntry no-ops for missing source or identical refs", () => {
  const p = { refs: ["d:a"] };
  const g = [[0]];
  assert.strictEqual(P.remapEntry(p, "d:zzz", "d:a", g).palette, p);
  assert.strictEqual(P.remapEntry(p, "d:a", "d:a", g).palette, p);
});

test("indexes of untouched entries never change across add/remove/remap", () => {
  const p = P.createPalette();
  const idx = {};
  ["d:a", "g:Resources/w.png", "u:1", "d:b", "space"].forEach(r => { idx[r] = P.paletteIndexFor(p, r); });
  let grid = [[idx["d:a"], idx["g:Resources/w.png"], idx["u:1"], idx["d:b"], idx["space"]]];
  let pal = p;
  // remove u:1 and g:w
  grid = [[idx["d:a"], null, null, idx["d:b"], idx["space"]]];
  pal = P.removeUnused(pal, grid);
  // remap d:b -> d:c (new)
  const r = P.remapEntry(pal, "d:b", "d:c", grid);
  pal = r.palette; grid = r.grid;
  // add a brand new one
  P.paletteIndexFor(pal, "d:new");
  assert.strictEqual(P.indexOfRef(pal, "d:a"), idx["d:a"]);
  assert.strictEqual(P.indexOfRef(pal, "space"), idx["space"]);
  assert.strictEqual(P.indexOfRef(pal, "d:c"), idx["d:b"], "rewritten in place at the same slot");
});

test("encode/decode round trip (compacts, 1-based, bare global paths)", () => {
  const p = { refs: ["d:a", null, "g:Resources/Global/Water/1.png", "u:3", "space", "d:dead"] };
  const grid = [[0, 2, null], [3, 4, 2]];
  const saved = P.encodeForStorage(p, grid);
  assert.deepStrictEqual(saved, {
    v: 2,
    palette: ["d:a", "Resources/Global/Water/1.png", "u:3", "space"],
    grid: [[1, 2, null], [3, 4, 2]],
  });
  const json = JSON.parse(JSON.stringify(saved));
  const back = P.decodeFromStorage(json);
  assert.deepStrictEqual(back.palette.refs, ["d:a", "g:Resources/Global/Water/1.png", "u:3", "space"]);
  assert.deepStrictEqual(back.grid, [[0, 1, null], [2, 3, 1]]);
  // re-encode is stable
  assert.deepStrictEqual(P.encodeForStorage(back.palette, back.grid), saved);
});

test("decode accepts the current saved format unchanged and legacy strings", () => {
  const legacy = {
    v: 2,
    palette: ["d:11111111-2222-3333-4444-555555555555", "Resources/Global/Spawns/1.png", "u:512", "space", "warn"],
    grid: [[1, 2, 3], [4, 5, null]],
  };
  const d = P.decodeFromStorage(legacy);
  assert.deepStrictEqual(d.palette.refs, ["d:11111111-2222-3333-4444-555555555555", "g:Resources/Global/Spawns/1.png", "u:512", "space", "warn"]);
  assert.deepStrictEqual(d.grid, [[0, 1, 2], [3, 4, null]]);
  // already-tagged global is accepted too
  assert.deepStrictEqual(P.decodeFromStorage({ v: 2, palette: ["g:Resources/x.png"], grid: [[1]] }).palette.refs, ["g:Resources/x.png"]);
});

test("decode is defensive about bad data", () => {
  assert.strictEqual(P.decodeFromStorage(null), null);
  assert.strictEqual(P.decodeFromStorage([[1, 2]]), null, "v1 raw array is not a palette save");
  assert.strictEqual(P.decodeFromStorage({ v: 1, palette: [], grid: [] }), null);
  const d = P.decodeFromStorage({ v: 2, palette: ["d:a", 42, ""], grid: [[1, 2, 3, 4, 0, -1, 1.5, "x"]] });
  assert.deepStrictEqual(d.palette.refs, ["d:a", null, null]);
  assert.deepStrictEqual(d.grid, [[0, null, null, null, null, null, null, null]]);
});

test("planSwitch / applySwitchPlan: codename match rewrites entries only, cells stay put", () => {
  const oldRows = [{ id: "a1", codename: "Wall" }, { id: "a2", codename: "Crate" }, { id: "a3", codename: "OnlyOld" }];
  const newRows = [{ id: "b1", codename: "Wall" }, { id: "b2", codename: "Crate" }];
  const pal = { refs: ["d:a1", "g:Resources/x.png", "d:a2", "d:a3", "u:4", "warn"] };
  const grid = [[0, 1, 2], [3, 4, 5]];
  const plan = P.planSwitch(pal, oldRows, newRows);
  assert.deepStrictEqual(plan.matched, [{ from: "d:a1", to: "d:b1" }, { from: "d:a2", to: "d:b2" }]);
  assert.deepStrictEqual(plan.mismatches, [{ ref: "d:a3", codename: "OnlyOld" }]);
  assert.deepStrictEqual(plan.foreign, []);
  const r = P.applySwitchPlan(pal, grid, plan, { "d:a3": "g:Resources/y.png" });
  assert.deepStrictEqual(r.palette.refs, ["d:b1", "g:Resources/x.png", "d:b2", "g:Resources/y.png", "u:4", "warn"]);
  assert.strictEqual(r.grid, grid, "cells untouched");
  assert.strictEqual(r.cleared, 0);
  // unmatched with no choice -> warn; merges into the existing warn entry
  const r2 = P.applySwitchPlan(pal, grid, plan, {});
  assert.deepStrictEqual(r2.palette.refs, ["d:b1", "g:Resources/x.png", "d:b2", null, "u:4", "warn"]);
  assert.deepStrictEqual(r2.grid, [[0, 1, 2], [5, 4, 5]]);
});

test("applySwitchPlan: a d: entry from a third tileset is cleared and counted, nothing from it survives", () => {
  const oldRows = [{ id: "a1", codename: "Wall" }];
  const newRows = [{ id: "b1", codename: "Wall" }, { id: "c1", codename: "Wall3" }];
  const pal = { refs: ["d:a1", "d:c1", "d:zzz"] }; // c1 is in the NEW tileset, zzz is unknown: both foreign to the old one
  const grid = [[0, 1, 2], [1, 1, null]];
  const plan = P.planSwitch(pal, oldRows, newRows);
  assert.deepStrictEqual(plan.foreign, ["d:c1", "d:zzz"]);
  const r = P.applySwitchPlan(pal, grid, plan);
  assert.deepStrictEqual(r.palette.refs, ["d:b1", null, null]);
  assert.deepStrictEqual(r.grid, [[0, null, null], [null, null, null]]);
  assert.strictEqual(r.cleared, 4);
});

test("countRefs: highest first, empty cells excluded, specials and sensor folders are single entries", () => {
  const pal = { refs: ["d:a", "s:ts|F", "warn", "space", null, "g:x"] };
  const grid = [[0, 1, 1, 2, null], [1, 5, 5, 5, 3], [1, 1, 0, null, null]];
  assert.deepStrictEqual(P.countRefs(pal, grid), [
    { ref: "s:ts|F", count: 5 }, { ref: "g:x", count: 3 }, { ref: "d:a", count: 2 }, { ref: "warn", count: 1 }, { ref: "space", count: 1 },
  ]);
  assert.deepStrictEqual(P.countRefs(pal, [[null, null]]), []);
  assert.deepStrictEqual(P.countRefs(pal, [[4]]), []); // a cell pointing at a free slot counts nothing
});

console.log(`\n${passed} passed${process.exitCode ? ", FAILURES above" : ""}`);
