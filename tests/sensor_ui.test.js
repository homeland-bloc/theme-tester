// Run with: node tests/sensor_ui.test.js   (no dependencies)
const assert = require("assert");
const S = require("../sensor.js");
const U = require("../sensor_ui.js");

let passed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log("ok   " + name); } catch (e) { console.error("FAIL " + name + "\n" + e.stack); process.exitCode = 1; } };

const T = (ref, code, extra = {}) => ({ ref, codename: ref, sensorCode: code, sensorRoll: 1, sortIndex: 0, ...extra });

test("sensor refs", () => {
  assert.strictEqual(U.sensorRef("global", "water"), "s:global|water");
  assert.deepStrictEqual(U.parseSensorRef("s:abc-1|Walls"), { scope: "abc-1", folderKey: "Walls" });
  assert.deepStrictEqual(U.parseSensorRef("s:global|a|b"), { scope: "global", folderKey: "a|b" });
  assert.strictEqual(U.parseSensorRef("d:abc"), null);
  assert.strictEqual(U.parseSensorRef("s:|x"), null);
  assert.strictEqual(U.parseSensorRef("s:x|"), null);
  assert.strictEqual(require("../tile_palette.js").parseRef("s:global|water").kind, "s");
});

test("code / roll input", () => {
  assert.deepStrictEqual(U.parseCodeInput(""), { ok: true, value: null });
  assert.deepStrictEqual(U.parseCodeInput("  "), { ok: true, value: null });
  assert.strictEqual(U.parseCodeInput("00000000").value, "00000000"); // distinct from empty
  assert.strictEqual(U.parseCodeInput("0000000").ok, false);
  assert.strictEqual(U.parseCodeInput("0000000a").ok, false);
  assert.strictEqual(U.parseRollInput("0").value, 0);
  assert.strictEqual(U.parseRollInput("12").value, 12);
  assert.strictEqual(U.parseRollInput("").value, null);
  assert.strictEqual(U.parseRollInput("-1").ok, false);
  assert.strictEqual(U.parseRollInput("1.5").ok, false);
  assert.strictEqual(U.codeFieldState("01000000", "01000000"), "saved");
  assert.strictEqual(U.codeFieldState("01000001", "01000000"), "edited");
  assert.strictEqual(U.codeFieldState("", null), "saved");
  assert.strictEqual(U.codeFieldState("00000000", null), "edited");
  assert.strictEqual(U.codeFieldState("abc", null), "invalid");
});

test("codeGridCells", () => {
  const cells = U.codeGridCells("01001000"); // N and E
  assert.strictEqual(cells.length, 9);
  assert.deepStrictEqual(cells.map(c => (c.centre ? "X" : c.filled ? "1" : "0")).join(""), "010" + "0X1" + "000");
  assert.ok(U.codeGridCells(null).every(c => !c.filled));
});

test("splitGroupPatch", () => {
  const { group, own } = U.splitGroupPatch({ symbol: "W", rotatable: true, codename: "a", sensor_code: "00000000", sensor_roll: 2, offset_x: 1 });
  assert.deepStrictEqual(group, { symbol: "W" }); // symbol is the only group-synced field
  assert.deepStrictEqual(U.splitGroupPatch({ size_multiplier: 1.5, offset_x: 1, offset_y: 2, show_tile_count: true }).group, {});
  assert.deepStrictEqual(own, { rotatable: true, codename: "a", sensor_code: "00000000", sensor_roll: 2, offset_x: 1 }); // flags and offsets stay on the row
  for (const k of ["priority", "bottom_render", "auto_shadow", "otg_passable", "mirror_offset", "rotatable", "flippable"]) assert.deepStrictEqual(U.splitGroupPatch({ [k]: true }).group, {});
});

