// Run with: node tests/map_seed.test.js   (no dependencies)
const assert = require("assert");
const M = require("../map_seed.js");

let passed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log("ok   " + name); } catch (e) { console.error("FAIL " + name + "\n" + e.stack); process.exitCode = 1; } };

// Deterministic PRNG so failures reproduce.
const rng = seed => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const SYMS = ["M", "X", "Y", "W", "1", "8", "c", "6", "7", "é", "😀", "2", "3", "4", "b", "r"];
const blank = (w, h) => Array.from({ length: h }, () => Array(w).fill(null));
const randomGrid = (w, h, rand, nsyms = 5, density = 0.6) => {
  const g = blank(w, h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) if (rand() < density) g[r][c] = SYMS[Math.floor(rand() * nsyms)];
  return g;
};
// Force the symmetry class about the effective centre of (w, h, magnet) by copying the region onto its orbits.
const symmetrise = (g, w, h, magnet, cls, partner = M.mirrorSymbol) => {
  const sums = M.effectiveSums(w, h, magnet);
  for (const [r, c] of M.regionCells(w, h, sums, cls)) for (const im of M.orbitOf(r, c, cls, w, h, sums)) g[im.r][im.c] = partner(g[r][c], { x: im.fx, y: im.fy });
  return g;
};
const flip = (g, h, w) => g.map(row => row.slice());
const eqGrid = (a, b) => assert.deepStrictEqual(a, b);
const roundTrip = (w, h, grid, magnet, tileset = 0) => {
  const e = M.encode({ w, h, grid, magnet, tileset });
  const d = M.decode(e.seed);
  assert.ok(d.ok, e.seed + " -> " + d.error);
  eqGrid(d.grid, grid);
  assert.deepStrictEqual([d.size.w, d.size.h], [w, h]);
  assert.strictEqual(d.tileset, tileset);
  assert.strictEqual(d.mirror, e.mirror);
  assert.strictEqual(M.encode({ w, h, grid: d.grid, magnet: d.magnet, tileset: d.tileset }).seed, e.seed, "decode -> encode is stable");
  return e;
};

const SIZES = [[21, 33], [60, 60], [1, 1], [2, 2], [7, 5], [10, 9], [9, 10], [3, 1], [1, 4], [99, 99], [33, 21]];
const MAGNETS = [null, { col: 3, row: 2, size: 1 }, { col: 4, row: 4, size: 2 }, { col: 1, row: 3, size: 3 }, { col: 2, row: 0, size: 4 }, { col: 0, row: 0, size: 1 }];

test("round trip: random maps in every mirror class, presets and custom sizes, with and without magnet", () => {
  const rand = rng(12345);
  let n = 0;
  for (const [w, h] of SIZES) for (const mag of MAGNETS) {
    if (mag && (mag.col >= w || mag.row >= h)) continue;
    for (const cls of ["a", "h", "v", "d", "4"]) {
      const g = symmetrise(randomGrid(w, h, rand, 1 + Math.floor(rand() * 6), 0.3 + rand() * 0.7), w, h, mag, cls);
      const e = roundTrip(w, h, g, mag, Math.floor(rand() * 40));
      // the detected class is at least as strong as the one forced
      const forcedSize = M.regionCells(w, h, M.effectiveSums(w, h, mag), cls).length;
      assert.ok(e.regionSize <= forcedSize, `${w}x${h} ${cls}: region ${e.regionSize} > ${forcedSize}`);
      n++;
    }
  }
  assert.ok(n > 200);
});

test("determinism: encoding twice gives the same seed, and equal maps give equal seeds", () => {
  const rand = rng(7);
  const g = symmetrise(randomGrid(21, 33, rand, 4, 0.5), 21, 33, null, "4");
  const a = M.encode({ w: 21, h: 33, grid: g, tileset: 3 }).seed;
  assert.strictEqual(M.encode({ w: 21, h: 33, grid: g, tileset: 3 }).seed, a);
  assert.strictEqual(M.encode({ w: 21, h: 33, grid: g.map(r => r.slice()), tileset: 3 }).seed, a);
});

test("detection picks the strongest class", () => {
  const w = 7, h = 5;
  const cls = g => M.detectMirror(g.map(r => r.map(s => (s == null ? 0 : s))), w, h, null);
  assert.strictEqual(cls(blank(w, h)), "4"); // empty is symmetric every way
  const h_only = blank(w, h); h_only[0][0] = "M"; h_only[0][6] = "M";
  assert.strictEqual(cls(h_only), "h");
  const v_only = blank(w, h); v_only[0][1] = "M"; v_only[4][1] = "M";
  assert.strictEqual(cls(v_only), "v");
  const d_only = blank(w, h); d_only[0][1] = "M"; d_only[4][5] = "M";
  assert.strictEqual(cls(d_only), "d");
  const all4 = blank(w, h); [[0, 1], [0, 5], [4, 1], [4, 5]].forEach(([r, c]) => { all4[r][c] = "M"; });
  assert.strictEqual(cls(all4), "4");
  const a = blank(w, h); a[0][1] = "M";
  assert.strictEqual(cls(a), "a");
  // any two of h, v, d imply the third (centred map)
  const hv = blank(w, h); hv[1][1] = "X"; hv[1][5] = "X"; hv[3][1] = "X"; hv[3][5] = "X";
  assert.strictEqual(cls(hv), "4");
  // a centre-column-only picture is h and v and d at once
  const col = blank(w, h); for (let r = 0; r < h; r++) col[r][3] = "Y";
  assert.strictEqual(cls(col), "4");
});

test("near-symmetric maps fall back correctly", () => {
  const rand = rng(99);
  for (const [w, h] of [[21, 33], [8, 8], [9, 6]]) {
    const base = symmetrise(randomGrid(w, h, rand, 3, 0.7), w, h, null, "4");
    assert.strictEqual(M.encode({ w, h, grid: base, tileset: 0 }).mirror, "4");
    // one cell off: not 4, not d. h/v/d each broken by that one change, unless the cell is on an axis
    const g = base.map(r => r.slice());
    g[0][0] = g[0][0] === "M" ? "X" : "M";
    assert.strictEqual(M.encode({ w, h, grid: g, tileset: 0 }).mirror, "a", w + "x" + h);
    // h + v images of the cell kept in step -> h only? No: break only the v image and d image (left-right pair stays equal)
    const g2 = base.map(r => r.slice());
    const nv = g2[0][0] === "M" ? "X" : "M";
    g2[0][0] = nv; g2[0][w - 1] = nv; // h still holds, v and d broken
    assert.strictEqual(M.encode({ w, h, grid: g2, tileset: 0 }).mirror, "h");
    const g3 = base.map(r => r.slice());
    g3[0][0] = nv; g3[h - 1][0] = nv; // v still holds
    assert.strictEqual(M.encode({ w, h, grid: g3, tileset: 0 }).mirror, "v");
    const g4 = base.map(r => r.slice());
    g4[0][0] = nv; g4[h - 1][w - 1] = nv; // d still holds
    assert.strictEqual(M.encode({ w, h, grid: g4, tileset: 0 }).mirror, "d");
  }
});

test("symmetry is judged about the effective centre (magnet), not the grid centre", () => {
  const w = 11, h = 9, mag = { col: 3, row: 2, size: 1 };
  const g = symmetrise(randomGrid(w, h, rng(5), 4, 0.8), w, h, mag, "4");
  assert.strictEqual(M.encode({ w, h, grid: g, magnet: mag, tileset: 0 }).mirror, "4");
  assert.notStrictEqual(M.encode({ w, h, grid: g, magnet: null, tileset: 0 }).mirror, "4");
  const e = roundTrip(w, h, g, mag);
  assert.strictEqual(e.fields.magnet, "3.2");
});

test("magnet field: x for default, col.row, size only when not 1; default-equivalent magnets collapse to x", () => {
  const g = blank(10, 10);
  assert.strictEqual(M.encode({ w: 10, h: 10, grid: g, magnet: { col: 4, row: 4, size: 2 }, tileset: 0 }).fields.magnet, "x"); // 2x2 at 4,4 centres on (4.5,4.5)
  assert.strictEqual(M.encode({ w: 10, h: 10, grid: g, magnet: { col: 2, row: 3, size: 1 }, tileset: 0 }).fields.magnet, "2.3");
  assert.strictEqual(M.encode({ w: 10, h: 10, grid: g, magnet: { col: 2, row: 3, size: 3 }, tileset: 0 }).fields.magnet, "2.3.3");
  assert.strictEqual(M.encode({ w: 9, h: 9, grid: blank(9, 9), magnet: { col: 4, row: 4, size: 1 }, tileset: 0 }).fields.magnet, "x");
  assert.deepStrictEqual(M.parseMagnet("2.3.4", 10, 10), { col: 2, row: 3, size: 4 });
  assert.deepStrictEqual(M.parseMagnet("2,3,4", 10, 10, true), { col: 2, row: 3, size: 4 }, "old spelling, legacy only");
  assert.strictEqual(M.parseMagnet("2,3", 10, 10), undefined, "the comma spelling is not a new-format magnet");
  assert.strictEqual(M.parseMagnet("2.3", 10, 10, true), undefined, "the dot spelling is not an old-format magnet");
  assert.strictEqual(M.parseMagnet("x", 10, 10), null);
  for (const bad of ["", "2", "2.3.1", "2.3.5", "10.3", "2.10", "02.3", "2.3.", ".3", "a.b", "2.3.2.1", "-1.3", "2,3", "2..3"]) assert.strictEqual(M.parseMagnet(bad, 10, 10), undefined, bad);
});

test("effectiveCenter equals the app's getEffectiveCenter formula (clamping included)", () => {
  // the app: cR = max(szR/2, min(H-1-szR/2, cc.r + szR/2))
  const app = (w, h, cc, sz) => {
    if (!cc) return { cR: (h - 1) / 2, cC: (w - 1) / 2 };
    const szR = sz === 2 || sz === 4 ? 1 : 0, szC = sz === 2 || sz === 3 ? 1 : 0;
    return { cR: Math.max(szR / 2, Math.min(h - 1 - szR / 2, cc.r + szR / 2)), cC: Math.max(szC / 2, Math.min(w - 1 - szC / 2, cc.c + szC / 2)) };
  };
  for (const [w, h] of [[21, 33], [10, 9], [1, 1], [2, 3]]) for (const sz of [1, 2, 3, 4]) {
    for (const cc of [null, { r: 0, c: 0 }, { r: h - 1, c: w - 1 }, { r: 3, c: 2 }, { r: -4, c: 99 }, { r: 100, c: -2 }]) {
      assert.deepStrictEqual(M.effectiveCenter(w, h, cc, sz), app(w, h, cc, sz), `${w}x${h} ${JSON.stringify(cc)} ${sz}`);
      // exporting the app's magnet state keeps the same effective centre
      const m = M.magnetFromApp(w, h, cc, sz);
      const back = m ? M.effectiveCenter(w, h, { r: m.row, c: m.col }, m.size) : M.effectiveCenter(w, h, null, 1);
      assert.deepStrictEqual(back, app(w, h, cc, sz), `magnetFromApp ${w}x${h} ${JSON.stringify(cc)} ${sz}`);
    }
  }
});

