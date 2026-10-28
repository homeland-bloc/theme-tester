// Run with: node tests/compose_geometry.test.js
// Quadrant geometry with a transparent top margin / tall / wide-short images (phase 12).
const assert = require("assert");
const U = require("../sensor_ui.js");
const R = require("./lib/compose_ref.js");

let passed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log("ok   " + name); } catch (e) { console.error("FAIL " + name + "\n" + e.stack); process.exitCode = 1; } };
const rec = (...qs) => qs.map((q, i) => ({ quadrant: i, sourceTileRef: q.ref ?? "a", spinSteps: q.steps ?? 0, flip: !!q.flip }));
const same = o => rec(o, o, o, o);
const at = (img, x, y) => Array.from(img.px.slice((y * img.w + x) * 4, (y * img.w + x) * 4 + 4));
const rotCW = (img, x0, y0, n) => { // clockwise quarter turn of the n x n block at (x0, y0)
  const out = { w: img.w, h: img.h, px: new Uint8Array(img.px) };
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const from = ((y0 + y) * img.w + x0 + x) * 4, to = ((y0 + x) * img.w + x0 + (n - 1 - y)) * 4;
    for (let c = 0; c < 4; c++) out.px[to + c] = img.px[from + c];
  }
  return out;
};

test("topEdgeOfPixels: highest row with alpha > 0; fully transparent -> null", () => {
  assert.strictEqual(U.topEdgeOfPixels(100, 240, R.synthImage("t", 100, 240, 30).px), 30);
  assert.strictEqual(U.topEdgeOfPixels(10, 10, new Uint8Array(400)), null);
  const px = new Uint8Array(10 * 10 * 4); px[(4 * 10 + 7) * 4 + 3] = 1; // alpha 1 counts as visible
  assert.strictEqual(U.topEdgeOfPixels(10, 10, px), 4);
});

test("folderTopEdge: the highest visible row among the tiles (minimum), nulls ignored", () => {
  assert.strictEqual(U.folderTopEdge([30, 12, 45]), 12);
  assert.strictEqual(U.folderTopEdge([null, 30]), 30);
  assert.strictEqual(U.folderTopEdge([null, null]), null);
  assert.strictEqual(U.folderTopEdge([]), null);
});

test("topEdgeKey: by the folder's image URLs (?v= included), order independent", () => {
  assert.strictEqual(U.topEdgeKey("f", ["b.png?v=2", "a.png?v=1"]), U.topEdgeKey("f", ["a.png?v=1", "b.png?v=2"]));
  assert.notStrictEqual(U.topEdgeKey("f", ["a.png?v=1"]), U.topEdgeKey("f", ["a.png?v=2"]));
});

test("tall 100x240, 30 transparent rows: seams x = 50, y = 30 + 50 = 80; TL/TR include the rows above, BL/BR reach the bottom", () => {
  const g = U.quadrantGeometry(100, 240, 30);
  assert.deepStrictEqual([g.sx, g.sy], [50, 80]);
  assert.deepStrictEqual(g.rects, [{ x: 0, y: 0, w: 50, h: 80 }, { x: 50, y: 0, w: 50, h: 80 }, { x: 50, y: 80, w: 50, h: 160 }, { x: 0, y: 80, w: 50, h: 160 }]);
  const plan = U.composePlan(same({}), 100, 240, 30);
  assert.deepStrictEqual(plan.map(p => [p.x, p.y, p.w, p.h]), [[0, 0, 50, 80], [50, 0, 50, 80], [50, 80, 50, 160], [0, 80, 50, 160]]);
  assert.ok(plan.every(p => p.tx === 50 && p.ty === 80 && p.sx === 50 && p.sy === 80));
});

test("wide-short clamp: 100x40 with a 0 margin puts the seam at the bottom (min(H, top + W/2)); BL/BR are empty", () => {
  const g = U.quadrantGeometry(100, 40, 0);
  assert.strictEqual(g.sy, 40);
  assert.deepStrictEqual(g.rects[2], { x: 50, y: 40, w: 50, h: 0 });
  assert.strictEqual(U.quadrantGeometry(100, 40, 30).sy, 40);
});

test("topEdge unknown: the old centred layout, and it equals the margin-free square layout", () => {
  assert.deepStrictEqual(U.quadrantGeometry(100, 80, null), U.quadrantGeometry(100, 80, undefined));
  assert.strictEqual(U.quadrantGeometry(100, 80, null).sy, 40);
  assert.deepStrictEqual(U.quadrantGeometry(100, 100, null), U.quadrantGeometry(100, 100, 0));
});