test("makeFolder: plain, sensor, mixed", () => {
  assert.strictEqual(U.makeFolder({ scope: "t", folderKey: "F", tiles: [T("a", null), T("b", null)] }), null);
  const f = U.makeFolder({ scope: "t", folderKey: "F", tiles: [T("b", null, { sortIndex: 2 }), T("a", "00000000", { sortIndex: 1, dbRotatable: true, symbol: "W" })] });
  assert.strictEqual(f.ref, "s:t|F");
  assert.deepStrictEqual(f.labelled.map(t => t.ref), ["a"]);
  assert.deepStrictEqual(f.unlabelled.map(t => t.ref), ["b"]);
  assert.deepStrictEqual(f.settings, { spin: true, flip: false });
  assert.strictEqual(f.symbol, "W");
  assert.deepStrictEqual(U.engineFolder(f).tiles.map(t => t.ref), ["a"]); // unlabelled never reach the resolver
  const g = U.makeFolder({ scope: "global", folderKey: "water", tiles: [T("x", "00001011")], cfg: { spin: true, flip: true, symbol: "W" } });
  assert.deepStrictEqual(g.settings, { spin: true, flip: true });
  assert.strictEqual(g.symbol, "W");
});

test("divergence ignores code, image, codename, sort, roll; reports symbol as warning and flags/size/offset as info", () => {
  const a = T("a", "00000000", { src: "1.png", sensorRoll: 1, sortIndex: 1, dbBottomRender: true, dbSizeMultiplier: 1, dbOffsetX: 0, symbol: "W" });
  const b = T("b", "01000000", { src: "2.png", sensorRoll: 9, sortIndex: 5, dbBottomRender: true, dbSizeMultiplier: "1", dbOffsetX: 0, symbol: "W" });
  assert.deepStrictEqual(U.divergence([a, b]), []);
  const c = T("c", "00001000", { dbBottomRender: false, dbSizeMultiplier: 2, dbOffsetX: 0, symbol: null });
  const dv = U.divergence([a, b, c]);
  assert.deepStrictEqual(dv.map(x => x.field).sort(), ["dbBottomRender", "dbSizeMultiplier", "symbol"]);
  // only the symbol is a real warning; per-variant fields are informational
  assert.deepStrictEqual(dv.filter(x => x.level === "warning").map(x => x.field), ["symbol"]);
  assert.ok(dv.filter(x => x.field !== "symbol").every(x => x.level === "info"));
  assert.ok(/ignore this/.test(U.DIVERGENCE_NOTE));
  // unlabelled tiles are not compared
  assert.deepStrictEqual(U.divergence([a, T("u", null, { dbBottomRender: false })]), []);
});

// ── derived layer ───────────────────────────────────────────────────────────────────────────────────────
const waterFolder = (spin = true) => U.makeFolder({
  scope: "global", folderKey: "water", cfg: { spin, flip: false },
  tiles: ["00001011", "01101011", "01111111", "11111111"].map((c, i) => T("g:" + c, c, { sortIndex: i })),
});
const layerFor = (grid, refs, f) => {
  const ef = U.engineFolder(f);
  return U.deriveLayer({ grid, refs, folders: new Map([[f.ref, { folder: ef, candidates: S.buildCandidates(ef) }]]) });
};

test("deriveLayer: neighbours count only for the same folder, edge is air", () => {
  const f = waterFolder();
  const refs = [f.ref, "d:other"];
  // 3x3 block of water in the middle of a 5x5 map, plus a different tile to the right
  const grid = Array.from({ length: 5 }, () => Array(5).fill(null));
  for (let r = 1; r <= 3; r++) for (let c = 1; c <= 3; c++) grid[r][c] = 0;
  grid[2][4] = 1;
  const L = layerFor(grid, refs, f);
  assert.strictEqual(L.size, 9);
  assert.strictEqual(L.get("2,2").nb, "11111111");
  assert.strictEqual(L.get("2,2").code, "11111111");
  assert.strictEqual(L.get("2,3").nb, "11010110"); // E is the other folder's tile and NE/SE are empty -> air
  assert.strictEqual(L.get("1,1").nb, "00001011"); // only E, S, SE
  // map edge counts as air
  const edge = layerFor([[0, 0], [0, 0]], refs, f);
  assert.strictEqual(edge.get("0,0").nb, "00001011");
  assert.strictEqual(edge.get("1,1").nb, "11010000");
});

