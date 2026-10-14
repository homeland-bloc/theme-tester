// Run with: node tests/sensor.test.js   (no dependencies)
const assert = require("assert");
const S = require("../sensor.js");

let passed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log("ok   " + name); } catch (e) { console.error("FAIL " + name + "\n" + e.stack); process.exitCode = 1; } };

const T = (ref, code, roll = 1, sortIndex = 0) => ({ ref, sensorCode: code, sensorRoll: roll, sortIndex });
const folder = (key, tiles, settings = {}) => ({ key, tiles, settings: { spin: false, flip: false, ...settings } });
const at = (f, nb, x = 3, y = 4) => S.resolve(f, nb, { x, y, salt: f.key });
const bits = names => S.BIT_NAMES.map(n => (names.includes(n) ? "1" : "0")).join("");

test("FALLBACK_CODE is 10100101 and can never collide with a real neighbourhood", () => {
  assert.strictEqual(S.FALLBACK_CODE, "10100101");
  assert.ok(S.isFallback(S.FALLBACK_CODE) && S.isCode(S.FALLBACK_CODE));
  let seen = 0;
  for (let n = 0; n < 256; n++) {
    const code = n.toString(2).padStart(8, "0");
    // the neighbourhood normaliser (what resolve() applies to the map) never yields the sentinel, for all 256 codes
    assert.notStrictEqual(S.normaliseNeighbourhood(code), S.FALLBACK_CODE, code);
    // the public normalise() passes the sentinel itself through unchanged and never returns it for any other code
    if (code === S.FALLBACK_CODE) assert.strictEqual(S.normalise(code), code);
    else assert.notStrictEqual(S.normalise(code), S.FALLBACK_CODE, code);
    seen++;
  }
  assert.strictEqual(seen, 256);
  assert.ok(!S.ALL_CODES.includes(S.FALLBACK_CODE));
  assert.strictEqual(S.normaliseNeighbourhood(S.FALLBACK_CODE), "00000000"); // a real neighbourhood shaped like it is just 00000000
});

test("normalise: exactly 47 distinct codes", () => {
  assert.strictEqual(S.ALL_CODES.length, 47);
  const set = new Set();
  for (let n = 0; n < 256; n++) set.add(S.normalise(n.toString(2).padStart(8, "0")));
  assert.strictEqual(set.size, 48); // 47 + the fallback sentinel, which normalise() passes through
  set.delete("10100101");
  assert.strictEqual(set.size, 47);
  assert.strictEqual(S.normalise("10100101"), "10100101");
  assert.strictEqual(S.normalise("10000000"), "00000000");
  assert.strictEqual(S.normalise("11111111"), "11111111");
  assert.strictEqual(S.normalise("01010000"), "01010000");
  assert.strictEqual(S.normalise("11010000"), "11010000"); // NW kept: N and W set
  assert.strictEqual(S.normalise("11000000"), "01000000"); // NW dropped: W missing
});

test("spin / flipH", () => {
  assert.strictEqual(S.spin("01111111"), "11011111");
  for (let n = 0; n < 256; n++) {
    const c = n.toString(2).padStart(8, "0");
    assert.strictEqual(S.spin(S.spin(S.spin(S.spin(c)))), c);
    assert.strictEqual(S.flipH(S.flipH(c)), c);
  }
  assert.strictEqual(S.flipH("00001011"), "00010110");
  assert.strictEqual(S.spin("01000000"), "00001000"); // N -> E
  assert.strictEqual(S.spin("10000000"), "00100000"); // NW -> NE
});

test("neighbourCode offsets", () => {
  const grid = ["010", "011", "000"]; // centre (1,1); N and E set
  const nb = S.neighbourCode(1, 1, (r, c) => grid[r] && grid[r][c] === "1");
  assert.strictEqual(nb, "01001000"); // N and E; NE (grid[0][2]) is 0
});

const water = folder("water", [T("w1", "00001011"), T("w2", "01111111"), T("w3", "01101011"), T("w4", "11111111")], { spin: true });

test("water: all 47 codes available, every code has a status", () => {
  const cands = S.buildCandidates(water);
  for (const code of S.ALL_CODES) {
    assert.ok(["explicit", "derived", "composed"].includes(cands[code].status), code);
    assert.ok(at(water, code), "resolve " + code);
  }
  for (let n = 0; n < 256; n++) assert.ok(at(water, n.toString(2).padStart(8, "0")));
  assert.deepStrictEqual(S.computeRequiredBase(water), []);
});

