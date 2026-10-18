// Run with: node tests/legacy_rules.test.js   (no dependencies)
// getDefaultMultiplier / getDefaultOffset in index.html: the legacy path rules apply to global manifest tiles ONLY. DB tiles and sensor tiles with a
// null DB value are 1.0 / (0,0); a DB value, when present, is authoritative. The two functions are extracted from the source and evaluated.
const assert = require("assert");
const fs = require("fs");
const html = fs.readFileSync(__dirname + "/../index.html", "utf8");
const grab = name => {
  const i = html.indexOf(`  const ${name} = t => {`);
  if (i < 0) throw new Error(name + " not found");
  const end = html.indexOf("\n  };\n", i);
  return html.slice(i, end + 6);
};
const { getDefaultMultiplier, getDefaultOffset } = new Function(grab("getDefaultMultiplier") + grab("getDefaultOffset") + "\nreturn { getDefaultMultiplier, getDefaultOffset };")();
let passed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log("ok   " + name); } catch (e) { console.error("FAIL " + name + "\n" + e.stack); process.exitCode = 1; } };

const GLOBAL = src => ({ ref: "g:" + src, src, isDefault: true });
const DB = (src, extra = {}) => ({ ref: "d:x", src, isDefault: true, isDb: true, dbSizeMultiplier: null, dbOffsetX: null, dbOffsetY: null, ...extra });
const SENSOR = (src, extra = {}) => ({ ref: "s:t|F", src, isSensor: true, isDefault: true, dbSizeMultiplier: null, dbOffsetX: null, dbOffsetY: null, ...extra });

test("global manifest tiles keep the path rules", () => {
  assert.strictEqual(getDefaultMultiplier(GLOBAL("Resources/Global/Spawns/1.png")), 1.7);
  assert.strictEqual(getDefaultMultiplier(GLOBAL("Resources/Global/Jumppads/T.png")), 2.0);
  assert.strictEqual(getDefaultMultiplier(GLOBAL("Resources/Global/Objectives/Hot_Zone.png")), 7.0);
  assert.deepStrictEqual(getDefaultOffset(GLOBAL("Resources/Global/Jumppads/T.png")), { ox: 50, oy: 66 });
  assert.deepStrictEqual(getDefaultOffset(GLOBAL("Resources/Global/Special Tiles/Spikes.png")), { ox: 0, oy: -8 });
});

test("DB tiles with null values are 1.0 / (0,0) even when their image path looks like a legacy rule", () => {
  for (const src of ["https://raw/Resources/Snow/Spawns/1.png", "https://raw/Resources/Snow/Jumppads/T.png", "https://raw/Resources/Snow/Rope/Post_R.png", "https://raw/Resources/Snow/Hot_Zone.png", "https://raw/Resources/Snow/Heist.png"]) {
    assert.strictEqual(getDefaultMultiplier(DB(src)), 1.0, src);
    assert.deepStrictEqual(getDefaultOffset(DB(src)), { ox: 0, oy: 0 }, src);
  }
});

test("sensor tiles with null values are 1.0 / (0,0)", () => {
  assert.strictEqual(getDefaultMultiplier(SENSOR("https://raw/Resources/Snow/Teleporters/Blue.png")), 1.0);
  assert.deepStrictEqual(getDefaultOffset(SENSOR("https://raw/Resources/Snow/Teleporters/Blue.png")), { ox: 0, oy: 0 });
  // a global sensor folder (water / rails) has no path rule either
  assert.strictEqual(getDefaultMultiplier(SENSOR("Resources/Global/Water/00001011.png")), 1.0);
});

test("DB values stay authoritative (including an offset with only one component set falling back to 0,0)", () => {
  assert.strictEqual(getDefaultMultiplier(DB("x/Spawns/1.png", { dbSizeMultiplier: "1.5" })), 1.5);
  assert.strictEqual(getDefaultMultiplier(SENSOR("x.png", { dbSizeMultiplier: 0.8 })), 0.8);
  assert.deepStrictEqual(getDefaultOffset(DB("x.png", { dbOffsetX: "10", dbOffsetY: -5 })), { ox: 10, oy: -5 });
  assert.deepStrictEqual(getDefaultOffset(DB("x/Jumppads/T.png", { dbOffsetX: 10 })), { ox: 0, oy: 0 });
});

test("uploads and data: urls stay 1.0 / (0,0)", () => {
  assert.strictEqual(getDefaultMultiplier({ ref: "u:1", src: "data:image/png;base64,xx" }), 1.0);
  assert.deepStrictEqual(getDefaultOffset({ ref: "u:1", src: "data:image/png;base64,xx" }), { ox: 0, oy: 0 });
});

console.log(`${passed} passed`);