test("mirror flag mapping: seed h = the app's mirrorV (Horizontal, left<->right), seed v = mirrorH (Vertical, top<->bottom)", () => {
  assert.deepStrictEqual(M.CLASS_FLAGS.h, { mirrorV: true, mirrorH: false, mirrorD: false });
  assert.deepStrictEqual(M.CLASS_FLAGS.v, { mirrorV: false, mirrorH: true, mirrorD: false });
  assert.deepStrictEqual(M.CLASS_FLAGS.d, { mirrorV: false, mirrorH: false, mirrorD: true });
  assert.deepStrictEqual(M.CLASS_FLAGS[4], { mirrorV: true, mirrorH: true, mirrorD: true });
  assert.deepStrictEqual(M.CLASS_FLAGS.a, { mirrorV: false, mirrorH: false, mirrorD: false });
  // geometry: h images share the row (left<->right), v images share the column (top<->bottom)
  const sums = M.effectiveSums(7, 5, null);
  assert.deepStrictEqual(M.imagesOf(1, 1, "h", 7, 5, sums), [[1, 5]]);
  assert.deepStrictEqual(M.imagesOf(1, 1, "v", 7, 5, sums), [[3, 1]]);
  assert.deepStrictEqual(M.imagesOf(1, 1, "d", 7, 5, sums), [[3, 5]]);
  // a left-right symmetric map is exported as h
  const g = blank(7, 5); g[1][1] = "M"; g[1][5] = "M";
  assert.strictEqual(M.encode({ w: 7, h: 5, grid: g, tileset: 0 }).mirror, "h");
});

test("fundamental region sizes for centred maps", () => {
  const n = (w, h, cls) => M.regionCells(w, h, M.effectiveSums(w, h, null), cls).length;
  assert.strictEqual(n(21, 33, "a"), 21 * 33);
  assert.strictEqual(n(21, 33, "h"), 11 * 33);
  assert.strictEqual(n(21, 33, "v"), 21 * 17);
  assert.strictEqual(n(21, 33, "4"), 11 * 17);
  assert.strictEqual(n(21, 33, "d"), (21 * 33 + 1) / 2);
  assert.strictEqual(n(60, 60, "4"), 900);
  assert.strictEqual(n(60, 60, "d"), 1800);
  // region cells are row-major and each orbit has exactly one member in it
  const cells = M.regionCells(7, 5, M.effectiveSums(7, 5, null), "4");
  assert.deepStrictEqual(cells.slice(0, 5), [[0, 0], [0, 1], [0, 2], [0, 3], [1, 0]]);
});

test("empty map and single-tile map", () => {
  const e = M.encode({ w: 21, h: 33, grid: blank(21, 33), tileset: 0 });
  assert.strictEqual(e.fields.palette, "");
  assert.strictEqual(e.mirror, "4");
  assert.ok(M.decode(e.seed).ok);
  eqGrid(M.decode(e.seed).grid, blank(21, 33));
  const one = blank(5, 5); one[2][2] = "W";
  const e1 = roundTrip(5, 5, one, null);
  assert.strictEqual(e1.fields.palette, "W");
  const full = Array.from({ length: 6 }, () => Array(4).fill("X"));
  roundTrip(4, 6, full, null);
  roundTrip(1, 1, [[null]], null);
  roundTrip(1, 1, [["é"]], null);
  const lone = blank(21, 33); lone[0][0] = "M"; // asymmetrical single tile
  assert.strictEqual(roundTrip(21, 33, lone, null).mirror, "a");
});

test("palette order: frequency descending over the FULL map, ties by code point, unicode symbols by code point", () => {
  const g = blank(6, 1);
  ["b", "a", "b", "a", "C", "😀"].forEach((s, i) => { g[0][i] = s; });
  const e = M.encode({ w: 6, h: 1, grid: g, tileset: 0 });
  assert.strictEqual(e.fields.palette, "abC😀"); // a,b count 2 (tie -> a < b), then C (67) < 😀
  roundTrip(6, 1, g, null);
  // frequency counts the full map, not the region: a mirrored pair counts twice
  const m = blank(5, 3); m[0][0] = "Q"; m[0][4] = "Q"; m[0][2] = "A"; m[0][1] = "B"; m[0][3] = "B";
  const em = M.encode({ w: 5, h: 3, grid: m, tileset: 0 });
  assert.strictEqual(em.mirror, "h");
  assert.strictEqual(em.fields.palette, "BQA"); // B 2, Q 2 (B < Q), A 1
  // case-sensitive
  const cs = blank(2, 1); cs[0][0] = "a"; cs[0][1] = "A";
  assert.strictEqual(M.encode({ w: 2, h: 1, grid: cs, tileset: 0 }).fields.palette, "Aa");
});

test("sizes: 3v3 and SD aliases, WxH otherwise", () => {
  assert.strictEqual(M.encodeSize(21, 33), "3v3");
  assert.strictEqual(M.encodeSize(60, 60), "SD");
  assert.strictEqual(M.encodeSize(33, 21), "33x21");
  assert.strictEqual(M.encodeSize(1, 99), "1x99");
  assert.deepStrictEqual(M.parseSize("3v3"), { w: 21, h: 33 });
  assert.deepStrictEqual(M.parseSize("SD"), { w: 60, h: 60 });
  assert.deepStrictEqual(M.parseSize("21x33"), { w: 21, h: 33 });
  assert.ok(M.encode({ w: 21, h: 33, grid: blank(21, 33), tileset: 0 }).seed.startsWith("3v3,"));
  assert.ok(M.encode({ w: 60, h: 60, grid: blank(60, 60), tileset: 0 }).seed.startsWith("SD,"));
  for (const bad of ["", "0x5", "5x0", "100x5", "5x100", "5X5", "5x", "x5", "5", "3V3", "sd", "05x5", "5x5x5", "-1x5", "1.5x2"]) assert.strictEqual(M.parseSize(bad), null, bad);
});

test("malformed input is rejected with a clear error, never an exception", () => {
  const good = M.encode({ w: 5, h: 5, grid: symmetrise(randomGrid(5, 5, rng(3), 3), 5, 5, null, "4"), tileset: 2 }).seed;
  const f = good.split(",");
  assert.strictEqual(f.length, 6);
  const swap = (i, v) => f.map((x, j) => (j === i ? v : x)).join(",");
  const cases = {
    "empty": "",
    "spaces only": "   ",
    "no separators": "abc",
    "five fields": f.slice(0, 5).join(","),
    "seven fields": good + ",x",
    "bad size": swap(0, "0x5"),
    "bad size 2": swap(0, "abc"),
    "bad magnet": swap(1, "9.9"),
    "bad magnet 2": swap(1, "x."),
    "old magnet spelling in a new seed": swap(1, "2,2"),
    "bad mirror": swap(2, "z"),
    "empty mirror": swap(2, ""),
    "bad tileset": swap(3, "-1"),
    "tileset letters": swap(3, "abc"),
    "tileset leading zero": swap(3, "007"),
    "tileset huge": swap(3, "99999999999999"),
    "duplicate palette symbol": swap(4, "MM"),
    "empty code": swap(5, ""),
    "code not base62": swap(5, "ab-c"),
    "code leading zero": swap(5, "0abc"),
    "code with space": swap(5, "ab c"),
    "inner whitespace": good.replace(",", ", "),
    "comma in a symbol position (extra field)": swap(4, "M,Y"),
    "old form with the wrong number of parts": "5x5/x/4/0/M",
    "newline": good + "\nx",
    "control char in palette": swap(4, "M\u0001"),
  };
  for (const [name, seed] of Object.entries(cases)) {
    let d;
    assert.doesNotThrow(() => { d = M.decode(seed); }, name);
    assert.strictEqual(d.ok, false, name + " should be rejected");
    assert.ok(typeof d.error === "string" && d.error.length > 10, name + ": " + d.error);
    assert.strictEqual(d.grid, null);
  }
  for (const junk of [null, undefined, 5, {}, [], "\u0000", "/////", "//////", ",,,,,", ",,,,,,", "x".repeat(100000), "3v3,x,4,0,A," + "z".repeat(40000), "3v3/x/4/0/A/" + "z".repeat(40000), "," .repeat(5000), "/" .repeat(5000)]) {
    assert.doesNotThrow(() => M.decode(junk));
    assert.strictEqual(M.decode(junk).ok, false);
  }
});

test("cell-count mismatches are rejected: too few, too many, truncated, wrong palette size", () => {
  // build code streams by hand: 3x1 asymmetric map, palette "A" (k = 1)
  const mk = bits => M.bitsToBase62(bits);
  const gamma = n => { const b = n.toString(2); return "0".repeat(b.length - 1) + b; };
  const seedOf = (sizeS, mir, pal, bits) => `${sizeS}/x/${mir}/0/${pal}/${mk(bits)}`;
  const ok = M.decode(seedOf("3x1", "a", "A", "1" + gamma(3)));
  assert.ok(ok.ok, ok.error); eqGrid(ok.grid, [["A", "A", "A"]]);
  const few = M.decode(seedOf("3x1", "a", "A", "1" + gamma(2)));
  assert.ok(!few.ok && /2 cells/.test(few.error) && /needs 3/.test(few.error), few.error);
  const many = M.decode(seedOf("3x1", "a", "A", "1" + gamma(4)));
  assert.ok(!many.ok && /more cells/.test(many.error), many.error);
  const many2 = M.decode(seedOf("3x1", "a", "A", "1" + gamma(2) + "0" + gamma(2)));
  assert.ok(!many2.ok && /more cells/.test(many2.error), many2.error);
  const trunc = M.decode(seedOf("3x1", "a", "A", "1" + "00"));
  assert.ok(!trunc.ok && /truncated/.test(trunc.error), trunc.error);
  const trunc2 = M.decode(seedOf("3x1", "a", "A", "1" + "0001"));
  assert.ok(!trunc2.ok && /truncated/.test(trunc2.error), trunc2.error);
  const truncV = M.decode(seedOf("3x1", "a", "AB", "1"));
  assert.ok(!truncV.ok && /middle of a run/.test(truncV.error), truncV.error);
  const badIdx = M.decode(seedOf("3x1", "a", "A", "11" + gamma(3))); // k = 1 so index 1 max... use palette "" with k = 0 and value impossible
  assert.ok(badIdx.ok === false);
  const noPalIdx = M.decode(seedOf("3x1", "a", "AB", "11" + gamma(3))); // k = 2, value 3 > 2 tiles
  assert.ok(!noPalIdx.ok && /tile number 3/.test(noPalIdx.error), noPalIdx.error);
  // mirrored region: 4x4 class 4 needs 4 cells, not 16
  const reg = M.decode(seedOf("4x4", "4", "A", "1" + gamma(16)));
  assert.ok(!reg.ok && /mirrored region/.test(reg.error), reg.error);
  const reg2 = M.decode(seedOf("4x4", "4", "A", "1" + gamma(4)));
  assert.ok(reg2.ok && reg2.grid.every(r => r.every(s => s === "A")));
  // every truncation / extension of a real seed is rejected or decodes to the same size, never throws
  const rand = rng(21);
  const g = symmetrise(randomGrid(9, 7, rand, 4), 9, 7, null, "h");
  const real = M.encode({ w: 9, h: 7, grid: g, tileset: 1 });
  for (let cut = 1; cut < real.fields.code.length; cut++) {
    const s = [real.fields.size, real.fields.magnet, real.fields.mirror, real.fields.tileset, real.fields.palette, real.fields.code.slice(0, cut)].join("/");
    const d = M.decode(s);
    assert.ok(d.ok === false || (d.grid.length === 7 && d.grid[0].length === 9));
  }
  const flipped = real.fields.code.split("").map((c, i) => (i === 0 ? M.B62[(M.B62.indexOf(c) + 1) % 62] : c)).join("");
  assert.doesNotThrow(() => M.decode(real.seed.replace(real.fields.code, flipped)));
});