test("deriveLayer: independent per-cell rolls, deterministic", () => {
  const tiles = [T("a1", "11111111", { sortIndex: 0 }), T("a2", "11111111", { sortIndex: 1 })];
  const f = U.makeFolder({ scope: "global", folderKey: "fill", tiles, cfg: {} });
  const grid = Array.from({ length: 12 }, () => Array(12).fill(0));
  const refs = [f.ref];
  const L1 = layerFor(grid, refs, f), L2 = layerFor(grid, refs, f);
  const seen = new Set();
  for (const [k, v] of L1) { assert.strictEqual(v.ref, L2.get(k).ref); if (v.nb === "11111111") seen.add(v.ref); }
  assert.strictEqual(seen.size, 2); // both variants appear
});

test("deriveLayer: no usable variant -> warn", () => {
  const f = U.makeFolder({ scope: "t", folderKey: "F", cfg: {}, tiles: [T("a", "00000000", { sensorRoll: 0 })] });
  const L = layerFor([[0]], [f.ref], f);
  assert.strictEqual(L.get("0,0").warn, true);
});

test("deriveLayer: mirrored copy of the same logical entry derives its own variant", () => {
  const f = waterFolder();
  const refs = [f.ref];
  const L = layerFor([[0, 0, null, 0, 0]], refs, f);
  assert.strictEqual(L.get("0,0").nb, "00001000"); // E only
  assert.strictEqual(L.get("0,1").nb, "00010000"); // W only
  assert.strictEqual(L.get("0,3").nb, "00001000");
});

test("opsToCss / opsLabel", () => {
  assert.strictEqual(U.opsToCss([]), "");
  assert.strictEqual(U.opsToCss(["spin"]), "rotate(90deg)");
  assert.strictEqual(U.opsToCss(["spin", "spin", "flipH"]), "scale(-1, 1) rotate(90deg) rotate(90deg)");
  assert.strictEqual(U.opsLabel(["spin", "spin", "flipH"]), "spin x2, flip");
  assert.strictEqual(U.opsLabel(["spin"]), "spin");
});

test("derived css transform reproduces the derived code (geometric check)", () => {
  // Image of a tile with only N set; apply the ops geometrically to the N direction vector and read the resulting bit.
  const vec = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
  const rot = ([x, y]) => [-y, x];          // clockwise 90 on screen (y down)
  const flip = ([x, y]) => [-x, y];
  const bitOf = ([x, y]) => (x === 0 && y === -1 ? "N" : x === 1 ? "E" : y === 1 ? "S" : "W");
  for (const ops of [["spin"], ["spin", "spin"], ["spin", "flipH"], ["spin", "spin", "spin", "flipH"], ["flipH"]]) {
    let v = vec.N;
    for (const op of ops) v = op === "spin" ? rot(v) : flip(v);
    const expectBit = bitOf(v);
    const want = { N: "01000000", E: "00001000", S: "00000010", W: "00010000" }[expectBit];
    // flip applies to a W/E-only change, which flipH on the code level mirrors identically
    const viaCode = ops.reduce((c, op) => (op === "spin" ? S.spin(c) : S.flipH(c)), "01000000");
    assert.strictEqual(viaCode, want, ops.join("+"));
  }
});

test("composePlan", () => {
  const f = waterFolder(true);
  const c = S.buildCandidates(U.engineFolder(f));
  const code = S.ALL_CODES.find(k => c[k].status === "composed");
  assert.ok(code, "some code is composed from the four base tiles");
  const plan = U.composePlan(c[code].recipe, 100, 80);
  assert.strictEqual(plan.length, 4);
  assert.deepStrictEqual(plan.map(p => [p.x, p.y]), [[0, 0], [50, 0], [50, 40], [0, 40]]);
  assert.ok(plan.every(p => p.w === 50 && p.h === 40 && p.steps >= 0 && p.steps < 4 && p.sourceTileRef));
  assert.strictEqual(U.composeKey("s:global|water", "01010101"), "s:global|water#01010101");
});