test("water: 11111111 -> the 11111111 tile; explicit beats derived", () => {
  const r = at(water, "11111111");
  assert.strictEqual(r.ref, "w4");
  assert.strictEqual(r.status, "explicit");
  assert.strictEqual(S.buildCandidates(water)["00001011"].status, "explicit");
});

test("water: spins of 01111111 resolve as derived from that tile", () => {
  let code = "01111111";
  for (let k = 1; k <= 3; k++) {
    code = S.spin(code);
    const r = at(water, code);
    assert.strictEqual(r.status, "derived", code);
    assert.strictEqual(r.derivedFrom.ref, "w2");
    assert.deepStrictEqual(r.ops, Array(k).fill("spin"));
  }
  assert.strictEqual(at(water, "11011111").code, "11011111");
});

test("water: composed codes have 4-entry recipes referencing the base tiles; recipes are symbolically correct", () => {
  const cands = S.buildCandidates(water);
  const composed = S.ALL_CODES.filter(c => cands[c].status === "composed");
  assert.ok(composed.length > 0);
  const refs = { "00001011": "w1", "01101011": "w3", "01111111": "w2", "11111111": "w4" };
  for (const code of composed) {
    const rec = cands[code].recipe;
    assert.strictEqual(rec.length, 4);
    rec.forEach((e, q) => {
      assert.strictEqual(e.quadrant, q);
      assert.strictEqual(e.sourceTileRef, refs[e.sourceCode]);
      assert.strictEqual((e.sourceQuadrant + e.spinSteps) % 4, q);
      assert.strictEqual(S.quadrantBits(e.sourceCode, e.sourceQuadrant), S.quadrantBits(code, q));
      assert.strictEqual(e.type, S.quadrantType(code, q));
    });
  }
  // composeQuadrants hook
  const calls = [];
  const out = S.composeQuadrants(cands[composed[0]].recipe, (e, i) => { calls.push(i); return e.quadrantName; });
  assert.deepStrictEqual(calls, [0, 1, 2, 3]);
  assert.deepStrictEqual(out, ["TL", "TR", "BR", "BL"]);
});

test("quadrantType covers all five types", () => {
  assert.strictEqual(S.quadrantType("00001011", 0), "outer");
  assert.strictEqual(S.quadrantType("01101011", 0), "edgeV");
  assert.strictEqual(S.quadrantType("00011111", 0), "edgeH");
  assert.strictEqual(S.quadrantType("01111111", 0), "inner");
  assert.strictEqual(S.quadrantType("11111111", 0), "interior");
});

test("composition needs spin or flip and a source for every slot", () => {
  const noSpin = folder("n", water.tiles.slice(), {});
  assert.ok(!Object.values(S.buildCandidates(noSpin)).some(c => c.status === "composed"));
  assert.deepStrictEqual(S.computeRequiredBase(noSpin), []); // nothing is composed, so nothing is required
  // three of the four water bases are still enough: the interior quadrant also exists in 00001011
  assert.deepStrictEqual(S.computeRequiredBase(folder("m", water.tiles.slice(0, 3), { spin: true })), []);
  // a lone interior tile: every non-interior slot is missing
  const lone = folder("lone", [T("i", "11111111")], { spin: true });
  const miss = S.computeRequiredBase(lone);
  assert.strictEqual(miss.length, 16);
  assert.ok(miss.includes("bottom-left outer corner") && !miss.some(m => m.endsWith("interior")));
  assert.strictEqual(S.compositionRecipe(lone, "00011111"), null);
  assert.strictEqual(S.computeRequiredBase(folder("e", [], { spin: true })).length, 20);
});

test("water with spin: 4 explicit, 9 derived, 34 composed", () => {
  const cands = S.buildCandidates(water);
  const n = st => S.ALL_CODES.filter(c => cands[c].status === st).length;
  assert.deepStrictEqual([n("explicit"), n("derived"), n("composed"), n("missing")], [4, 9, 34, 0]);
  for (const c of S.ALL_CODES) if (cands[c].status === "composed") assert.ok(cands[c].recipe.every(e => e.flip === false));
});