test("fuzz: random single-character edits of valid seeds never throw and never produce a wrong-sized grid", () => {
  const rand = rng(77);
  for (let n = 0; n < 300; n++) {
    const w = 1 + Math.floor(rand() * 12), h = 1 + Math.floor(rand() * 12);
    const g = randomGrid(w, h, rand, 4);
    const seed = M.encode({ w, h, grid: g, tileset: Math.floor(rand() * 5) }).seed;
    const i = Math.floor(rand() * seed.length);
    const chars = "0123456789abcxyzXYZ/,Vv4a ";
    const mutated = seed.slice(0, i) + chars[Math.floor(rand() * chars.length)] + seed.slice(i + 1);
    let d;
    assert.doesNotThrow(() => { d = M.decode(mutated); }, mutated);
    if (d.ok) { assert.strictEqual(d.grid.length, d.size.h); assert.ok(d.grid.every(r => r.length === d.size.w)); assert.strictEqual(d.cellCount, d.size.w * d.size.h); }
    else assert.ok(d.error);
  }
});

test("extractSeed: bare seed, seed=, share link with percent escapes", () => {
  const g = blank(5, 5); g[0][0] = "%"; g[4][4] = "#"; g[2][2] = "😀";
  const e = M.encode({ w: 5, h: 5, grid: g, tileset: 0 });
  assert.strictEqual(M.extractSeed("  " + e.seed + " \n").text, e.seed);
  const link = "https://example.test/app/index.html?x=1#seed=" + encodeURIComponent(e.seed);
  assert.strictEqual(M.extractSeed(link).text, e.seed);
  assert.strictEqual(M.extractSeed("#seed=" + encodeURIComponent(e.seed)).text, e.seed);
  assert.strictEqual(M.extractSeed("seed=" + encodeURIComponent(e.seed)).text, e.seed);
  assert.ok(M.decode(link).ok);
  eqGrid(M.decode(link).grid, g);
  // a fragment that is not valid percent-encoding is used as written (a bare "%" symbol), not an error
  assert.strictEqual(M.extractSeed("https://example.test/#seed=5x5,x,a,0,%,1").text, "5x5,x,a,0,%,1");
  assert.ok(M.extractSeed("https://example.test/").error);
  assert.ok(!M.decode("https://example.test/#seed=%E0%A4%A").ok);
});

test("symbols: comma, slash, whitespace, control characters and multi-character strings are not symbols", () => {
  for (const s of [",", "/", " ", "\t", "\n", "\u0000", "", "ab", "​", null, 5]) assert.strictEqual(M.isValidSymbol(s), false, JSON.stringify(s));
  for (const s of ["a", "A", "6", "7", "é", "😀", "~", "#", "%", "|"]) assert.strictEqual(M.isValidSymbol(s), true, s);
  assert.throws(() => M.encode({ w: 1, h: 1, grid: [["/"]], tileset: 0 }));
  assert.throws(() => M.encode({ w: 1, h: 1, grid: [[","]], tileset: 0 }));
  assert.deepStrictEqual([...M.BANNED_SYMBOLS].sort(), [",", ".", "/", "?"]);
  for (const s of [".", "?"]) { assert.strictEqual(M.isValidSymbol(s), false, s); assert.throws(() => M.encode({ w: 1, h: 1, grid: [[s]], tileset: 0 })); }
  for (const s of [";", ":", "-", "_"]) assert.strictEqual(M.isValidSymbol(s), true, s);
  for (const s of [",", "/", ".", "?"]) assert.ok(!M.SYMBOL_UNIVERSE.includes(s), s);
  assert.ok(M.SYMBOL_UNIVERSE.includes(";"));
});

test("symbolizeGrid: symbols per palette ref, blanks counted by kind", () => {
  const refs = ["d:a", "d:b", "u:1", "s:global|water", "d:c", "d:slash", "space"];
  const sym = { "d:a": "M", "d:b": null, "d:c": "", "d:slash": "/", "s:global|water": "W", space: "S" };
  const grid = [[0, 1, 2, null], [3, 4, 5, 6], [1, 1, 2, 0]];
  const out = M.symbolizeGrid(grid, refs, ref => sym[ref] ?? null);
  eqGrid(out.grid, [["M", null, null, null], ["W", null, null, "S"], [null, null, null, "M"]]);
  assert.deepStrictEqual(out.blanks, { upload: 2, noSymbol: 4, badSymbol: 1 });
  assert.ok(/7 cells use tiles without symbols or local uploads and will be blank/.test(M.blankSummary(out.blanks)));
  assert.strictEqual(M.blankSummary({ upload: 0, noSymbol: 0, badSymbol: 0 }), null);
  // blank cells export as empty and so do not change the encoded map
  assert.strictEqual(M.encode({ w: 4, h: 3, grid: out.grid, tileset: 0 }).fields.palette.length, 3);
});

test("symbolizeGrid: a tile whose symbol is a separator (comma, slash) exports blank as an unusable symbol", () => {
  const out = M.symbolizeGrid([[0, 1, 2]], ["d:a", "d:b", "d:c"], ref => ({ "d:a": ",", "d:b": "/", "d:c": "." })[ref]);
  eqGrid(out.grid, [[null, null, null]]);
  assert.deepStrictEqual(out.blanks, { upload: 0, noSymbol: 0, badSymbol: 3 });
});

// ── Separator: "," between the fields, "col.row.size" magnets, old "/" seeds still decode ────────────────
const toOld = seed => { // the old spelling of a new seed: "/" separators and "col,row,size" magnets
  const f = seed.split(",");
  f[1] = f[1].replace(/\./g, ",");
  return f.join("/");
};

test("new format: six comma-separated fields, dotted magnet, never a slash; the empty map and presets", () => {
  assert.strictEqual(M.encode({ w: 21, h: 33, grid: blank(21, 33), tileset: 0 }).seed, "3v3,x,4,0,,8ZX");
  assert.strictEqual(M.decode("3v3,x,4,0,,8ZX").ok, true);
  const g = symmetrise(randomGrid(11, 9, rng(8), 4, 0.7), 11, 9, { col: 3, row: 2, size: 3 }, "h");
  const e = roundTrip(11, 9, g, { col: 3, row: 2, size: 3 }, 12);
  assert.strictEqual(e.seed.split(",").length, 6);
  assert.ok(!e.seed.includes("/") && /^11x9,3\.2\.3,/.test(e.seed), e.seed);
  assert.strictEqual(e.fields.magnet, "3.2.3");
  // a palette made of awkward symbols still splits into exactly six fields
  const awk = blank(5, 5); [";", ":", "|", "%", "#", "&", "=", "<", ">", "😀", "é"].forEach((x, i) => { awk[Math.floor(i / 5)][i % 5] = x; });
  const ea = roundTrip(5, 5, awk, null);
  assert.strictEqual(ea.seed.split(",").length, 6);
});

test("old format still decodes (detected by its slashes); the result equals the new form's and re-encodes with commas", () => {
  const cases = [];
  const rand = rng(77);
  for (const [w, h, mag] of [[21, 33, null], [7, 5, { col: 3, row: 2, size: 2 }], [10, 9, { col: 1, row: 3, size: 3 }], [9, 10, { col: 2, row: 0, size: 4 }], [5, 5, { col: 2, row: 1, size: 1 }]]) {
    for (const cls of ["a", "h", "v", "d", "4"]) cases.push([w, h, mag, symmetrise(randomGrid(w, h, rand, 5, 0.6), w, h, mag, cls)]);
  }
  for (const [w, h, mag, g] of cases) {
    const neu = M.encode({ w, h, grid: g, magnet: mag, tileset: 5 });
    const old = toOld(neu.seed);
    assert.ok(old.includes("/") && old.split("/").length === 6, old);
    const d = M.decode(old);
    assert.ok(d.ok, old + " " + d.error);
    assert.strictEqual(d.legacy, true); assert.strictEqual(M.decode(neu.seed).legacy, false);
    eqGrid(d.grid, g);
    assert.deepStrictEqual(d.magnet, M.decode(neu.seed).magnet);
    assert.strictEqual(M.encode({ w, h, grid: d.grid, magnet: d.magnet, tileset: d.tileset }).seed, neu.seed, "re-encoding writes the new form");
  }
  // concrete old seeds from before the change
  assert.deepStrictEqual(M.decode("3v3/x/4/0//8ZX").size, { w: 21, h: 33 });
  assert.deepStrictEqual(M.decode("7x5/3,2,2/4/3//2G").magnet, { col: 3, row: 2, size: 2 });
  // wrong shapes of the old form are refused with the old separator named
  assert.match(M.decode("5x5/x/4/0/M").error, /6 parts separated by "\/"/);
  assert.match(M.decode("5x5,x,4,0,M").error, /6 parts separated by ","/);
  // a "/" never appears in a new seed, so a "/" always means the old form even when the old magnet put commas into the text
  assert.strictEqual(M.decode("7x5/3,2,2/4/3//2G").ok, true);
});

