// Run with: node tests/highlight_move.test.js   (no dependencies)
// The helpers live in index.html (no new files); this loads exactly the block between the markers.
const assert = require("assert");
const fs = require("fs");
const html = fs.readFileSync(__dirname + "/../index.html", "utf8");
const m = html.match(/\/\/ <highlight-move-helpers>([\s\S]*?)\/\/ <\/highlight-move-helpers>/);
if (!m) throw new Error("highlight-move-helpers block not found in index.html");
const { mirrorImages, planHighlightMove, applyHighlightMovePlan } = new Function(m[1] + "\nreturn { mirrorImages, planHighlightMove, applyHighlightMovePlan };")();

let passed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log("ok   " + name); } catch (e) { console.error("FAIL " + name + "\n" + e.stack); process.exitCode = 1; } };

const ROWS = 33, COLS = 21;
const ctxOf = (flags = {}, rows = ROWS, cols = COLS) => ({ v: false, h: false, d: false, ...flags, cR: (rows - 1) / 2, cC: (cols - 1) / 2, rows, cols });
const emptyGrid = (rows = ROWS, cols = COLS) => Array.from({ length: rows }, () => Array(cols).fill(null));
const hasOf = g => (r, c) => g[r][c] != null;
const rect = (r1, c1, r2, c2) => { const o = []; for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) o.push([r, c]); return o; };
const K = ps => ps.map(([r, c]) => r + "," + c).sort();
const fillBlock = (g, r1, c1, r2, c2, v) => rect(r1, c1, r2, c2).forEach(([r, c]) => { g[r][c] = v; });

test("mirrorImages: geometry matches getMirrorMeta (V = left/right, H = top/bottom, D = point reflection)", () => {
  const ctx = ctxOf({ v: true, h: true, d: true });
  assert.deepStrictEqual(mirrorImages(3, 4, ctx).map(e => e.k), ["", "V", "H", "D"]);
  assert.deepStrictEqual(mirrorImages(3, 4, ctx).map(e => e.pos), [[3, 4], [3, 16], [29, 4], [29, 16]]);
  assert.deepStrictEqual(mirrorImages(3, 4, ctxOf({ d: true })).map(e => e.pos), [[3, 4], [29, 16]]);
  assert.deepStrictEqual(mirrorImages(3, 4, ctxOf({ v: true, h: true })).map(e => e.pos), [[3, 4], [3, 16], [29, 4]]); // V+H alone: no 4th corner
  // half-cell centre (even width): 2*cC - c still an integer
  assert.deepStrictEqual(mirrorImages(0, 0, ctxOf({ v: true }, 4, 4)).map(e => e.pos), [[0, 0], [0, 3]]);
});

test("no mirroring: plain move, out-of-grid cells are dropped, never wrapped", () => {
  const g = emptyGrid(); fillBlock(g, 0, 0, 1, 2, 7);
  const plan = planHighlightMove({ primary: rect(0, 0, 1, 2), dr: -1, dc: 19, ctx: ctxOf(), hasContent: hasOf(g) });
  // dr -1 pushes row 0 out; dc +19 pushes col 2 (-> 21) out
  assert.deepStrictEqual(K(plan.writes.map(w => w.to)), K([[0, 19], [0, 20]]));
  assert.strictEqual(plan.moves.filter(x => x.drop === "bounds").length, 4);
  const out = applyHighlightMovePlan(g, plan).grid;
  assert.strictEqual(out.flat().filter(v => v != null).length, 2);
  assert.strictEqual(out[0][19], 7); assert.strictEqual(out[0][20], 7);
  assert.strictEqual(out[32][0], null); // no wrap-around anywhere
  assert.deepStrictEqual(K(plan.newPrimary), K([[0, 19], [0, 20], [0, 21 - 0]].filter(([r, c]) => c < COLS)));
});

test("V mirror: the mirror image moves by the mirrored column offset", () => {
  const g = emptyGrid(); g[10][3] = 1; g[10][17] = 2; // mirror pair about col 10
  const plan = planHighlightMove({ primary: [[10, 3]], dr: 2, dc: 1, ctx: ctxOf({ v: true }), hasContent: hasOf(g) });
  assert.deepStrictEqual(K(plan.sources), K([[10, 3], [10, 17]]));
  const out = applyHighlightMovePlan(g, plan).grid;
  assert.strictEqual(out[12][4], 1);   // primary: +2, +1
  assert.strictEqual(out[12][16], 2);  // image: +2, -1
  assert.strictEqual(out[10][3], null); assert.strictEqual(out[10][17], null);
  assert.deepStrictEqual(K(plan.newHighlight), K([[12, 4], [12, 16]]));
});

