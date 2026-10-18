// Run with: node tests/sensor_ui_resolve.test.js   (no dependencies)
const assert = require("assert");
const U = require("../sensor_ui.js");
let passed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log("ok   " + name); } catch (e) { console.error("FAIL " + name + "\n" + e.stack); process.exitCode = 1; } };
const row = (id, codename, extra = {}) => ({ id, codename, folder_key: null, sensor_code: null, symbol: null, sort_index: 0, ...extra });

// Ancient Hell keeps Crate as a sensor folder; Plain has Crate as a plain tile; Other has neither.
const ANCIENT = [row("h1", "Crate_00000000", { folder_key: "Crate", sensor_code: "00000000", symbol: "Y", sort_index: 4 }), row("h2", "Crate_11111111", { folder_key: "Crate", sensor_code: "11111111", symbol: "Y", sort_index: 5 }), row("h3", "Wall1", { symbol: "M", sort_index: 1 }), row("h4", "Pot_loose", { folder_key: "Crate", symbol: "Y", sort_index: 6 })];
const PLAIN = [row("p1", "Crate", { symbol: "Y", sort_index: 2 }), row("p2", "Wall1", { symbol: "M", sort_index: 1 }), row("p3", "Barrel", { symbol: "C", sort_index: 3 })];
const OTHER = [row("o1", "Boulder", { symbol: "Y", sort_index: 9 }), row("o2", "Rock", { symbol: "Y", sort_index: 3 })];
const plan = (refs, oldRows, oldTsId, newRows, newTsId) => U.planSwitchResolved({ refs, oldRows, oldTsId, newRows, newTsId });

test("a plain Crate from another tileset resolves to the Crate sensor folder", () => {
  const r = plan(["d:p1"], PLAIN, "tp", ANCIENT, "ta");
  assert.deepStrictEqual(r.matched, [{ from: "d:p1", to: "s:ta|Crate" }]);
  assert.deepStrictEqual([r.mismatches, r.foreign], [[], []]);
});

test("the Crate sensor folder resolves to a plain Crate elsewhere, without the compat modal", () => {
  const r = plan(["s:ta|Crate"], ANCIENT, "ta", PLAIN, "tp");
  assert.deepStrictEqual(r.matched, [{ from: "s:ta|Crate", to: "d:p1" }]);
  assert.deepStrictEqual(r.mismatches, []);
});

test("same kind wins first: plain -> plain by codename, folder -> folder by key (even when the other kind also fits)", () => {
  const both = [row("b1", "Crate", { symbol: "Y" }), row("b2", "Crate_0", { folder_key: "Crate", sensor_code: "00000000", symbol: "Y" })];
  assert.deepStrictEqual(plan(["d:p1"], PLAIN, "tp", both, "tb").matched, [{ from: "d:p1", to: "d:b1" }]);
  assert.deepStrictEqual(plan(["s:ta|Crate"], ANCIENT, "ta", both, "tb").matched, [{ from: "s:ta|Crate", to: "s:tb|Crate" }]);
});

test("unlabelled tiles of a sensor folder count as plain tiles", () => {
  const r = plan(["d:h4"], ANCIENT, "ta", [row("x1", "Pot_loose", { symbol: "Q" })], "tx");
  assert.deepStrictEqual(r.matched, [{ from: "d:h4", to: "d:x1" }]);
});

test("falls back to the same symbol (lowest sortIndex), then to a mismatch", () => {
  const bySym = plan(["d:p1"], PLAIN, "tp", OTHER, "to");
  assert.deepStrictEqual(bySym.matched, [{ from: "d:p1", to: "d:o2" }], "Rock (sortIndex 3) beats Boulder (9)");
  const folderSym = plan(["s:ta|Crate"], ANCIENT, "ta", OTHER, "to");
  assert.deepStrictEqual(folderSym.matched, [{ from: "s:ta|Crate", to: "d:o2" }]);
  const none = plan(["d:p3", "s:ta|Crate"], [...PLAIN], "tp", [row("z", "Stone", { symbol: "Z" })], "tz");
  assert.deepStrictEqual(none.mismatches.map(m => m.ref), ["d:p3"]);
  assert.deepStrictEqual(none.foreign, ["s:ta|Crate"], "a folder of a third tileset is foreign");
  const noSym = plan(["d:p1"], [row("p1", "Crate")], "tp", OTHER, "to");
  assert.deepStrictEqual(noSym.mismatches, [{ ref: "d:p1", codename: "Crate" }], "no symbol, no namesake: compat modal");
});