test("share-link fragment: written plain (no encoded , or .), read back from both the plain and the percent-encoded form", () => {
  const g = blank(9, 7); g[0][1] = ";"; g[2][2] = "%"; g[3][3] = "#"; g[4][4] = "😀"; g[1][1] = "&";
  const e = M.encode({ w: 9, h: 7, grid: g, magnet: { col: 3, row: 2, size: 1 }, tileset: 4 });
  const frag = M.seedFragment(e.seed);
  assert.ok(frag.startsWith("#seed=7x5".replace("7x5", "9x7")) || frag.startsWith("#seed=9x7,"), frag);
  assert.ok(!/%2C|%2c|%2E|%2e/.test(frag), "commas and dots are never percent-encoded: " + frag);
  assert.ok(frag.includes(",") && frag.includes("3.2"), frag);
  assert.strictEqual(frag.replace(/%25/g, "%"), "#seed=" + e.seed, "only % is escaped");
  // reading: the fragment as the app writes it (the browser keeps ASCII as typed; it escapes non-ASCII itself), and fully encoded forms
  const asBrowser = "#seed=" + e.seed.replace(/%/g, "%25").replace(/😀/g, encodeURIComponent("😀"));
  for (const link of [frag, "https://x.test/ophelia/index.html" + frag, asBrowser, "https://x.test/index.html?a=1" + asBrowser, "#seed=" + encodeURIComponent(e.seed), "seed=" + encodeURIComponent(e.seed), "https://x.test/#seed=" + encodeURIComponent(e.seed)]) {
    const t = M.extractSeed(link).text;
    assert.strictEqual(t, e.seed, link);
    const d = M.decode(link); assert.ok(d.ok, link + " " + d.error); eqGrid(d.grid, g);
  }
  // old links (encoded slashes) keep working
  const oldLink = "https://x.test/#seed=" + encodeURIComponent("3v3/x/4/0//8ZX");
  assert.strictEqual(M.decode(oldLink).ok, true);
  assert.strictEqual(M.decode("#seed=3v3%2Fx%2F4%2F0%2F%2F8ZX").ok, true);
  // a literal "%" symbol survives the round trip through the escaped fragment
  const pct = blank(3, 3); pct[0][0] = "%"; pct[0][1] = "4"; pct[0][2] = "1";
  const ep = M.encode({ w: 3, h: 3, grid: pct, tileset: 0 });
  const back = M.decode("https://x.test/" + M.seedFragment(ep.seed)); assert.ok(back.ok, back.error); eqGrid(back.grid, pct);
});

test("global symbol table", () => {
  const manifest = require("../Resources/manifest.json").global;
  const known = [];
  for (const key of manifest.order) {
    const sensor = manifest.sensor && manifest.sensor[key];
    if (sensor) { const s = M.globalSymbol("s:global|" + key); assert.ok(s, "sensor folder " + key + " needs a symbol"); if (sensor.symbol) assert.strictEqual(sensor.symbol, s, key + " manifest symbol"); known.push("s:global|" + key); continue; }
    for (const f of manifest.folders[key]) known.push("g:Resources/" + manifest.folderPaths[key] + f);
  }
  for (const ref of Object.keys(M.GLOBAL_SYMBOLS)) assert.ok(known.includes(ref), "table entry is not in the manifest: " + ref);
  // every manifest file has a symbol; only the objectives share one (8)
  const gaps = known.filter(r => M.globalSymbol(r) == null);
  assert.deepStrictEqual(gaps, [], "manifest files without a symbol");
  const seen = new Map();
  for (const ref of known) {
    const sym = M.globalSymbol(ref);
    if (sym === "8") { assert.ok(ref.includes("/Objectives/"), ref); continue; }
    assert.ok(!seen.has(sym), `${ref} and ${seen.get(sym)} share "${sym}"`);
    seen.set(sym, ref);
  }
  assert.strictEqual(M.globalSymbol("warn"), "A");
  assert.strictEqual(M.globalSymbol("space"), "S");
  assert.ok(!seen.has("A") && !seen.has("S"), "A / S belong to warn / space");
  for (const s of Object.values(M.GLOBAL_SYMBOLS)) assert.ok(M.isValidSymbol(s) && s !== "A" && s !== "S");
  const want = { "Spawns/1.png": "1", "Spawns/2.png": "2", "Spawns/3.png": "3", "Spawns/4.png": "4", "Spawns/5.png": "5", "Spawns/6.png": "6", "Spawns/7.png": "7", "Spawns/9.png": "9",
    "Objectives/goalBlue.png": "b", "Objectives/goalRed.png": "r", "Special Tiles/Unbreakable.png": "u", "Special Tiles/HealPad.png": "y", "Special Tiles/SlowTile.png": "z",
    "Special Tiles/SpeedTile.png": "w", "Special Tiles/Smoke.png": "x", "Special Tiles/Spikes.png": "v", "Teleporters/Blue.png": "c", "Teleporters/Green.png": "d",
    "Teleporters/Red.png": "e", "Teleporters/Yellow.png": "f" };
  for (const [f, sym] of Object.entries(want)) assert.strictEqual(M.globalSymbol("g:Resources/Global/" + f), sym, f);
  assert.strictEqual(M.globalSymbol("s:global|water"), "W");
  assert.strictEqual(M.globalSymbol("s:global|rails"), "Q");
  // variants inside a global sensor folder carry the folder's symbol; every manifest file resolves to some symbol
  assert.strictEqual(M.globalSymbolOfRef("g:Resources/Global/Water/00001011.png", manifest), "W");
  assert.strictEqual(M.globalSymbolOfRef("g:Resources/Global/Rails/Ver.png", manifest), "Q");
  for (const key of manifest.order) for (const f of manifest.folders[key]) assert.ok(M.globalSymbolOfRef("g:Resources/" + manifest.folderPaths[key] + f, manifest), key + "/" + f);
  assert.ok(M.tableSymbols().includes("Q") && M.tableSymbols().includes("A") && M.tableSymbols().includes("n"));
  assert.strictEqual(M.globalRefsForSymbol("8").length, 6); // Bounty Box Gem_Grab Heist Hot_Zone Brawl_Ball
  assert.deepStrictEqual(M.globalRefsForSymbol("c"), ["g:Resources/Global/Teleporters/Blue.png"]);
  // jumppad letters are 8 distinct letters, one per file
  const jp = Object.keys(M.GLOBAL_SYMBOLS).filter(r => r.includes("/Jumppads/")).map(r => M.GLOBAL_SYMBOLS[r]);
  assert.strictEqual(new Set(jp).size, 8);
  const jpWant = { R: "H", L: "G", B: "L", T: "K", BR: "P", TL: "Z", BL: "O", TR: "U" };
  for (const [f, sym] of Object.entries(jpWant)) assert.strictEqual(M.globalSymbol("g:Resources/Global/Jumppads/" + f + ".png"), sym, f);
});

test("import resolution: tileset + global candidates together, sorted by sortIndex; 1 silent, 2+ asks, 0 blank; 8 always asks", () => {
  const ts = M.indexBySymbol([{ ref: "d:wall", symbol: "M", sortIndex: 1 }, { ref: "s:7|Walls", symbol: "X", sortIndex: 6 }, { ref: "d:obj2", symbol: "8", sortIndex: 9 }, { ref: "d:obj1", symbol: "8", sortIndex: 3 },
    { ref: "d:nosym", symbol: null }, { ref: "d:bad", symbol: "/" }, { ref: "d:p1", symbol: "p", sortIndex: 5 }, { ref: "d:p0", symbol: "p", sortIndex: 2 }, { ref: "d:lake", symbol: "W", sortIndex: 4 }]);
  const gl = M.indexBySymbol(Object.keys(M.GLOBAL_SYMBOLS).map((ref, i) => ({ ref, symbol: M.GLOBAL_SYMBOLS[ref], sortIndex: 1e6 + i })));
  const r = M.resolveSymbols(["M", "X", "8", "W", "c", "A", "S", "~", "p"], ts, gl);
  const by = Object.fromEntries(r.map(x => [x.symbol, x]));
  assert.deepStrictEqual(by.M.candidates.map(c => c.ref), ["d:wall"]); assert.strictEqual(by.M.ask, false);
  assert.deepStrictEqual(by.X.candidates.map(c => c.ref), ["s:7|Walls"]); assert.strictEqual(by.X.ask, false);
  // 8: the tileset's objectives (by sortIndex) then the six global ones; always asks
  assert.deepStrictEqual(by["8"].candidates.map(c => c.ref), ["d:obj1", "d:obj2", ...M.globalRefsForSymbol("8")]);
  assert.ok(by["8"].ask && by["8"].objective && by["8"].candidates.some(c => c.ref.endsWith("Objectives/Box.png")), "powercube Box is listed");
  // W: the tileset's lake AND the global water folder -> a choice, tileset first by sortIndex
  assert.deepStrictEqual(by.W.candidates.map(c => c.ref), ["d:lake", "s:global|water"]); assert.ok(by.W.ask);
  // c: only the global teleporter -> silent
  assert.deepStrictEqual(by.c.candidates.map(c => c.ref), ["g:Resources/Global/Teleporters/Blue.png"]); assert.strictEqual(by.c.ask, false); assert.strictEqual(by.c.source, "global");
  // warn / space: fixed
  assert.deepStrictEqual([by.A.candidates[0].ref, by.A.ask, by.S.candidates[0].ref, by.S.ask], ["warn", false, "space", false]);
  // unknown: no candidate, no question
  assert.deepStrictEqual([by["~"].candidates.length, by["~"].ask, by["~"].source], [0, false, null]);
  // several plain tiles sharing one symbol (e.g. in one plain folder) are separate candidates, lowest sortIndex first
  assert.deepStrictEqual(by.p.candidates.map(c => c.ref), ["d:p0", "d:p1"]); assert.ok(by.p.ask);
  // 8 with no tileset objective: the six global ones
  const only = M.resolveSymbols(["8"], new Map(), gl)[0];
  assert.strictEqual(only.candidates.length, 6); assert.ok(only.ask);
  // 8 with nothing anywhere: nothing to ask
  assert.deepStrictEqual([M.resolveSymbols(["8"], new Map(), new Map())[0].ask, M.resolveSymbols(["8"], null, null)[0].candidates.length], [false, 0]);
  // a single objective candidate still asks
  assert.ok(M.resolveSymbols(["8"], M.indexBySymbol([{ ref: "d:o", symbol: "8" }]), new Map())[0].ask);
  // sensor folder + its variants: indexBySymbol is given FOLDER entries only, so one candidate
  assert.strictEqual(M.resolveSymbols(["X"], M.indexBySymbol([{ ref: "s:1|Walls", symbol: "X", sortIndex: 1 }]), gl)[0].candidates.length, 1);
  // gridToRefs: chosen symbols -> palette refs in first-use order; unresolved symbols blank and counted
  const sym = [["M", "W", null], ["~", "M", "8"]];
  const out = M.gridToRefs(sym, new Map([["M", "d:wall"], ["W", "s:global|water"], ["8", "d:obj2"], ["~", null]]));
  assert.deepStrictEqual(out.refs, ["d:wall", "s:global|water", "d:obj2"]);
  eqGrid(out.grid, [[0, 1, null], [null, 0, 2]]);
  assert.strictEqual(out.missing, 1);
});