test("planSensorSwitch", () => {
  const refs = ["d:1", "s:old|Walls", "s:old|Gone", "s:global|water", "s:third|Walls", null, "space"];
  const p = U.planSensorSwitch(refs, "old", "new", ["Walls"]);
  assert.deepStrictEqual(p.matched, [{ from: "s:old|Walls", to: "s:new|Walls" }]);
  assert.deepStrictEqual(p.mismatches.map(m => m.ref), ["s:old|Gone"]);
  assert.deepStrictEqual(p.foreign, ["s:third|Walls"]);
  // no new tileset (cannot happen in the UI, but must not match)
  assert.strictEqual(U.planSensorSwitch(refs, "old", null, ["Walls"]).matched.length, 0);
  // composes with TilePalette.applySwitchPlan
  const TP = require("../tile_palette.js");
  const pal = { refs: ["s:old|Walls", "s:old|Gone", "s:global|water", "s:third|Walls"] };
  const grid = [[0, 1, 2, 3]];
  const plan = U.planSensorSwitch(pal.refs, "old", "new", ["Walls"]);
  const r = TP.applySwitchPlan(pal, grid, plan, {});
  assert.deepStrictEqual(r.palette.refs, ["s:new|Walls", TP.WARN_REF, "s:global|water", null]);
  assert.deepStrictEqual(r.grid, [[0, 1, 2, null]]);
});

test("resolveLoadedSensorRef", () => {
  assert.strictEqual(U.resolveLoadedSensorRef("s:old|Walls", "new", ["Walls"]), "s:new|Walls");
  assert.strictEqual(U.resolveLoadedSensorRef("s:old|Gone", "new", ["Walls"]), null);
  assert.strictEqual(U.resolveLoadedSensorRef("s:global|water", "new", ["water"]), null);
  assert.strictEqual(U.resolveLoadedSensorRef("s:old|Walls", null, ["Walls"]), null);
});

test("toggleCodeBit / normalisedHint", () => {
  assert.strictEqual(U.toggleCodeBit("", 1), "01000000");
  assert.strictEqual(U.toggleCodeBit("01000000", 1), "00000000");
  assert.strictEqual(U.toggleCodeBit("0101", 7), "01010001");
  assert.strictEqual(U.toggleCodeBit("01000000", 3), "01010000");
  assert.strictEqual(U.normalisedHint("10000000"), "00000000"); // NW alone has no N and W
  assert.strictEqual(U.normalisedHint("01010000"), null);
  assert.strictEqual(U.normalisedHint("0101"), null);
  assert.strictEqual(U.normalisedHint(""), null);
});

test("pickers: a sensor folder is one entry, variants hidden / canonicalised", () => {
  const v1 = { ref: "d:1", sensorCode: "00000000" }, v2 = { ref: "d:2", sensorCode: "00001000" }, un = { ref: "d:3", sensorCode: null };
  const folder = { tiles: [v1, v2, un], labelled: [v1, v2] };
  const plain = { ref: "d:9" }, sTile = { ref: "s:ts|F", isSensor: true, sensorFolder: folder };
  const list = [v1, v2, un, plain, sTile];
  assert.deepStrictEqual(U.hideSensorVariants(list).map(t => t.ref), ["d:9", "s:ts|F"]);
  const owners = U.variantOwners(list);
  assert.strictEqual(U.canonicalRef("d:2", owners), "s:ts|F");
  assert.strictEqual(U.canonicalRef("d:9", owners), "d:9");
  assert.deepStrictEqual(U.canonicalRefs(["d:1", "d:9", "d:2", "s:ts|F"], owners), ["s:ts|F", "d:9"]);
  assert.deepStrictEqual(U.folderPreviewTiles(folder).map(t => t.ref), ["d:1", "d:2"]);
  assert.deepStrictEqual(U.hideSensorVariants([v1, v2]).map(t => t.ref), ["d:1", "d:2"]); // no folder entry in the list: nothing hidden
});

test("parseSymbolInput: empty, last code point, 6 and 7 reserved; suggestions skip used symbols", () => {
  assert.deepStrictEqual(U.parseSymbolInput(""), { ok: true, value: null });
  assert.deepStrictEqual(U.parseSymbolInput("ab"), { ok: true, value: "b" });
  assert.strictEqual(U.parseSymbolInput("6").ok, false);
  assert.strictEqual(U.parseSymbolInput("7").ok, false);
  assert.match(U.parseSymbolInput("6").error, /warn/);
  assert.match(U.parseSymbolInput("7").error, /space/);
  assert.strictEqual(U.parseSymbolInput("8").ok, true);
  assert.deepStrictEqual(U.usedSymbols([{ symbol: "A" }, { symbol: null }, {}]), ["A"]);
  assert.strictEqual(U.suggestSymbol([{ symbol: "A" }, { symbol: "B" }]), "D");
});