// Depth water, flip only: the left half of the tile set is explicit, the right half is mirrored from it.
const depthTop = ["00001011", "01101011", "00011111", "01111111"]; // TL corner, left edge, top edge, inner corner (+ interior quadrants)
const depthBottom = ["01101000", "11111000", "11111011", "11111111"]; // BL corner, bottom edge, BL inner corner, interior
const depth = folder("depth", [...depthTop, ...depthBottom].map((c, i) => T("d" + i, c)), { flip: true });
test("flip-only depth water: no missing slots, all codes composed or explicit", () => {
  assert.deepStrictEqual(S.computeRequiredBase(depth), []);
  const cands = S.buildCandidates(depth);
  assert.ok(S.ALL_CODES.every(c => cands[c].status !== "missing"));
  assert.ok(S.ALL_CODES.some(c => cands[c].status === "composed"));
  // flip-derived codes exist too: the mirror of the TL corner
  assert.strictEqual(cands["00010110"].status, "derived");
  assert.deepStrictEqual(cands["00010110"].pool[0].ops, ["flipH"]);
});
test("flip-only composition: recipes use flip and never spin", () => {
  const cands = S.buildCandidates(depth);
  for (const code of S.ALL_CODES) {
    if (cands[code].status !== "composed") continue;
    cands[code].recipe.forEach((e, q) => {
      assert.strictEqual(e.spinSteps, 0);
      // flipping the source quadrant lands on q; its bits mirror the target's
      const srcQ = e.flip ? [1, 0, 3, 2][e.sourceQuadrant] : e.sourceQuadrant;
      assert.strictEqual(srcQ, q);
      assert.strictEqual(S.quadrantType(S.flipH(e.sourceCode), q) === e.type || !e.flip, true);
    });
  }
  const anyFlip = S.ALL_CODES.some(c => cands[c].recipe && cands[c].recipe.some(e => e.flip));
  assert.ok(anyFlip);
});
// The canvas draws: mirror left-right (flip), then rotate clockwise `spinSteps` quarter turns, then keep quadrant q.
// Simulate that on a 2x2 matrix of quadrant ids (position order TL TR BR BL) and check the source quadrant lands on q.
const simulateDraw = (sq, flip, steps) => {
  let m = [[0, 1], [3, 2]]; // [[TL, TR], [BL, BR]]
  if (flip) m = m.map(r => r.slice().reverse());
  for (let i = 0; i < steps; i++) m = [[m[1][0], m[0][0]], [m[1][1], m[0][1]]]; // rotate clockwise
  const pos = [[0, 0], [0, 1], [1, 1], [1, 0]]; // quadrant -> [row, col]
  return pos.findIndex(([r, c]) => m[r][c] === sq);
};
test("composition recipes are consistent with the canvas flip-then-rotate draw", () => {
  for (const f of [depth, water, folder("both", depth.tiles, { flip: true, spin: true })]) {
    const cands = S.buildCandidates(f);
    let n = 0;
    for (const code of S.ALL_CODES) {
      if (cands[code].status !== "composed") continue;
      cands[code].recipe.forEach((e, q) => {
        assert.strictEqual(simulateDraw(e.sourceQuadrant, e.flip, e.spinSteps), q, `${code} q${q}`);
        // the source quadrant really has the type this slot needs after the transform
        const t = S.quadrantType(e.sourceCode, e.sourceQuadrant);
        assert.strictEqual(e.spinSteps % 2 ? ({ edgeH: "edgeV", edgeV: "edgeH" }[t] || t) : t, e.type, `${code} q${q} type`);
        n++;
      });
    }
    assert.ok(n > 0);
  }
});
test("too few tiles report the exact missing slots", () => {
  const f = folder("few", [T("a", "00001011"), T("b", "11111111")], { flip: true });
  const miss = S.computeRequiredBase(f);
  // TL corner + its mirror give top-left/top-right outer; left/top edges and the interior come from the corner's other quadrants
  assert.ok(miss.includes("bottom-left outer corner"));
  assert.ok(miss.includes("bottom-right outer corner"));
  assert.ok(!miss.includes("top-left outer corner") && !miss.includes("top-right outer corner"));
  assert.ok(!miss.includes("top-left interior"));
  assert.strictEqual(S.buildCandidates(f)["00010110"].status, "derived");
  assert.notStrictEqual(S.buildCandidates(f)["01010000"].status, "composed");
  const withSpin = folder("few2", f.tiles, { spin: true, flip: true });
  assert.ok(!S.computeRequiredBase(withSpin).includes("bottom-left outer corner"));
});