test("a map with sensor cells imports with the same logical grid (cells hold the folder's s: entry, never a variant)", () => {
  // palette refs of a real map: a sensor folder (s:), a plain tile (d:), the warn tile, a global sensor folder and a global tile
  const refs = ["s:5|Walls", "d:crate", "warn", "s:global|water", "g:Resources/Global/Teleporters/Green.png"];
  const symbolOf = { "s:5|Walls": "M", "d:crate": "Y", s: null }; // tileset 5 symbols
  const symOf = ref => M.globalSymbol(ref) ?? symbolOf[ref] ?? null;
  const rand = rng(31);
  const w = 15, h = 11;
  const grid = blank(w, h).map(row => row.map(() => (rand() < 0.7 ? Math.floor(rand() * refs.length) : null)));
  symmetrise(grid, w, h, null, "v", x => x); // palette indexes here, no team tiles
  const { grid: sg, blanks } = M.symbolizeGrid(grid, refs, symOf);
  assert.deepStrictEqual(blanks, { upload: 0, noSymbol: 0, badSymbol: 0 });
  const e = M.encode({ w, h, grid: sg, tileset: 5 });
  const d = M.decode(e.seed);
  assert.ok(d.ok, d.error);
  // import: tileset 5 has the Walls folder and the crate, the rest comes from the global tileset
  const tsIdx = M.indexBySymbol([{ ref: "s:5|Walls", symbol: "M" }, { ref: "d:crate", symbol: "Y" }]);
  const glIdx = M.indexBySymbol(Object.keys(M.GLOBAL_SYMBOLS).map(ref => ({ ref, symbol: M.GLOBAL_SYMBOLS[ref] })));
  const chosen = new Map(M.resolveSymbols(d.palette, tsIdx, glIdx).map(x => [x.symbol, x.candidates.length === 1 ? x.candidates[0].ref : null]));
  const back = M.gridToRefs(d.grid, chosen);
  assert.strictEqual(back.missing, 0);
  // same logical grid: every cell points at the same ref as before
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const before = grid[r][c] == null ? null : refs[grid[r][c]];
    const after = back.grid[r][c] == null ? null : back.refs[back.grid[r][c]];
    assert.strictEqual(after, before, `cell ${r},${c}`);
  }
  assert.strictEqual(e.mirror === "v" || e.mirror === "4" || e.mirror === "d", true);
});

test("team-aware mirroring: spawns, respawns and goals swap with their partner on row-reflecting images (v, d, 4), not on h", () => {
  assert.deepStrictEqual(M.PARTNER_SYMBOLS, { 1: "2", 2: "1", 5: "6", 6: "5", b: "r", r: "b" });
  for (const s of ["3", "4", "7", "9", "M", "8"]) assert.strictEqual(M.partnerSymbol(s), s, s + " has no partner");
  assert.strictEqual(M.partnerRef("g:Resources/Global/Spawns/1.png"), "g:Resources/Global/Spawns/2.png");
  assert.strictEqual(M.partnerRef("g:Resources/Global/Spawns/6.png"), "g:Resources/Global/Spawns/5.png");
  assert.strictEqual(M.partnerRef("g:Resources/Global/Objectives/goalRed.png"), "g:Resources/Global/Objectives/goalBlue.png");
  assert.strictEqual(M.partnerRef("g:Resources/Global/Spawns/3.png"), "g:Resources/Global/Spawns/3.png");
  assert.strictEqual(M.partnerRef("g:Resources/Global/Spawns/4.png"), "g:Resources/Global/Spawns/4.png");
  const w = 7, h = 5;
  // a team pair [a, b] at the cell (1, 1) and its image under each class; a neutral tile "M" at the same places is the reference.
  const imageOf = { h: [1, 5], v: [3, 1], d: [3, 5] };
  for (const [a, b] of [["1", "2"], ["5", "6"], ["b", "r"], ["2", "1"], ["6", "5"]]) {
    for (const cls of ["h", "v", "d", "4"]) {
      const team = blank(w, h), neutral = blank(w, h);
      const put = (g, r, c, x) => { g[r][c] = x; };
      const spots = cls === "4" ? [[1, 1, false], [1, 5, false], [3, 1, true], [3, 5, true]] : [[1, 1, false], [...imageOf[cls], cls !== "h"]];
      for (const [r, c, swapped] of spots) { put(team, r, c, swapped ? b : a); put(neutral, r, c, "M"); }
      const eT = M.encode({ w, h, grid: team, tileset: 0 }), eN = M.encode({ w, h, grid: neutral, tileset: 0 });
      assert.strictEqual(eT.mirror, cls, `${a}/${b} ${cls}: same class as the neutral map`);
      assert.strictEqual(eN.mirror, cls);
      assert.strictEqual(eT.regionSize, eN.regionSize);
      const d = M.decode(eT.seed);
      assert.ok(d.ok, d.error);
      eqGrid(d.grid, team);
    }
  }
  // unswapped copies across rows are NOT symmetric any more: 1 above and 1 below is class h-or-a, never v
  const same = blank(w, h); same[1][1] = "1"; same[3][1] = "1";
  assert.notStrictEqual(M.encode({ w, h, grid: same, tileset: 0 }).mirror, "v");
  assert.notStrictEqual(M.encode({ w, h, grid: same, tileset: 0 }).mirror, "4");
  // left-right pairs keep the team
  const lr = blank(w, h); lr[1][1] = "1"; lr[1][5] = "1";
  assert.strictEqual(M.encode({ w, h, grid: lr, tileset: 0 }).mirror, "h");
  const lrBad = blank(w, h); lrBad[1][1] = "1"; lrBad[1][5] = "2";
  assert.strictEqual(M.encode({ w, h, grid: lrBad, tileset: 0 }).mirror, "a");
  // a partner missing from the palette cannot be symmetric: 1 alone with a lone cell elsewhere
  const lone = blank(w, h); lone[1][1] = "1";
  assert.strictEqual(M.encode({ w, h, grid: lone, tileset: 0 }).mirror, "a");
  // decode of a hand-made v seed: the palette holds only "1" but the lower half holds its partner "2" (usedSymbols lists both)
  const dec = M.decode(M.encode({ w, h, grid: Object.assign(blank(w, h), { 1: [null, "1", null, null, null, null, null], 3: [null, "2", null, null, null, null, null] }), tileset: 0 }).seed);
  assert.deepStrictEqual(dec.usedSymbols.sort(), ["1", "2"]);
  // an off-centre magnet: images that fall outside the grid are unconstrained, the swap still applies to those inside
  const mag = { col: 3, row: 1, size: 1 };
  const m = blank(w, h); m[0][2] = "1"; m[2][2] = "2";
  assert.strictEqual(M.encode({ w, h, grid: m, magnet: mag, tileset: 0 }).mirror, "v");
  roundTrip(w, h, m, mag);
});

test("pair table: blue spawns/respawns/goals at the bottom and red at the top under diagonal mirroring record only one side and decode identically", () => {
  assert.deepStrictEqual(M.SWAP_REF_PAIRS.map(p => p.map(r => M.GLOBAL_SYMBOLS[r])), [["1", "2"], ["5", "6"], ["b", "r"]]);
  const w = 7, h = 5;
  for (const [blue, red] of [["1", "2"], ["5", "6"], ["b", "r"]]) {
    const g = blank(w, h);
    g[3][1] = blue; g[1][5] = red;            // (r, c) <-> (4-r, 6-c): the 180-degree image, rows reflect so the team swaps
    g[0][0] = "M"; g[4][6] = "M";
    const e = M.encode({ w, h, grid: g, tileset: 0 });
    assert.strictEqual(e.mirror, "d", blue + "/" + red);
    assert.ok(e.regionSize < w * h, "only one side is recorded");
    assert.strictEqual(e.palette.includes(red) && e.palette.includes(blue), true, "palette lists the symbols that are in the region/map");
    eqGrid(M.decode(e.seed).grid, g);
    // all four mirrors with both teams
    const g4 = blank(w, h);
    g4[3][1] = blue; g4[3][5] = blue; g4[1][1] = red; g4[1][5] = red;
    const e4 = M.encode({ w, h, grid: g4, tileset: 0 });
    assert.strictEqual(e4.mirror, "4");
    eqGrid(M.decode(e4.seed).grid, g4);
  }
  // the old respawn pair (3 <-> 4) is gone: 3 and 4 stay put on every image
  for (const s of ["3", "4"]) assert.strictEqual(M.mirrorSymbol(s, { x: false, y: true }), s);
});

// ── Tie-pick selectors ("S.x" palette entries) ──────────────────────────────────────────────────────────
test("selector grammar: entry := SYMBOL [ '.' SEL ], SEL = one of 0-9a-zA-Z, 1-based ('1'..'9','a'..'z','A'..'Z'); '0' is never a valid pick", () => {
  assert.strictEqual(M.selectorChar(1), "1"); assert.strictEqual(M.selectorChar(9), "9"); assert.strictEqual(M.selectorChar(10), "a");
  assert.strictEqual(M.selectorChar(35), "z"); assert.strictEqual(M.selectorChar(36), "A"); assert.strictEqual(M.selectorChar(61), "Z");
  assert.strictEqual(M.selectorChar(0), null); assert.strictEqual(M.selectorChar(62), null);
  assert.deepStrictEqual(["1", "9", "a", "z", "A", "Z", "0", "x1", "", "."].map(M.selectorIndex), [1, 9, 10, 35, 36, 61, null, null, null, null]);
  assert.deepStrictEqual(M.parseEntry("M"), { symbol: "M", selector: null });
  assert.deepStrictEqual(M.parseEntry("😀.b"), { symbol: "😀", selector: "b" });
  for (const bad of ["", "M.", "M.ab", ".2", "M,2", "M.?", "..1", "?.1", "M.1x"]) assert.strictEqual(M.parseEntry(bad), null, bad);
  assert.deepStrictEqual(M.parsePalette("M.1XY.aW").entries, ["M.1", "X", "Y.a", "W"]);
  assert.deepStrictEqual(M.parsePalette("").entries, []);
  for (const bad of [".", "M.", "M.?", "M.1.2", "X.", "M..", "A.1.", "MM", "M.1M.1"]) assert.ok(M.parsePalette(bad).error, bad);
  assert.deepStrictEqual(M.parsePalette("MX").entries, ["M", "X"], "adjacent symbols are two entries; a repeated one is a duplicate");
  assert.deepStrictEqual(M.parsePalette("M.1M.2").entries, ["M.1", "M.2"], "same symbol, different selectors, is fine");
});

test("selectorFor: only when the symbol had MORE THAN ONE candidate; position in the chooser order; out of reach beyond 61", () => {
  const c = n => Array.from({ length: n }, (_, i) => ({ ref: "r" + i }));
  assert.strictEqual(M.selectorFor(c(1), "r0"), null); assert.strictEqual(M.selectorFor([], "r0"), null);
  assert.strictEqual(M.selectorFor(c(2), "r0"), "1"); assert.strictEqual(M.selectorFor(c(2), "r1"), "2");
  assert.strictEqual(M.selectorFor(c(70), "r9"), "a"); assert.strictEqual(M.selectorFor(c(70), "r60"), "Z"); assert.strictEqual(M.selectorFor(c(70), "r61"), null);
  assert.strictEqual(M.selectorFor(c(3), "unknown"), null);
});

