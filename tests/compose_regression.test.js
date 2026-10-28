// Run with: node tests/compose_regression.test.js
// Regression guard for composed variants: the pixels composed from synthetic SQUARE images (no transparent margin) for both water
// fixtures over all 47 codes, and their recipes, must stay byte-identical across the quadrant-geometry change (phase 12).
// Regenerate the golden file only on purpose: UPDATE_GOLDEN=1 node tests/compose_regression.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const S = require("../sensor.js");
const U = require("../sensor_ui.js");
const { water, depth, snapshot } = require("./fixtures/water_snapshot.js");
const R = require("./lib/compose_ref.js");

const GOLDEN = path.join(__dirname, "fixtures", "compose_golden.json");
const SIZE = 100;
const composeAll = f => {
  const images = {};
  for (const t of f.tiles) images[t.ref] = R.synthImage(t.ref, SIZE, SIZE);
  const cands = S.buildCandidates(f), out = {};
  for (const code of S.ALL_CODES) {
    const c = cands[code];
    if (c.status !== "composed") continue;
    out[code] = R.hash(R.render(U.composePlan(c.recipe, SIZE, SIZE, 0), images, SIZE, SIZE));
  }
  return out;
};
const current = () => ({ water: { pixels: composeAll(water), recipes: snapshot(water) }, depth: { pixels: composeAll(depth), recipes: snapshot(depth) } });

if (process.env.UPDATE_GOLDEN) { fs.writeFileSync(GOLDEN, JSON.stringify(current(), null, 1)); console.log("golden written"); process.exit(0); }

let passed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log("ok   " + name); } catch (e) { console.error("FAIL " + name + "\n" + e.stack); process.exitCode = 1; } };
const golden = JSON.parse(fs.readFileSync(GOLDEN, "utf8")), now = current();

for (const k of ["water", "depth"]) {
  test(`${k}: composed pixels of every composed code (square images) are unchanged`, () => {
    assert.ok(Object.keys(golden[k].pixels).length > 10, "golden has composed codes");
    assert.deepStrictEqual(now[k].pixels, golden[k].pixels);
  });
  test(`${k}: statuses, pools and recipes of all 47 codes are unchanged`, () => {
    assert.strictEqual(Object.keys(golden[k].recipes).length, 47);
    assert.deepStrictEqual(now[k].recipes, golden[k].recipes);
  });
}
console.log(`${passed} tests`);