test("coverage: 47 rows with code, status, sources, poolPercentages", () => {
  const cov = S.coverage(water);
  assert.strictEqual(cov.length, 47);
  const row = cov.find(r => r.code === "11111111");
  assert.strictEqual(row.status, "explicit");
  assert.deepStrictEqual(row.sources, [{ ref: "w4", code: "11111111" }]);
  assert.deepStrictEqual(row.poolPercentages, [{ ref: "w4", roll: 1, probability: 1 }]);
  assert.ok(cov.every(r => r.status !== "missing"));
});

const fence = folder("fence", [T("f0", "00000000"), T("fh", "00011000"), T("fv", "01000010")]);
test("simple fence: cardinal bits only, exact match else 00000000", () => {
  const cases = [
    [[], "f0"], [["E"], "f0"], [["W"], "f0"], [["N"], "f0"], [["S"], "f0"], [["W", "E"], "fh"], [["N", "S"], "fv"],
    [["N", "W"], "f0"], [["W", "E", "S"], "f0"], [["N", "W", "E"], "f0"], [["N", "S", "W", "E"], "f0"],
    [["NW", "NE", "SW", "SE"], "f0"], [["W", "E", "NW", "SE"], "fh"], [["N", "S", "NE"], "fv"],
  ];
  for (const [names, ref] of cases) assert.strictEqual(at(fence, bits(names)).ref, ref, names.join("+") || "lone");
  assert.strictEqual(S.folderMode(fence).kind, "fence");
  assert.ok(S.isFenceFolder(fence));
  // a roll-0 fence piece, or an extra code, turns the rule off
  assert.ok(!S.isFenceFolder(folder("x", [T("f0", "00000000"), T("fh", "00011000"), T("fv", "01000010", 0)])));
  assert.ok(!S.isFenceFolder(folder("y", [T("f0", "00000000"), T("fh", "00011000"), T("fv", "01000010"), T("e", "00001000")])));
  // a sibling variant of an existing code keeps the fence rule
  assert.ok(S.isFenceFolder(folder("z", [T("f0", "00000000"), T("fh", "00011000"), T("fh2", "00011000"), T("fv", "01000010")])));
});

const rope = folder("rope", [T("r0", "00000000"), T("rr", "00001000"), T("rt", "01000000"), T("rtr", "01001000")]);
test("rope keeps the scoring rule", () => {
  assert.strictEqual(at(rope, bits(["N", "E"])).ref, "rtr");
  assert.strictEqual(at(rope, bits(["N", "E", "W"])).ref, "rtr");
  assert.strictEqual(at(rope, bits(["E"])).ref, "rr");
  assert.strictEqual(at(rope, "00000000").ref, "r0");
});

const rails = folder("rails", [T("BR", "00001010"), T("BL", "00010010"), T("TR", "01001000"), T("TL", "01010000"), T("Ver", "01000010"), T("Hor", "00011000")]);
test("rails: ties without 00000000 are weighted random but stable", () => {
  const seen = new Set();
  for (let x = 0; x < 60; x++) for (let y = 0; y < 60; y++) {
    const r = at(rails, "00000000", x, y);
    assert.strictEqual(r.ref, at(rails, "00000000", x, y).ref);
    seen.add(r.ref);
  }
  assert.strictEqual(seen.size, 6); // lone tile: every code ties (matched 0, dangling 2)
  const tied = new Set();
  for (let x = 0; x < 60; x++) for (let y = 0; y < 60; y++) tied.add(at(rails, bits(["E"]), x, y).ref);
  assert.deepStrictEqual(Array.from(tied).sort(), ["BR", "Hor", "TR"]);
  assert.strictEqual(at(rails, bits(["W", "E"])).ref, "Hor");
});