test("seeds with selectors: round trip, palette order frequency > symbol > selector, same symbol twice with different selectors", () => {
  const g = blank(5, 3);
  g[0][0] = "M.2"; g[0][1] = "M.2"; g[0][2] = "M.1"; g[0][3] = "X"; g[1][0] = "X"; g[1][1] = "W.a"; g[2][4] = "M.1"; g[2][3] = "W.a";
  const e = M.encode({ w: 5, h: 3, grid: g, tileset: 3 });
  // counts: M.2 x2, M.1 x2, X x2, W.a x2 -> all tied: symbol (M < W < X by code point), then selector (1 < 2)
  assert.deepStrictEqual(e.palette, ["M.1", "M.2", "W.a", "X"]);
  assert.strictEqual(e.fields.palette, "M.1M.2W.aX");
  const d = M.decode(e.seed);
  assert.ok(d.ok, d.error); eqGrid(d.grid, g);
  assert.deepStrictEqual(d.palette, e.palette);
  assert.deepStrictEqual([...d.usedSymbols].sort(), ["M.1", "M.2", "W.a", "X"]);
  // frequency first
  const h = blank(4, 1); h[0] = ["Z.1", "A.2", "A.2", "B"];
  assert.deepStrictEqual(M.encode({ w: 4, h: 1, grid: h, tileset: 0 }).palette, ["A.2", "B", "Z.1"]);
  // selector never costs anything when absent: a seed without selectors is byte-identical to the old form
  const plain = blank(5, 3); plain[0][0] = "M"; plain[1][1] = "X";
  const ep = M.encode({ w: 5, h: 3, grid: plain, tileset: 0 });
  assert.strictEqual(ep.fields.palette, "MX");
  assert.throws(() => M.encode({ w: 1, h: 1, grid: [["M."]], tileset: 0 }));
  assert.throws(() => M.encode({ w: 1, h: 1, grid: [["M.0.1"]], tileset: 0 }));
});

test("old seeds (no selectors) decode unchanged; malformed palettes are rejected with the palette field", () => {
  const g = randomGrid(9, 7, rng(77), 5); roundTrip(9, 7, g, null);
  const e = M.encode({ w: 9, h: 7, grid: g, tileset: 0 });
  const old = M.decode(e.seed); assert.ok(old.ok); assert.ok(old.palette.every(k => k.length === Array.from(k).length));
  const parts = e.seed.split(",");
  for (const bad of ["M.", ".M", "M..1", "M.?", "M.1.", "MM", "M.é"]) {
    const d = M.decode([...parts.slice(0, 4), bad, parts[5]].join(","));
    assert.strictEqual(d.ok, false, bad); assert.strictEqual(d.errorField, "palette", bad);
  }
  // a selector character that is valid syntax but names no candidate ("0") still decodes; resolution decides
  assert.ok(M.decode("1x1,x,a,0,M.0,A").ok === true || M.decode("1x1,x,a,0,M.0,A").errorField === "code");
});

test("import resolution with selectors: a selector that resolves picks silently; missing, '0' or out of range asks; only unselected entries prompt", () => {
  const ts = M.indexBySymbol([{ ref: "d:m1", symbol: "M", sortIndex: 2 }, { ref: "d:m0", symbol: "M", sortIndex: 1 }, { ref: "s:7|Water", symbol: "W", sortIndex: 5 }, { ref: "d:o1", symbol: "8", sortIndex: 3 }]);
  const gl = M.indexBySymbol(Object.keys(M.GLOBAL_SYMBOLS).map((ref, i) => ({ ref, symbol: M.GLOBAL_SYMBOLS[ref], sortIndex: 1e6 + i })));
  const r = M.resolveSymbols(["M.2", "M", "M.9", "M.0", "W.2", "W.1", "8.3", "8", "X", "c.1", "A"], ts, gl);
  const by = Object.fromEntries(r.map(x => [x.key, x]));
  assert.deepStrictEqual(by["M.2"].pick && by["M.2"].pick.ref, "d:m1"); assert.strictEqual(by["M.2"].ask, false);   // order: m0 (sortIndex 1), m1 (2)
  assert.strictEqual(by["M"].ask, true); assert.strictEqual(by["M"].pick, null);
  assert.deepStrictEqual([by["M.9"].ask, by["M.9"].badSelector, by["M.0"].ask, by["M.0"].badSelector], [true, true, true, true]);
  assert.deepStrictEqual([by["W.2"].pick.ref, by["W.2"].ask], ["s:global|water", false]);      // tileset folder first, then the global folder
  assert.deepStrictEqual([by["W.1"].pick.ref], ["s:7|Water"]);                                  // a sensor folder counts as ONE candidate
  assert.strictEqual(by["8.3"].ask, false); assert.strictEqual(by["8.3"].pick.ref, M.globalRefsForSymbol("8")[1]); // objective + resolving selector: silent
  assert.strictEqual(by["8"].ask, true);
  assert.deepStrictEqual([by["X"].candidates.length, by["X"].ask], [0, false]);
  assert.strictEqual(by["c.1"].pick.ref, "g:Resources/Global/Teleporters/Blue.png"); // a selector on a single candidate still resolves
  assert.strictEqual(by["A"].ask, false);
  assert.deepStrictEqual(r.filter(x => x.ask).map(x => x.key), ["M", "M.9", "M.0", "8"], "only the unselected entries are asked");
  // gridToRefs works on entry keys
  const out = M.gridToRefs([["M.1", "M.2", "M.1"]], new Map([["M.1", "d:m0"], ["M.2", "d:m1"]]));
  assert.deepStrictEqual(out.refs, ["d:m0", "d:m1"]); eqGrid(out.grid, [[0, 1, 0]]);
});

test("symbolizeGrid writes a selector only when selectorOf says so, and mirror partners keep their own selector", () => {
  const refs = ["d:a", "d:b", "g:Resources/Global/Spawns/1.png"];
  const sym = { "d:a": "M", "d:b": "M", "g:Resources/Global/Spawns/1.png": "1" };
  const sel = (ref, s) => (s === "M" ? (ref === "d:a" ? "1" : "2") : null);
  const out = M.symbolizeGrid([[0, 1, 2]], refs, r => sym[r], sel);
  eqGrid(out.grid, [["M.1", "M.2", "1"]]);
  const w = 7, h = 5, g = blank(w, h);
  g[1][1] = "1.1"; g[3][1] = "2.1"; g[1][5] = "1.1"; g[3][5] = "2.1"; // swapped partner keeps the selector when the palette has it
  const e = M.encode({ w, h, grid: g, tileset: 0 });
  assert.strictEqual(e.mirror, "4"); eqGrid(M.decode(e.seed).grid, g);
  const g2 = blank(w, h); g2[1][1] = "1.1"; g2[3][1] = "2.2"; // the partner has another selector than its source: still symmetric via the single entry
  const e2 = M.encode({ w, h, grid: g2, tileset: 0 });
  eqGrid(M.decode(e2.seed).grid, g2);
});

// ── Symbol autofill / backfill ──────────────────────────────────────────────────────────────────────────
test("symbolFromName: case-insensitive contains rules in order (5v5+fence n, fence N, rope a, water W, wall1 M, wall2 X, crate Y, barrel C, bush F, cactus T, skull B, objectives 8)", () => {
  const want = { Fence5v5: "n", "5V5_FENCE_Top": "n", Fence: "N", fence_h: "N", RopeV: "a", rope: "a", Water: "W", DeepWaterFill: "W", Wall1: "M", "MyWall1_x": "M", Wall2: "X", Crate: "Y", WoodenCRATE: "Y",
    Barrel: "C", Bush: "F", Cactus: "T", Skull: "B", BrawlBall: "8", GemMine: "8", HeistSafe: "8", MyBrawlBallGoal: "8", heistsafe2: "8" };
  for (const [n, sym] of Object.entries(want)) assert.strictEqual(M.symbolFromName(n), sym, n);
  for (const n of ["Spotlight", "Jumppad", "TopJumppad", "Unknown", "", null, undefined, "Wall3"]) assert.strictEqual(M.symbolFromName(n), null, String(n));
  // order: "fence" with 5v5 is n, a water fence is N (fence beats water), a rope fence N
  assert.strictEqual(M.symbolFromName("WaterFence"), "N"); assert.strictEqual(M.symbolFromName("RopeFence"), "N");
  assert.strictEqual(M.symbolFromName("WaterWall1"), "W", "water is tested before wall1");
  // every produced symbol is a legal one and agrees with the official table
  for (const sym of new Set(M.NAME_SYMBOL_RULES.map(r => r[1]))) assert.ok(M.isValidSymbol(sym));
});

test("autoSymbol: only an empty, untouched symbol field takes the autofill; a typed symbol is never overwritten", () => {
  assert.strictEqual(M.autoSymbol("Wall1", "", false), "M"); assert.strictEqual(M.autoSymbol("Wall1", null, false), "M");
  assert.strictEqual(M.autoSymbol("Wall1", "Q", false), null, "typed/saved symbol stays");
  assert.strictEqual(M.autoSymbol("Wall1", "", true), null, "touched (the user cleared it on purpose)");
  assert.strictEqual(M.autoSymbol("Spotlight", "", false), null);
});

test("planBackfill: fills only empty symbols, sensor folders as one unit by folder name, undecided listed, nothing overwritten", () => {
  const r = (id, ts, codename, extra = {}) => ({ id, tileset_id: ts, codename, folder_key: null, sensor_code: null, symbol: null, sort_index: 0, ...extra });
  const rows = [
    r("1", "A", "Wall1"), r("2", "A", "Crate", { symbol: "Z" }), r("3", "A", "Spotlight"), r("4", "A", "Fence_h", { folder_key: "Fence", sensor_code: "00011000" }),
    r("5", "A", "Fence_v", { folder_key: "Fence", sensor_code: "01000010" }), r("6", "A", "Lake_0", { folder_key: "Lake", sensor_code: "00000000", symbol: "L" }),
    r("7", "A", "Lake_1", { folder_key: "Lake", sensor_code: "11111111" }), r("8", "B", "Wall1"), r("9", "B", "Misc_1", { folder_key: "Misc" }), r("10", "A", "Mystery", { folder_key: "Odd", sensor_code: "00000000" }),
  ];
  const p = M.planBackfill(rows);
  assert.deepStrictEqual(p.set.map(u => [u.tilesetId, u.folder, u.ids, u.symbol]), [["A", null, ["1"], "M"], ["A", "Fence", ["4", "5"], "N"], ["B", null, ["8"], "M"]]);
  assert.deepStrictEqual(p.undecided.map(u => [u.tilesetId, u.folder, u.ids]), [["A", "Odd", ["10"]], ["A", null, ["3"]], ["B", "Misc", ["9"]]]);
  assert.strictEqual(p.kept, 2, "Crate (has a symbol) and the Lake group (one row has L: left alone, never overwritten)");
  assert.deepStrictEqual(M.planBackfill([]), { set: [], undecided: [], kept: 0 });
  assert.deepStrictEqual(M.planBackfill(rows.map(x => ({ ...x, symbol: "Q" }))).set, []);
});