test("imageOps: dimensions and where pixels land", () => {
  const at = (r, x, y) => [r.matrix[0] * x + r.matrix[2] * y + r.matrix[4], r.matrix[1] * x + r.matrix[3] * y + r.matrix[5]];
  // 4x2 image, pixel (0,0) is its top-left corner point
  let r = U.imageOps([], 4, 2);
  assert.deepStrictEqual([r.width, r.height, at(r, 0, 0)], [4, 2, [0, 0]]);
  r = U.imageOps(["rotR"], 4, 2); // clockwise: the top-left goes to the top-right
  assert.deepStrictEqual([r.width, r.height, at(r, 0, 0), at(r, 4, 0), at(r, 0, 2)], [2, 4, [2, 0], [2, 4], [0, 0]]);
  r = U.imageOps(["rotL"], 4, 2); // counter-clockwise: the top-left goes to the bottom-left
  assert.deepStrictEqual([r.width, r.height, at(r, 0, 0), at(r, 4, 0)], [2, 4, [0, 4], [0, 0]]);
  r = U.imageOps(["flipH"], 4, 2);
  assert.deepStrictEqual([r.width, r.height, at(r, 0, 0), at(r, 4, 2)], [4, 2, [4, 0], [0, 2]]);
  r = U.imageOps(["flipV"], 4, 2);
  assert.deepStrictEqual([at(r, 0, 0), at(r, 4, 2)], [[0, 2], [4, 0]]);
  // rotR x2 = flipH + flipV; rotR then rotL = identity; order matters (rotR then flipH != flipH then rotR)
  const a = U.imageOps(["rotR", "rotR"], 4, 2), b = U.imageOps(["flipH", "flipV"], 4, 2);
  assert.deepStrictEqual(a.matrix.map(Math.abs), b.matrix.map(Math.abs));
  assert.deepStrictEqual(at(a, 1, 1), at(b, 1, 1));
  const id = U.imageOps(["rotR", "rotL"], 4, 2);
  assert.deepStrictEqual([id.width, id.height, at(id, 3, 1)], [4, 2, [3, 1]]);
  assert.notDeepStrictEqual(at(U.imageOps(["rotR", "flipH"], 4, 2), 0, 0), at(U.imageOps(["flipH", "rotR"], 4, 2), 0, 0));
  assert.deepStrictEqual(U.imageOps(["bogus"], 3, 3).matrix, [1, 0, 0, 1, 0, 0]);
});
test("withFreshVersion replaces any old ?v=", () => {
  assert.strictEqual(U.withFreshVersion("https://x/y/a.png?v=1", 22), "https://x/y/a.png?v=22");
  assert.strictEqual(U.withFreshVersion("https://x/y/a.png", 5), "https://x/y/a.png?v=5");
});

test("preloadImages: counts, dedupes, skips the overlay for cached images", async () => {
  const progress = [];
  const cached = U.preloadImages(["a", "b", "a", null], (u, cb) => cb(true), (d, t) => progress.push([d, t]));
  assert.strictEqual(cached.total, 2);
  assert.ok(cached.isDone()); // everything was cached: nothing to wait for
  assert.deepStrictEqual(progress, [[1, 2], [2, 2]]);
  assert.deepStrictEqual(await cached.promise, { total: 2, failed: 0 });
  const pending = [];
  const slow = U.preloadImages(["x", "y", "z"], (u, cb) => pending.push([u, cb]));
  assert.ok(!slow.isDone());
  pending[0][1](true); pending[1][1](false); pending[1][1](true); // a second call for the same url is ignored
  assert.strictEqual(slow.done, 2);
  assert.ok(!slow.isDone());
  pending[2][1](true);
  assert.ok(slow.isDone());
  assert.deepStrictEqual(await slow.promise, { total: 3, failed: 1 });
  assert.deepStrictEqual(await U.preloadImages([], () => {}).promise, { total: 0, failed: 0 });
  assert.strictEqual(U.progressLabel("Loading tiles", 12, 30), "Loading tiles 12/30");
  assert.strictEqual(U.progressLabel("Loading tiles", 0, 0), "Loading tiles");
});