test("random pool: 1:3 shares, roll 0 never picked, no uniform row/column", () => {
  const f = folder("pool", [T("a", "11111111", 1, 0), T("b", "11111111", 3, 1), T("z", "11111111", 0, 2)]);
  let a = 0, n = 0;
  for (let i = 0; i < 100; i++) for (let j = 0; j < 100; j++) {
    const r = at(f, "11111111", i, j);
    assert.notStrictEqual(r.ref, "z");
    if (r.ref === "a") a++;
    n++;
  }
  assert.ok(Math.abs(a / n - 0.25) < 0.03, "share a = " + a / n);
  assert.deepStrictEqual(S.pickPercentages(S.buildCandidates(f)["11111111"].pool).map(p => p.probability), [0.25, 0.75]);

  const eq = folder("eq", [T("a", "11111111"), T("b", "11111111")]);
  const g = Array.from({ length: 50 }, (_, y) => Array.from({ length: 50 }, (_, x) => at(eq, "11111111", x, y).ref));
  for (let i = 0; i < 50; i++) {
    assert.ok(new Set(g[i]).size > 1, "row " + i);
    assert.ok(new Set(g.map(row => row[i])).size > 1, "col " + i);
  }
});

test("roll-0 only code is unavailable; next best wins; nothing -> null", () => {
  const f = folder("r0", [T("a", "00001000", 0), T("b", "00000000", 1)]);
  assert.strictEqual(at(f, bits(["E"])).ref, "b");
  assert.strictEqual(at(folder("none", [T("a", "00001000", 0)]), "00001000"), null);
  assert.strictEqual(at(folder("empty", []), "00001000"), null);
});

test("flip derives; ops recorded", () => {
  const f = folder("flip", [T("p", "00001000")], { flip: true });
  const r = at(f, "00010000");
  assert.strictEqual(r.status, "derived");
  assert.strictEqual(r.derivedFrom.ref, "p");
  assert.deepStrictEqual(r.ops, ["flipH"]);
  const f2 = folder("flip2", [T("p", "00001000")], { flip: true, spin: true });
  const r2 = at(f2, "01000000");
  assert.deepStrictEqual(r2.ops, ["spin", "spin", "spin"]);
  assert.strictEqual(at(folder("noflip", [T("p", "00001000")]), "00010000").code, "00001000");
});

test("hash2D range and stringToInt stability", () => {
  for (let i = 0; i < 1000; i++) { const h = S.hash2D(i, -i, 7); assert.ok(h >= 0 && h < 1); }
  assert.strictEqual(S.stringToInt("abc"), S.stringToInt("abc"));
  assert.notStrictEqual(S.stringToInt("abc"), S.stringToInt("abd"));
  assert.notStrictEqual(S.hash2D(1, 2, 3), S.hash2D(2, 1, 3));
});

test("determinism: 1000 repeated resolves identical", () => {
  const first = JSON.stringify(S.resolve(rails, "00000000", { x: 5, y: 9, salt: "rails" }).ref);
  const cands = S.buildCandidates(rails);
  for (let i = 0; i < 1000; i++) {
    assert.strictEqual(JSON.stringify(S.resolve(rails, "00000000", { x: 5, y: 9, salt: "rails" }).ref), first);
    assert.strictEqual(S.resolve(rails, "00000000", { x: 5, y: 9, salt: "rails", candidates: cands }).ref, JSON.parse(first));
  }
});

test("coverage: fallback vs missing, cardinal-only detection", () => {
  const cov = S.coverage(fence);
  assert.strictEqual(cov.find(r => r.code === "00001000").status, "fallback");
  assert.strictEqual(cov.find(r => r.code === "00001000").fallbackCode, "00000000");
  assert.ok(cov.every(r => r.status === "explicit" || r.status === "fallback"));
  assert.ok(S.folderMode(fence).cardinalOnly && S.folderMode(rope).cardinalOnly && S.folderMode(rails).cardinalOnly);
  assert.ok(!S.folderMode(water).cardinalOnly);
  assert.strictEqual(S.CARDINAL_CODES.length, 16);
  assert.strictEqual(S.folderMode(water).kind, "compose");
  assert.strictEqual(S.folderMode(rope).kind, "connections");
  // spin on but composition impossible -> red
  const bad = S.coverage(folder("bad", [T("i", "11111111")], { spin: true }));
  assert.ok(bad.some(r => r.status === "missing"));
  // no spin/flip -> fallback, never red
  assert.ok(S.coverage(rope).every(r => r.status !== "missing"));
});

console.log(`\n${passed} passed`);