// ── Jumppad pairing (mirror transform shared by the app and seeds) ──────────────────────────────────────
const JP = f => M.jumppadRef(f);
const PAIRS = { x: { R: "L", L: "R", TR: "TL", TL: "TR", BR: "BL", BL: "BR", T: "T", B: "B" }, y: { T: "B", B: "T", TL: "BL", BL: "TL", TR: "BR", BR: "TR", R: "R", L: "L" } };
const FLAG = { V: { fV: true, fH: false, fD: false }, H: { fV: false, fH: true, fD: false }, D: { fV: false, fH: false, fD: true } };

test("jumppad pairing table: fV R<->L TR<->TL BR<->BL; fH T<->B TL<->BL TR<->BR; fD both (R<->L T<->B TL<->BR TR<->BL)", () => {
  const table = { V: { R: "L", L: "R", TR: "TL", TL: "TR", BR: "BL", BL: "BR", T: "T", B: "B" },
    H: { T: "B", B: "T", TL: "BL", BL: "TL", TR: "BR", BR: "TR", R: "R", L: "L" },
    D: { R: "L", L: "R", T: "B", B: "T", TL: "BR", BR: "TL", TR: "BL", BL: "TR" } };
  for (const [flag, map] of Object.entries(table)) for (const f of M.JUMPPAD_FILES) assert.strictEqual(M.mirrorRef(JP(f), FLAG[flag]), JP(map[f]), `${flag} ${f}`);
  assert.deepStrictEqual([...M.JUMPPAD_FILES].sort(), ["B", "BL", "BR", "L", "R", "T", "TL", "TR"]);
  // no flag: unchanged. Combined flags COMPOSE: V + H = D, V + D = H, H + D = V, V + H + D = identity-by-axes (x = fV xor fD, y = fH xor fD)
  for (const f of M.JUMPPAD_FILES) {
    assert.strictEqual(M.mirrorRef(JP(f), {}), JP(f));
    assert.strictEqual(M.mirrorRef(JP(f), { fV: true, fH: true }), M.mirrorRef(JP(f), FLAG.D), "V+H = D");
    assert.strictEqual(M.mirrorRef(JP(f), { fV: true, fD: true }), M.mirrorRef(JP(f), FLAG.H), "V+D = H");
    assert.strictEqual(M.mirrorRef(JP(f), { fH: true, fD: true }), M.mirrorRef(JP(f), FLAG.V), "H+D = V");
    assert.strictEqual(M.mirrorRef(JP(f), { fV: true, fH: true, fD: true }), JP(f), "V+H+D");
    // mirroring twice with the same flag returns the original (an involution)
    for (const flag of ["V", "H", "D"]) assert.strictEqual(M.mirrorRef(M.mirrorRef(JP(f), FLAG[flag]), FLAG[flag]), JP(f));
  }
  assert.deepStrictEqual(M.flipAxes({ fV: true }), { x: true, y: false });
  assert.deepStrictEqual(M.flipAxes({ fD: true }), { x: true, y: true });
  assert.deepStrictEqual(M.flipAxes(null), { x: false, y: false });
});

test("mirrorRef: team swap only when rows reflect (and only when enabled); other tiles and non-global jumppad-like refs are copied as they are", () => {
  const sp1 = "g:Resources/Global/Spawns/1.png", sp2 = "g:Resources/Global/Spawns/2.png", sp3 = "g:Resources/Global/Spawns/3.png", sp5 = "g:Resources/Global/Spawns/5.png", sp6 = "g:Resources/Global/Spawns/6.png";
  assert.strictEqual(M.mirrorRef(sp1, FLAG.V), sp1, "left-right keeps the team");
  assert.strictEqual(M.mirrorRef(sp1, FLAG.H), sp2); assert.strictEqual(M.mirrorRef(sp1, FLAG.D), sp2);
  assert.strictEqual(M.mirrorRef(sp1, FLAG.H, { teamSwap: false }), sp1, "Mirror Spawns off");
  assert.strictEqual(M.mirrorRef(sp3, FLAG.D), sp3, "spawn 3 (Solo) has no partner");
  assert.strictEqual(M.mirrorRef(sp5, FLAG.H), sp6); assert.strictEqual(M.mirrorRef(sp5, FLAG.V), sp5);
  assert.strictEqual(M.mirrorRef("g:Resources/Global/Objectives/goalRed.png", FLAG.H), "g:Resources/Global/Objectives/goalBlue.png");
  // jumppads are NOT gated by the team switch
  assert.strictEqual(M.mirrorRef(JP("R"), FLAG.V, { teamSwap: false }), JP("L"));
  for (const ref of ["d:abc", "u:3", "s:global|water", "space", "warn", "g:Resources/Global/Teleporters/Blue.png", "g:Resources/Global/Jumppads/X.png", "g:Resources/Other/Jumppads/R.png", "d:Jumppads/R.png"]) {
    for (const flag of ["V", "H", "D"]) assert.strictEqual(M.mirrorRef(ref, FLAG[flag]), ref, ref);
  }
  assert.strictEqual(M.jumppadFileOf(JP("TL")), "TL"); assert.strictEqual(M.jumppadFileOf("g:Resources/Global/Jumppads/Q.png"), null);
});

test("mirrorSymbol: seed symbols follow the same table (jumppad letters, team digits)", () => {
  const sym = f => M.GLOBAL_SYMBOLS[JP(f)];
  for (const [flag, axes] of [["V", { x: true, y: false }], ["H", { x: false, y: true }], ["D", { x: true, y: true }]]) for (const f of M.JUMPPAD_FILES) {
    assert.strictEqual(M.mirrorSymbol(sym(f), axes), sym(M.mirrorRef(JP(f), FLAG[flag]).match(/Jumppads\/(\w+)\.png/)[1]), `${flag} ${f}`);
  }
  assert.strictEqual(M.mirrorSymbol("1", { x: false, y: true }), "2"); assert.strictEqual(M.mirrorSymbol("1", { x: true, y: false }), "1");
  assert.strictEqual(M.mirrorSymbol("M", { x: true, y: true }), "M"); assert.strictEqual(M.mirrorSymbol(null, { x: true, y: true }), null);
  assert.strictEqual(M.mirrorSymbol("H", { x: true, y: false }), "G", "R (H) <-> L (G)");
});

test("mirror offsets: negated on the reflecting axes using the IMAGE tile's own offset; none for the source cell or when mirror_offset is off", () => {
  const info = { mirrorOffset: true, base: { ox: 50, oy: 66 } };
  assert.deepStrictEqual(M.mirrorOffsetOverride(info, FLAG.V), { ox: -50, oy: 66 });
  assert.deepStrictEqual(M.mirrorOffsetOverride(info, FLAG.H), { ox: 50, oy: -66 });
  assert.deepStrictEqual(M.mirrorOffsetOverride(info, FLAG.D), { ox: -50, oy: -66 });
  assert.deepStrictEqual(M.mirrorOffsetOverride(info, { fV: true, fD: true }), { ox: 50, oy: -66 }, "composed: V + D = H");
  assert.strictEqual(M.mirrorOffsetOverride(info, {}), undefined);
  assert.strictEqual(M.mirrorOffsetOverride({ mirrorOffset: false, base: { ox: 5, oy: 5 } }, FLAG.D), undefined);
  assert.strictEqual(M.mirrorOffsetOverride(null, FLAG.D), undefined);
  assert.ok(Object.is(M.mirrorOffsetOverride({ mirrorOffset: true, base: { ox: 0, oy: 4 } }, FLAG.V).ox, 0), "no -0");
  // planMirrorCopies: the offset belongs to the tile the image holds (a swapped jumppad uses ITS offset, negated)
  const offsets = { [JP("T")]: { mirrorOffset: true, base: { ox: 50, oy: 66 } }, [JP("B")]: { mirrorOffset: true, base: { ox: 10, oy: 20 } }, "d:wall": { mirrorOffset: false, base: { ox: 3, oy: 3 } } };
  const meta = [{ pos: [1, 1], fV: false, fH: false, fD: false }, { pos: [1, 5], fV: true, fH: false, fD: false }, { pos: [5, 1], fV: false, fH: true, fD: false }, { pos: [5, 5], fV: false, fH: false, fD: true }];
  const plan = M.planMirrorCopies(meta, JP("T"), { offsetInfoOf: ref => offsets[ref] || null });
  assert.deepStrictEqual(plan.map(p => [p.pos.join(","), p.ref.match(/(\w+)\.png/)[1], p.override]), [
    ["1,1", "T", undefined], ["1,5", "T", { ox: -50, oy: 66 }], ["5,1", "B", { ox: 10, oy: -20 }], ["5,5", "B", { ox: -10, oy: -20 }]]);
  assert.deepStrictEqual(M.planMirrorCopies(meta, "d:wall", { offsetInfoOf: ref => offsets[ref] || null }).map(p => [p.ref, p.override]), [["d:wall", undefined], ["d:wall", undefined], ["d:wall", undefined], ["d:wall", undefined]]);
});

test("seeds: every jumppad keeps its symmetry class in h, v, d and 4, like a neutral tile, and decodes to the mirrored jumppads", () => {
  const w = 9, h = 7;
  const sym = f => M.GLOBAL_SYMBOLS[JP(f)];
  for (const f of M.JUMPPAD_FILES) for (const cls of ["h", "v", "d", "4"]) {
    const g = blank(w, h), neutral = blank(w, h);
    const put = (r, c, x) => { g[r][c] = x; neutral[r][c] = "M"; };
    const sums = M.effectiveSums(w, h, null);
    put(1, 2, sym(f));
    for (const im of M.orbitOf(1, 2, cls, w, h, sums)) { g[im.r][im.c] = M.mirrorSymbol(sym(f), { x: im.fx, y: im.fy }); neutral[im.r][im.c] = "M"; }
    const eJ = M.encode({ w, h, grid: g, tileset: 0 }), eN = M.encode({ w, h, grid: neutral, tileset: 0 });
    assert.strictEqual(eJ.mirror, cls, `${f} ${cls}`); assert.strictEqual(eN.mirror, cls);
    assert.strictEqual(eJ.regionSize, eN.regionSize);
    const d = M.decode(eJ.seed); assert.ok(d.ok, d.error); eqGrid(d.grid, g);
    // the SAME orientation copied on every image (a plain copy) is no longer symmetric when the jumppad has a mirror
    if (M.mirrorSymbol(sym(f), { x: true, y: true }) !== sym(f) || M.mirrorSymbol(sym(f), { x: true, y: false }) !== sym(f) || M.mirrorSymbol(sym(f), { x: false, y: true }) !== sym(f)) {
      const copy = blank(w, h); copy[1][2] = sym(f);
      for (const im of M.orbitOf(1, 2, cls, w, h, sums)) copy[im.r][im.c] = sym(f);
      const wantsChange = M.orbitOf(1, 2, cls, w, h, sums).some(im => M.mirrorSymbol(sym(f), { x: im.fx, y: im.fy }) !== sym(f));
      if (wantsChange) assert.notStrictEqual(M.encode({ w, h, grid: copy, tileset: 0 }).mirror, cls, `plain copies of ${f} are not ${cls}`);
    }
  }
  // a map mixing team tiles and jumppads on a centred 4-way map
  const mix = blank(w, h); const sums = M.effectiveSums(w, h, null);
  for (const [r, c, s] of [[0, 1, "1"], [2, 3, sym("TR")], [1, 0, "3"], [3, 2, sym("R")], [0, 4, "b"]]) { mix[r][c] = s; for (const im of M.orbitOf(r, c, "4", w, h, sums)) mix[im.r][im.c] = M.mirrorSymbol(s, { x: im.fx, y: im.fy }); }
  const em = M.encode({ w, h, grid: mix, tileset: 0 }); assert.strictEqual(em.mirror, "4"); eqGrid(M.decode(em.seed).grid, mix);
});