test("H mirror and D mirror offsets", () => {
  const g = emptyGrid(); g[4][5] = 1; g[28][5] = 2; g[4][15] = 3; g[28][15] = 4;
  const h = planHighlightMove({ primary: [[4, 5]], dr: 1, dc: 2, ctx: ctxOf({ h: true }), hasContent: hasOf(g) });
  const oh = applyHighlightMovePlan(g, h).grid;
  assert.strictEqual(oh[5][7], 1); assert.strictEqual(oh[27][7], 2); // H image moves up while the primary moves down
  const d = planHighlightMove({ primary: [[4, 5]], dr: 1, dc: 2, ctx: ctxOf({ d: true }), hasContent: hasOf(g) });
  const od = applyHighlightMovePlan(g, d).grid;
  assert.strictEqual(od[5][7], 1); assert.strictEqual(od[27][13], 4); // D image: (-1, -2)
});

test("all three mirrors: four cells, each by its own mirrored offset", () => {
  const g = emptyGrid(); g[4][5] = 1; g[4][15] = 2; g[28][5] = 3; g[28][15] = 4;
  const plan = planHighlightMove({ primary: [[4, 5]], dr: 2, dc: 1, ctx: ctxOf({ v: true, h: true, d: true }), hasContent: hasOf(g) });
  const out = applyHighlightMovePlan(g, plan).grid;
  assert.deepStrictEqual([out[6][6], out[6][14], out[26][6], out[26][14]], [1, 2, 3, 4]);
  assert.strictEqual(out.flat().filter(v => v != null).length, 4);
});

test("selection straddling its own mirror axis is one set; primaries all move by (dr, dc)", () => {
  const g = emptyGrid(); rect(13, 8, 15, 12).forEach(([r, c], i) => { g[r][c] = (i % 5) + 1; });
  const prim = rect(13, 8, 15, 12);
  const plan = planHighlightMove({ primary: prim, dr: 2, dc: 1, ctx: ctxOf({ v: true }), hasContent: hasOf(g) });
  assert.strictEqual(plan.sources.length, 15); // union with its own mirror is the same 15 cells
  assert.ok(plan.moves.every(x => x.kind === "primary"));
  const out = applyHighlightMovePlan(g, plan).grid;
  rect(13, 8, 15, 12).forEach(([r, c]) => assert.strictEqual(out[r + 2][c + 1], g[r][c]));
  assert.strictEqual(out[13][8], null); // lifted, not duplicated
  assert.strictEqual(out.flat().filter(v => v != null).length, 15);
});

test("an image that is also a primary cell moves as primary; every target written once", () => {
  // D mirror, 2x2 selection whose moved image lands exactly on the moved primary
  const g = emptyGrid(); fillBlock(g, 15, 9, 16, 10, 5); fillBlock(g, 16, 10, 16, 10, 5);
  const plan = planHighlightMove({ primary: rect(15, 9, 16, 10), dr: 0, dc: 0, ctx: ctxOf({ d: true }), hasContent: hasOf(g) });
  const targets = plan.writes.map(w => w.to.join(","));
  assert.strictEqual(new Set(targets).size, targets.length);
});

test("collision: primary beats mirror, loser is dropped and reported", () => {
  const g = emptyGrid(); g[15][9] = 1; g[17][11] = 2; // mirror pair (D about 16,10); moving (+1,+1) swaps them onto each other's side
  const plan = planHighlightMove({ primary: [[15, 9]], dr: 1, dc: 1, ctx: ctxOf({ d: true }), hasContent: hasOf(g) });
  // primary -> (16,10); image (17,11) -> image of (16,10) = (16,10): same target
  const out = applyHighlightMovePlan(g, plan).grid;
  assert.strictEqual(out[16][10], 1);
  assert.strictEqual(plan.moves.filter(x => x.drop === "collision").length, 1);
  assert.strictEqual(plan.moves.find(x => x.drop === "collision").kind, "mirror");
  assert.strictEqual(out.flat().filter(v => v != null).length, 1);
});

test("out-of-grid targets are dropped per cell; a mirror partner whose own target is inside still lands (custom centre)", () => {
  const g = emptyGrid(); g[5][1] = 1; g[5][3] = 2; // magnet axis at col 2: (5,1) and (5,3) are mirror images
  const ctx = { ...ctxOf({ v: true }), cC: 2 };
  const plan = planHighlightMove({ primary: [[5, 1]], dr: 0, dc: -2, ctx, hasContent: hasOf(g) });
  // primary -> col -1 (outside, dropped); image -> mirrored offset +2 -> col 5 (inside, lands)
  assert.deepStrictEqual(plan.moves.map(x => [x.kind, x.drop]), [["primary", "bounds"], ["mirror", null]]);
  const out = applyHighlightMovePlan(g, plan).grid;
  assert.strictEqual(out[5][5], 2);
  assert.strictEqual(out.flat().filter(v => v != null).length, 1);
  assert.deepStrictEqual(plan.newPrimary, []); // the dropped primary is no longer selected
  // plain case: both leave the grid together on a centred axis, nothing wraps
  const g2 = emptyGrid(); g2[0][3] = 1; g2[0][17] = 2;
  const p2 = planHighlightMove({ primary: [[0, 3]], dr: -1, dc: 0, ctx: ctxOf({ v: true }), hasContent: hasOf(g2) });
  assert.deepStrictEqual(p2.moves.map(x => x.drop), ["bounds", "bounds"]);
  assert.strictEqual(applyHighlightMovePlan(g2, p2).grid.flat().filter(v => v != null).length, 0);
});