// ── Phase 6: quadrant ranking, per-tile transforms, exact mode ────────────────────────────────────────
const TF = (ref, code, rot, flp, extra = {}) => ({ ref, sensorCode: code, sensorRoll: 1, sortIndex: 0, rotatable: rot, flippable: flp, ...extra });
const base6 = (rot = true, flp = true) => ["00001011", "01101011", "01111111", "11111111"].map(c => TF("t" + c, c, rot, flp));
const rec = (f, code) => S.buildCandidates(f)[code].recipe;
const src = (r, q) => `${r[q].sourceTileRef.slice(1)}${r[q].flip ? " flip" : ""}${r[q].spinSteps ? " spin" + r[q].spinSteps : ""}`;

test("ranking: 01000010 left quadrants from 01101011 unflipped, right from its flip", () => {
  const f = folder("w", base6());
  const r = rec(f, "01000010");
  assert.ok(r, "composed");
  assert.strictEqual(src(r, 0), "01101011"); // TL
  assert.strictEqual(src(r, 3), "01101011"); // BL
  assert.strictEqual(src(r, 1), "01101011 flip"); // TR
  assert.strictEqual(src(r, 2), "01101011 flip"); // BR
  assert.strictEqual(r.majorityRef, "t01101011");
});

test("ranking: 01001011 bottom-right interior from 01101011 unflipped, top-right inner corner from the flipped inner-corner tile", () => {
  const r = rec(folder("w", base6()), "01001011");
  assert.strictEqual(r[2].type, "interior");
  assert.strictEqual(src(r, 2), "01101011");
  assert.strictEqual(r[1].type, "inner");
  assert.strictEqual(src(r, 1), "01111111 flip");
});

test("ranking: 11011011 bottom-right interior from 11111111, not 00001011", () => {
  const r = rec(folder("w", base6()), "11011011");
  assert.strictEqual(r[2].type, "interior");
  assert.strictEqual(src(r, 2), "11111111");
});

test("ranking: fewer transforms beat closer bits (none < flip < spin)", () => {
  const costs = rec(folder("w", base6()), "01000010").map(e => (e.flip ? 1 : 0) + (e.spinSteps ? 2 : 0));
  assert.deepStrictEqual(costs, [0, 1, 1, 0]);
});

test("per-tile flags: only tiles with rotatable/flippable derive or contribute", () => {
  const tiles = [TF("a", "01111111", true, false), TF("b", "00001011", false, false)];
  const f = folder("p", tiles, { spin: false, flip: false }); // folder-level settings are ignored when tiles carry flags
  const c = S.buildCandidates(f);
  assert.strictEqual(c["11011111"].status, "derived"); // spin of a
  assert.ok(c["11011111"].pool.every(e => e.ref === "a"));
  assert.ok(Object.values(c).every(x => x.status !== "derived" || x.pool.every(e => e.ref !== "b")));
  for (const code of S.ALL_CODES) if (c[code].status === "composed") for (const e of c[code].recipe) if (e.sourceTileRef === "b") assert.ok(!e.flip && !e.spinSteps, "tile b cannot transform");
  const rb = S.buildCandidates(folder("q", [TF("b", "00001011", false, false)]));
  assert.ok(Object.values(rb).every(x => x.status === "explicit" || x.status === "missing"));
});

test("recipes record source tile, quadrant and transform; majority tile supplies size/flags", () => {
  const r = rec(folder("w", base6()), "01000010");
  for (const e of r) assert.ok(e.sourceTileRef && e.sourceQuadrant >= 0 && typeof e.flip === "boolean" && e.spinSteps >= 0);
  const pool = S.buildCandidates(folder("w", base6()))["01000010"].pool[0];
  assert.strictEqual(pool.majorityRef, "t01101011");
  assert.strictEqual(pool.majorityTile.ref, "t01101011");
  // tie: two quadrants from each of two tiles -> the best-ranked source wins
  const f = folder("w2", [TF("x1", "01101011", true, true, { sortIndex: 5 }), TF("x2", "01101011", true, true, { sortIndex: 1 })]);
  assert.strictEqual(S.buildCandidates(f)["01000010"].pool[0].majorityRef, "x2");
});

test("fallback sentinel 10100101: normalise passes it through, real neighbourhood is still normalised", () => {
  assert.strictEqual(S.normalise("10100101"), "10100101");
  assert.ok(S.isCode("10100101"));
  const f = folder("x", [TF("z", "00000000", false, false), TF("se", "00001010", false, false)]);
  assert.strictEqual(at(f, "10100101").code, "00000000"); // a neighbourhood shaped like the sentinel is normalised like any other (diagonals without orthogonals vanish)
});