test("global Rails folder: six explicit codenames, order BR BL TR TL Fence Ver, codes unchanged", () => {
  const m = JSON.parse(require("fs").readFileSync(__dirname + "/../Resources/manifest.json", "utf8")).global;
  const cfg = m.sensor.rails, files = U.globalFolderFiles(m.folders.rails, cfg);
  assert.deepStrictEqual(files, ["BR.png", "BL.png", "TR.png", "TL.png", "Fence.png", "Ver.png"]);
  assert.deepStrictEqual(m.folders.rails, files); // the manifest file order agrees too
  assert.deepStrictEqual(files.map(f => U.globalFileName(f, cfg)), ["RailBottomRight", "RailBottomLeft", "RailTopRight", "RailTopLeft", "RailHorizontal", "RailVertical"]);
  assert.deepStrictEqual(files.map(f => cfg.codes[f]), ["00001010", "00010010", "01001000", "01010000", "00011000", "01000010"]);
  // folder built the way the app does: variants come out in that order, first four = the loop
  const tiles = files.map((f, i) => ({ ref: "g:Resources/Global/Rails/" + f, codename: U.globalFileName(f, cfg), sensorCode: cfg.codes[f], sensorRoll: 1, sortIndex: i }));
  const folder = U.makeFolder({ scope: "global", folderKey: "rails", label: "Rails", tiles: tiles.slice().reverse(), cfg });
  assert.deepStrictEqual(folder.labelled.map(t => t.codename), ["RailBottomRight", "RailBottomLeft", "RailTopRight", "RailTopLeft", "RailHorizontal", "RailVertical"]);
  assert.deepStrictEqual(U.folderPreviewTiles(folder).map(t => t.codename), ["RailBottomRight", "RailBottomLeft", "RailTopRight", "RailTopLeft"]);
  // other global folders are untouched
  assert.deepStrictEqual(U.globalFolderFiles(m.folders.water, m.sensor.water), m.folders.water);
  assert.strictEqual(U.globalFileName("1.png", m.sensor.water), null);
});

test("recipeLines: four lines with code, tile name and transform", () => {
  const f = U.makeFolder({ scope: "t", folderKey: "W", cfg: {}, tiles: ["00001011", "01101011", "01111111", "11111111"].map((c, i) => T("g:" + c, c, { sortIndex: i, codename: "N" + c, dbRotatable: true, dbFlippable: true })) });
  const ef = U.engineFolder(f), r = S.buildCandidates(ef)["01000010"].recipe;
  const lines = U.recipeLines(r, ref => f.tiles.find(t => t.ref === ref).codename);
  assert.deepStrictEqual(lines.map(l => l.label), ["TL", "TR", "BR", "BL"]);
  assert.strictEqual(lines[0].text, "TL <- 01101011 (N01101011) (no transform)");
  assert.strictEqual(lines[1].text, "TR <- 01101011 (N01101011) (flip)");
  assert.strictEqual(U.transformLabel(true, 2), "flip, spin 2");
  assert.strictEqual(U.transformLabel(false, 0), "no transform");
  assert.ok(/exact shape/.test(U.FALLBACK_LABEL));
  assert.strictEqual(U.parseCodeInput("10100101").value, "10100101");
  assert.strictEqual(U.normalisedHint("10100101"), null); // the fallback sentinel never "acts as" anything
});

test("engineFolder passes per-variant flags: a tile without rotatable cannot derive", () => {
  const f = U.makeFolder({ scope: "t", folderKey: "W", cfg: {}, tiles: [T("a", "01111111", { dbRotatable: true }), T("b", "00001011", { dbRotatable: false })] });
  const c = S.buildCandidates(U.engineFolder(f));
  assert.strictEqual(c["11011111"].status, "derived");
  assert.ok(c["11011111"].pool.every(e => e.ref === "a"));
  assert.strictEqual(c["00010110"].status === "derived", false); // spin of b would be 00010110, b may not spin
});

console.log(`${passed} passed`);