test("global, upload and special entries are untouched; foreign d: entries and unknown ones are foreign", () => {
  const r = plan(["g:Resources/Global/Spawns/1.png", "s:global|water", "u:3", "space", "warn", "d:ghost", null], PLAIN, "tp", ANCIENT, "ta");
  assert.deepStrictEqual([r.matched, r.mismatches], [[], []]);
  assert.deepStrictEqual(r.foreign, ["d:ghost"]);
});

test("no target tileset: everything is a mismatch", () => {
  const r = plan(["d:p1", "s:ta|Crate"], PLAIN.concat(ANCIENT), "ta", [], null);
  assert.strictEqual(r.matched.length, 0);
});

test("resolveAcross is exact (case matters) and groupRows splits folder members from plain rows", () => {
  const idx = U.targetIndex([row("a", "crate")], "t");
  assert.strictEqual(U.resolveAcross({ kind: "plain", codename: "Crate" }, idx), null);
  const g = U.groupRows(ANCIENT, "ta");
  assert.deepStrictEqual(g.folders.map(f => [f.ref, f.sortIndex, f.symbol]), [["s:ta|Crate", 4, "Y"]]);
  assert.deepStrictEqual(g.plain.map(e => e.codename).sort(), ["Pot_loose", "Wall1"]);
});

test("orderEntries: plain tiles and folders together by lowest sortIndex; ties plain, folder, name", () => {
  const flat = (codename, sortIndex) => ({ type: "flat", tile: { codename, sortIndex } });
  const folder = (label, ...idx) => ({ type: "folder", label, tiles: idx.map(sortIndex => ({ sortIndex })) });
  const out = U.orderEntries([folder("Walls", 5, 3), flat("Zed", 1), folder("Alpha", 1), flat("Bee", 3), flat("Ace", 3), folder("Late", 9), flat("Mid", 4), folder("Empty")]);
  assert.deepStrictEqual(out.map(e => e.type === "flat" ? e.tile.codename : "[" + e.label + "]"), ["Zed", "[Alpha]", "Ace", "Bee", "[Walls]", "Mid", "[Late]", "[Empty]"]);
  // folders are no longer always after the plain tiles
  assert.strictEqual(out.findIndex(e => e.type === "folder") < out.findIndex(e => e.type === "flat" && e.tile.codename === "Mid"), true);
  assert.deepStrictEqual(U.orderEntries(null), []);
});

test("duplicate: codename _copy, numeric suffix when taken; next sortIndex; the row body copies the pool, flags, size, offsets and symbol", () => {
  assert.strictEqual(U.duplicateCodename("Crate", new Set(["Crate"])), "Crate_copy");
  assert.strictEqual(U.duplicateCodename("Crate", new Set(["Crate_copy"])), "Crate_copy2");
  assert.strictEqual(U.duplicateCodename("Crate", new Set(["Crate_copy", "Crate_copy2"])), "Crate_copy3");
  assert.strictEqual(U.nextSortIndex([{ sort_index: 4 }, { sort_index: 9 }, { sort_index: null }]), 10);
  assert.strictEqual(U.nextSortIndex([]), 0);
  const orig = { id: "x", codename: "Bars_a", image_url: "https://raw/old.png", sort_index: 3, folder_key: "Bars", sensor_code: "11111111", sensor_roll: 2, rotatable: true, flippable: false, otg_passable: true, mirror_offset: false, bottom_render: true, priority: false, auto_shadow: true, size_multiplier: 1.5, offset_x: 3, offset_y: null, symbol: "j", last_updated_by: "u" };
  const body = U.duplicateRowBody({ row: orig, tilesetId: "ts", codename: "Bars_a_copy", imageUrl: "https://raw/new.png", sortIndex: 11 });
  assert.deepStrictEqual(body, { tileset_id: "ts", codename: "Bars_a_copy", image_url: "https://raw/new.png", sort_index: 11, folder_key: "Bars", sensor_code: "11111111", sensor_roll: 2, rotatable: true, flippable: false, otg_passable: true, mirror_offset: false, bottom_render: true, priority: false, auto_shadow: true, size_multiplier: 1.5, offset_x: 3, offset_y: null, symbol: "j" });
  assert.ok(!("id" in body) && !("last_updated_by" in body), "no id or audit columns are copied");
  assert.deepStrictEqual(U.localCopySize(512, 128), { w: 256, h: 64 });
  assert.deepStrictEqual(U.localCopySize(100, 40), { w: 100, h: 40 });
});

console.log(`${passed} passed`);