test("all four quadrants from one tile with no transform rebuild the tall image exactly (transparent top rows and bottom included)", () => {
  const img = R.synthImage("a", 100, 240, 30);
  const out = R.render(U.composePlan(same({}), 100, 240, 30), { a: img }, 100, 240);
  assert.strictEqual(R.hash(out), R.hash(img.px));
});

test("flip mirrors about the vertical seam; the rows above the art stay transparent", () => {
  const img = R.synthImage("a", 100, 240, 30);
  const out = { w: 100, h: 240, px: R.render(U.composePlan(same({ flip: true }), 100, 240, 30), { a: img }, 100, 240) };
  assert.deepStrictEqual(at(out, 99, 100), at(img, 0, 100));
  assert.deepStrictEqual(at(out, 10, 239), at(img, 89, 239));
  assert.strictEqual(at(out, 10, 29)[3], 0);
});

test("spin 1 / spin 2 turn a square art block (100x100 under 30 transparent rows) about its centre: it stays in place", () => {
  const img = R.synthImage("a", 100, 130, 30);
  for (const k of [1, 2]) {
    const out = { w: 100, h: 130, px: R.render(U.composePlan(same({ steps: k }), 100, 130, 30), { a: img }, 100, 130) };
    let want = img; for (let i = 0; i < k; i++) want = rotCW(want, 0, 30, 100);
    assert.deepStrictEqual(Array.from(out.px), Array.from(want.px), `spin ${k}`);
  }
});

test("a quadrant of a spun source lands on its target quadrant (spin 1: source TL -> target TR)", () => {
  const img = R.synthImage("a", 100, 130, 30);
  const plan = U.composePlan([{ quadrant: 1, sourceTileRef: "a", spinSteps: 1, flip: false }], 100, 130, 30);
  const out = { w: 100, h: 130, px: R.render(plan, { a: img }, 100, 130) };
  assert.deepStrictEqual(at(out, 99, 30), at(img, 0, 30));       // TL corner of the art -> TR corner
  assert.deepStrictEqual(at(out, 99, 79), at(img, 49, 30)); // source pixel (49,30) rotated clockwise about the seam (50, 80)
  assert.strictEqual(at(out, 10, 100)[3], 0, "outside the target quadrant nothing is drawn");
});

test("sources of a different height share the folder's top edge: each source uses its own clamp, the target keeps its own", () => {
  const short = R.synthImage("s", 100, 130, 30), tall = R.synthImage("t", 100, 240, 30);
  const size = ref => ({ s: { w: 100, h: 130 }, t: { w: 100, h: 240 } }[ref]);
  const plan = U.composePlan(rec({ ref: "s" }, { ref: "s" }, { ref: "t" }, { ref: "t" }), 100, 130, 30, size);
  assert.ok(plan.every(p => p.tx === 50 && p.ty === 80 && p.sy === 80), "same seam 30 + 50 everywhere");
  const out = R.render(plan, { s: short, t: tall }, 100, 130);
  const res = { w: 100, h: 130, px: out };
  assert.deepStrictEqual(at(res, 70, 100), at(tall, 70, 100)); // BR from the tall tile, same y
  assert.deepStrictEqual(at(res, 70, 50), at(short, 70, 50));  // TR from the short one
  // target shorter than the seam allows: clamp per image
  const squat = U.composePlan(same({}), 100, 60, 30, () => ({ w: 100, h: 60 }));
  assert.deepStrictEqual([squat[0].h, squat[2].h], [60, 0]);
});
test("highlightRect: the real region over the contained preview (tall: seam at 30 + 50), not a centred square", () => {
  // 100x240, margin 30 -> shown at scale 94/240 and centred horizontally
  const k = 94 / 240, left0 = (94 - 100 * k) / 2;
  const tl = U.highlightRect(0, 100, 240, 30, 94), br = U.highlightRect(2, 100, 240, 30, 94);
  assert.ok(Math.abs(tl.left - left0) < 1e-9 && tl.top === 0 && Math.abs(tl.width - 50 * k) < 1e-9 && Math.abs(tl.height - 80 * k) < 1e-9);
  assert.ok(Math.abs(br.top - 80 * k) < 1e-9 && Math.abs(br.top + br.height - 94) < 1e-9, "BR reaches the bottom");
  const sq = U.highlightRect(1, 100, 100, null, 94); // square, centred layout = the old 50% quarter
  assert.deepStrictEqual([sq.left, sq.top, sq.width, sq.height], [47, 0, 47, 47]);
});
console.log(`${passed} tests`);