test("empty cells are transparent: they neither write nor block", () => {
  const g = emptyGrid(); g[5][5] = 1; g[5][6] = 9; // (5,6) is an existing tile at the target
  const plan = planHighlightMove({ primary: [[5, 4], [5, 5]], dr: 0, dc: 1, ctx: ctxOf(), hasContent: hasOf(g) });
  const out = applyHighlightMovePlan(g, plan).grid;
  assert.strictEqual(out[5][6], 1);          // tile moved onto the old (5,5)+1
  assert.strictEqual(out[5][5], null);
  assert.strictEqual(out[5][4], null);
  assert.strictEqual(plan.moves.find(x => x.from.join() === "5,4").drop, "empty");
});

test("sparse offsets travel with their cell and are cleared at the source", () => {
  const g = emptyGrid(); g[3][3] = 1;
  const plan = planHighlightMove({ primary: [[3, 3]], dr: 1, dc: 1, ctx: ctxOf(), hasContent: hasOf(g) });
  const out = applyHighlightMovePlan(g, plan, { "3,3": { ox: 5, oy: 6 }, "9,9": { ox: 1, oy: 1 } });
  assert.deepStrictEqual(out.sparse, { "4,4": { ox: 5, oy: 6 }, "9,9": { ox: 1, oy: 1 } });
});

test("new highlight = mirrors of the moved primary cells (the invariant the rest of the tool relies on)", () => {
  const g = emptyGrid(); fillBlock(g, 12, 4, 14, 6, 1);
  for (const flags of [{ v: true }, { h: true }, { d: true }, { v: true, h: true, d: true }, { v: true, h: true }]) {
    const ctx = ctxOf(flags);
    const plan = planHighlightMove({ primary: rect(12, 4, 14, 6), dr: 2, dc: 1, ctx, hasContent: hasOf(g) });
    const want = new Set(); plan.newPrimary.forEach(([r, c]) => mirrorImages(r, c, ctx).forEach(({ pos }) => { if (pos[0] >= 0 && pos[0] < ROWS && pos[1] >= 0 && pos[1] < COLS) want.add(pos.join(",")); }));
    assert.deepStrictEqual(K(plan.newHighlight), [...want].sort());
  }
});

test("random moves: tiles are conserved except the reported drops, targets unique and in bounds, no tile read after clearing", () => {
  let seed = 12345; const rnd = n => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % n; };
  for (let iter = 0; iter < 400; iter++) {
    const rows = 9 + rnd(8), cols = 9 + rnd(8);
    const ctx = ctxOf({ v: !!rnd(2), h: !!rnd(2), d: !!rnd(2) }, rows, cols);
    const g = emptyGrid(rows, cols);
    for (let i = 0; i < rows * cols * 0.6; i++) g[rnd(rows)][rnd(cols)] = 1 + rnd(5);
    const prim = []; const r0 = rnd(rows), c0 = rnd(cols), r1 = Math.min(rows - 1, r0 + rnd(4)), c1 = Math.min(cols - 1, c0 + rnd(4));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) prim.push([r, c]);
    const dr = rnd(7) - 3, dc = rnd(7) - 3;
    const plan = planHighlightMove({ primary: prim, dr, dc, ctx, hasContent: hasOf(g) });
    const t = plan.writes.map(w => w.to.join(","));
    assert.strictEqual(new Set(t).size, t.length, "targets unique");
    plan.writes.forEach(({ to: [r, c] }) => assert.ok(r >= 0 && r < rows && c >= 0 && c < cols));
    const srcKeys = new Set(plan.sources.map(s => s.join(",")));
    assert.strictEqual(srcKeys.size, plan.sources.length, "sources de-duplicated");
    plan.writes.forEach(w => assert.ok(srcKeys.has(w.from.join(","))));
    const out = applyHighlightMovePlan(g, plan).grid;
    const lost = plan.moves.filter(x => x.drop === "bounds" || x.drop === "collision").length;
    const count = x => x.flat().filter(v => v != null).length;
    // collisions may land on a pre-existing tile outside S (overwrite) or on a cell vacated by another source
    const overwritten = plan.writes.filter(w => g[w.to[0]][w.to[1]] != null && !srcKeys.has(w.to.join(","))).length;
    assert.strictEqual(count(out), count(g) - lost - overwritten, `conservation iter ${iter}`);
    // input grid untouched
    assert.strictEqual(count(g) >= count(out) - 0, true);
    // mirror-kind moves go to the mirrored image of p + d
    plan.moves.filter(x => x.kind === "mirror" && x.to).forEach(x => assert.ok(x.to));
  }
});

console.log(`${passed} passed`);