test("exact mode: exact explicit match, derived by per-tile flags, else the 10100101 tile; no scoring", () => {
  const f = folder("fence", [TF("c", "00000000", false, false), TF("h", "00011000", false, false), TF("v", "01000010", true, false), TF("fb", "10100101", false, false),
    TF("L", "00001000", false, true)]);
  assert.strictEqual(S.folderMode(f).kind, "exact");
  assert.ok(!S.isFenceFolder(f));
  assert.strictEqual(at(f, "00011000").ref, "h");
  assert.strictEqual(at(f, "01000010").ref, "v");
  assert.strictEqual(at(f, "00000000").ref, "c");
  assert.strictEqual(at(f, "00010000").ref, "L"); // flip of L (E -> W), allowed by L's own flag
  const spun = at(f, "01000010");
  assert.strictEqual(spun.code, "01000010");
  const hv = S.buildCandidates(f)["00011000"]; // explicit wins over spin of v
  assert.strictEqual(hv.status, "explicit");
  // anything else -> the fallback tile (no cardinal-only match, no scoring)
  for (const nb of ["01011010", "11111111", "01001000", "00001010"]) {
    const r = at(f, nb);
    assert.strictEqual(r.ref, "fb", nb);
    assert.strictEqual(r.code, "10100101");
    assert.strictEqual(r.recipe, null);
  }
  // v can spin (rotatable) -> 00011000 is explicit anyway; a spin-only code such as a lone W or E is not made by v alone
  assert.strictEqual(at(f, "00001000").ref, "L");
});

test("exact mode: nothing composed, coverage lists explicit/derived plus the fallback only", () => {
  const tiles = [...base6(), TF("fb", "10100101", true, true)];
  const f = folder("w", tiles);
  const c = S.buildCandidates(f);
  assert.ok(Object.values(c).every(x => x.status !== "composed"));
  assert.ok(S.ALL_CODES.every(code => c[code].status !== "composed"));
  const cov = S.coverage(f);
  assert.ok(cov.every(r => ["explicit", "derived", "fallback-tile"].includes(r.status)));
  assert.strictEqual(cov.filter(r => r.status === "fallback-tile").length, 1);
  assert.strictEqual(cov[cov.length - 1].code, "10100101");
  assert.ok(!cov.some(r => r.code !== "10100101" && !c[r.code].pool.length));
  // sentinel never in the 47 and never a source
  assert.ok(!S.ALL_CODES.includes("10100101"));
  for (const r of cov) if (r.status === "derived") assert.ok(r.sources.every(s => s.code !== "10100101"));
});

test("exact mode needs roll > 0: a roll-0 sentinel tile leaves the old behaviour", () => {
  const off = folder("fence", [T("f0", "00000000"), T("fh", "00011000"), T("fv", "01000010"), T("fb", "10100101", 0)]);
  assert.strictEqual(S.folderMode(off).kind, "fence");
  assert.strictEqual(at(off, "01011010").code, "00000000");
  const on = folder("fence", [T("f0", "00000000"), T("fh", "00011000"), T("fv", "01000010"), T("fb", "10100101", 2)]);
  assert.strictEqual(S.folderMode(on).kind, "exact");
  assert.strictEqual(at(on, "01011010").ref, "fb");
  assert.strictEqual(at(on, "01011010").code, "10100101");
});

test("exact mode: fallback pool honours rolls", () => {
  const f = folder("e", [T("a", "00000000"), T("fb1", "10100101", 1), T("fb2", "10100101", 3)]);
  const seen = {};
  for (let x = 0; x < 400; x++) { const r = S.resolve(f, "11111111", { x, y: x * 3, salt: "e" }); seen[r.ref] = (seen[r.ref] || 0) + 1; }
  assert.ok(seen.fb2 > seen.fb1 * 2, JSON.stringify(seen));
});

test("without a 10100101 tile: water still composes, rails still score, fence rule kept", () => {
  assert.strictEqual(S.folderMode(folder("w", base6())).kind, "compose");
  assert.strictEqual(S.folderMode(folder("r", [T("a", "00001010"), T("b", "00010010")])).kind, "connections");
  assert.strictEqual(S.folderMode(folder("f", [T("f0", "00000000"), T("fh", "00011000"), T("fv", "01000010")])).kind, "fence");
});
