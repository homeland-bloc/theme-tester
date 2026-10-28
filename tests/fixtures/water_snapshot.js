// Shared by tests/sensor.test.js and the one-off generator: the full candidate table (status, pool sources, recipe) of a folder for all 47 codes.
// tests/fixtures/water_recipes.json was generated from the algorithm as it stood BEFORE the cardinal-only composition ranking was added.
const S = require("../../sensor.js");
const T = (ref, code, roll = 1, sortIndex = 0) => ({ ref, sensorCode: code, sensorRoll: roll, sortIndex });
const folder = (key, tiles, settings = {}) => ({ key, tiles, settings: { spin: false, flip: false, ...settings } });
const water = folder("water", [T("w1", "00001011"), T("w2", "01111111"), T("w3", "01101011"), T("w4", "11111111")], { spin: true });
const depthTop = ["00001011", "01101011", "00011111", "01111111"];
const depthBottom = ["01101000", "11111000", "11111011", "11111111"];
const depth = folder("depth", [...depthTop, ...depthBottom].map((c, i) => T("d" + i, c)), { flip: true });
const snapshot = f => {
  const cands = S.buildCandidates(f), out = {};
  for (const code of S.ALL_CODES) {
    const c = cands[code];
    out[code] = {
      status: c.status,
      pool: c.pool.map(e => ({ ref: e.ref, ops: e.ops, from: e.derivedFrom ? e.derivedFrom.ref : null })),
      recipe: c.recipe ? c.recipe.map(r => ({ quadrant: r.quadrant, type: r.type, tile: r.sourceTileRef, sourceQuadrant: r.sourceQuadrant, flip: r.flip, spinSteps: r.spinSteps, sourceCode: r.sourceCode })) : null,
    };
  }
  return out;
};
module.exports = { water, depth, snapshot };