test("random team maps round trip in every class (swap on decode equals swap on encode)", () => {
  const rand = rng(99);
  for (const [w, h] of [[21, 33], [10, 9], [7, 5], [9, 10]]) for (const cls of ["h", "v", "d", "4"]) {
    const g = symmetrise(randomGrid(w, h, rand, 16, 0.5), w, h, null, cls);
    const e = roundTrip(w, h, g, null);
    assert.ok(e.regionSize <= M.regionCells(w, h, M.effectiveSums(w, h, null), cls).length);
  }
});

test("symbol registry: official + global + tilesets; conflicts ignore siblings and same-named tiles; free list", () => {
  const ts = [
    { symbol: "K", codename: "Mine", source: "tileset", tilesetName: "Desert", ref: "d:1", folderKey: null },
    { symbol: "K", codename: "Doors_00000000", source: "tileset", tilesetName: "Desert", ref: "d:2", folderKey: "Doors" },
    { symbol: "K", codename: "Doors_11111111", source: "tileset", tilesetName: "Desert", ref: "d:3", folderKey: "Doors" },
    { symbol: "M", codename: "Wall1", source: "tileset", tilesetName: "Desert", ref: "d:4", folderKey: null },
    { symbol: "W", codename: "Water", source: "tileset", tilesetName: "Desert", ref: "s:7|Water", folderKey: "Water" },
  ];
  const reg = M.buildRegistry(M.officialEntries().concat(M.globalEntries(), ts));
  // a tile typing K that is not the one holding it: taken by the global jumppad and the tileset tiles
  const names = M.symbolConflicts(reg, "K", { ref: "d:9", codename: "New", source: "tileset", tilesetName: "Desert" }).map(e => e.codename);
  assert.ok(names.includes("Jumppad T") && names.includes("Mine") && names.includes("Doors_00000000"));
  // a sibling of the Doors folder does not see its own folder, only the others
  const sib = M.symbolConflicts(reg, "K", { ref: "d:3", codename: "Doors_11111111", folderKey: "Doors", source: "tileset", tilesetName: "Desert" }).map(e => e.codename);
  assert.ok(!sib.includes("Doors_00000000") && !sib.includes("Doors_11111111") && sib.includes("Mine"));
  // the standard symbols are not conflicts for the tile that carries them: Wall1 M, Water W
  assert.deepStrictEqual(M.symbolConflicts(reg, "M", { ref: "d:4", codename: "Wall1", source: "tileset", tilesetName: "Desert" }), []);
  assert.deepStrictEqual(M.symbolConflicts(reg, "W", { ref: "s:7|Water", codename: "Water", folderKey: "Water", source: "tileset", tilesetName: "Desert" }), []);
  // objectives deliberately share 8
  assert.deepStrictEqual(M.symbolConflicts(reg, "8", { ref: "d:x", codename: "Anything" }), []);
  // A / S are the warn / space tiles
  assert.deepStrictEqual(M.symbolConflicts(reg, "A", { ref: "d:y", codename: "Other" }).map(e => e.codename), ["Warn tile"]);
  // free list: no table symbol, no "/", no space; includes the unused letters
  const free = M.freeSymbols(reg);
  for (const ch of "1234567 9MXYCFTBNnWaQAS/bruyzwxvcdefHGLKPZOU8".split("")) assert.ok(!free.includes(ch), ch);
  assert.ok(free.includes("0") && free.includes("D") && free.includes("g") && free.includes("~"));
  // official table: Rope a, Fence N, 5v5 Fence n
  assert.strictEqual(M.OFFICIAL_SYMBOL_NAMES.a, "Rope"); assert.strictEqual(M.OFFICIAL_SYMBOL_NAMES.N, "Fence"); assert.strictEqual(M.OFFICIAL_SYMBOL_NAMES.n, "Fence 5v5");
});

test("proposeSymbols: standard rules, groups, objectives, free letters; SQL escapes", () => {
  const tilesets = [{ id: "t1", name: "Desert" }, { id: "t2", name: "O'Neil" }];
  const rows = [
    { id: "1", tileset_id: "t1", codename: "Wall1", folder_key: null, sensor_code: null, symbol: null, sort_index: 1 },
    { id: "2", tileset_id: "t1", codename: "Crate", folder_key: null, sensor_code: null, symbol: "Y", sort_index: 2 },
    { id: "3", tileset_id: "t1", codename: "Water_00000000", folder_key: "Water", sensor_code: "00000000", symbol: null, sort_index: 3 },
    { id: "4", tileset_id: "t1", codename: "Water_11111111", folder_key: "Water", sensor_code: "11111111", symbol: null, sort_index: 4 },
    { id: "5", tileset_id: "t1", codename: "Rope_00011000", folder_key: "Rope", sensor_code: "00011000", symbol: null, sort_index: 5 },
    { id: "6", tileset_id: "t1", codename: "Gem_Grab", folder_key: null, sensor_code: null, symbol: null, sort_index: 6 },
    { id: "7", tileset_id: "t1", codename: "Pillar", folder_key: null, sensor_code: null, symbol: null, sort_index: 7 },
    { id: "8", tileset_id: "t1", codename: "Pillar2", folder_key: null, sensor_code: null, symbol: null, sort_index: 8 },
    { id: "9", tileset_id: "t1", codename: "Fence_00000000", folder_key: "Fence", sensor_code: "00000000", symbol: "N", sort_index: 9 },
    { id: "10", tileset_id: "t1", codename: "Fence5v5_x", folder_key: "Fence5v5", sensor_code: "00011000", symbol: null, sort_index: 10 },
    { id: "11", tileset_id: "t2", codename: "Shiny", folder_key: null, sensor_code: null, symbol: null, sort_index: 1 },
  ];
  const p = M.proposeSymbols(rows, tilesets);
  const at = codename => p.find(x => x.codenames.includes(codename));
  assert.strictEqual(at("Wall1").symbol, "M");
  assert.strictEqual(at("Water_00000000").symbol, "W");
  assert.deepStrictEqual(at("Water_00000000").ids, ["3", "4"]);
  assert.strictEqual(at("Rope_00011000").symbol, "a");
  assert.strictEqual(at("Gem_Grab").symbol, "8");
  assert.strictEqual(at("Fence5v5_x").symbol, "n");
  assert.ok(!at("Crate") && !at("Fence_00000000"), "tiles that already have a symbol are not listed");
  assert.deepStrictEqual([at("Pillar").symbol, at("Pillar2").symbol], ["D", "E"]); // first free letters, none taken by the tables
  assert.strictEqual(at("Shiny").symbol, "D"); // free letters restart per tileset
  const sql = M.proposalSql(p);
  assert.ok(/UPDATE tiles SET symbol = 'W' WHERE symbol IS NULL AND id IN \('3', '4'\);/.test(sql));
  assert.ok(sql.includes("O'Neil"), "comments keep the name; values are quoted");
});

test("compactness report", () => {
  const rand = rng(2024);
  const rows = [];
  const add = (label, w, h, grid, magnet) => { const e = M.encode({ w, h, grid, magnet: magnet || null, tileset: 0 }); rows.push([label, e.seed.length, e.mirror, e.fields.code.length, e.seed]); roundTrip(w, h, grid, magnet || null); };
  add("empty 21x33", 21, 33, blank(21, 33));
  // 3v3 with 3 tile types and 4-way symmetry
  const g3 = blank(21, 33);
  for (let r = 0; r < 33; r++) for (let c = 0; c < 21; c++) { const x = rand(); if (x < 0.18) g3[r][c] = "M"; else if (x < 0.26) g3[r][c] = "Y"; else if (x < 0.30) g3[r][c] = "W"; }
  symmetrise(g3, 21, 33, null, "4");
  add("3v3, 3 tile types, 4-way symmetry", 21, 33, g3);
  // 3v3 asymmetric, same tiles
  const g3a = blank(21, 33);
  for (let r = 0; r < 33; r++) for (let c = 0; c < 21; c++) { const x = rand(); if (x < 0.18) g3a[r][c] = "M"; else if (x < 0.26) g3a[r][c] = "Y"; else if (x < 0.30) g3a[r][c] = "W"; }
  add("3v3, 3 tile types, asymmetrical", 21, 33, g3a);
  // dense SD map: every cell filled from 8 tile types, asymmetric
  const gd = blank(60, 60);
  for (let r = 0; r < 60; r++) for (let c = 0; c < 60; c++) gd[r][c] = SYMS[Math.floor(rand() * 8)];
  add("SD dense (60x60, 8 tile types, random)", 60, 60, gd);
  const gds = blank(60, 60);
  for (let r = 0; r < 60; r++) for (let c = 0; c < 60; c++) gds[r][c] = SYMS[Math.floor(rand() * 8)];
  symmetrise(gds, 60, 60, null, "4");
  add("SD dense, 8 tile types, 4-way symmetry", 60, 60, gds);
  const gw = blank(60, 60);
  for (let r = 0; r < 60; r++) for (let c = 0; c < 60; c++) { const x = rand(); gw[r][c] = x < 0.55 ? "M" : x < 0.75 ? "Y" : x < 0.9 ? "W" : null; }
  add("SD dense walls (60x60, 3 types + gaps, random)", 60, 60, gw);
  console.log("\n  seed lengths (characters):");
  rows.forEach(([label, len, mir, codeLen]) => console.log(`    ${String(len).padStart(6)}  ${label}  [mirror ${mir}, code ${codeLen}]`));
  console.log("    empty 21x33 seed: " + rows[0][4]);
  assert.ok(rows[0][1] <= 20);
  assert.ok(rows[1][1] < rows[2][1]);
});

console.log(`\n${passed} tests passed`);
