// Run with: node tests/history_extras.test.js   (no dependencies)
// Undo/redo must restore gridOffsets and the magnet (position + size). The helpers live in index.html between <history-helpers> markers.
const assert = require("assert");
const fs = require("fs");
const html = fs.readFileSync(__dirname + "/../index.html", "utf8");
const m = html.match(/\/\/ <history-helpers>([\s\S]*?)\/\/ <\/history-helpers>/);
if (!m) throw new Error("history-helpers block not found in index.html");
const { snapExtras, restoreExtras, patchLiveEntry } = new Function(m[1] + "\nreturn { snapExtras, restoreExtras, patchLiveEntry };")();

let passed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log("ok   " + name); } catch (e) { console.error("FAIL " + name + "\n" + e.stack); process.exitCode = 1; } };

// A miniature of the app's history: entries are post-action snapshots, undo restores history[idx - 1].
const mini = () => {
  const st = { offsets: {}, cc: null, size: 1, history: [], idx: -1, live: null };
  const snap = label => ({ label, ...snapExtras(st.offsets, st.cc, st.size) });
  const push = label => { const e = snap(label); st.history = [...st.history.slice(0, st.idx + 1), e]; st.idx = st.history.length - 1; st.live = e; };
  const setOffsets = next => { st.offsets = next; const p = patchLiveEntry(st.history, st.idx, st.live, next); if (p) { st.history = p; st.live = p[st.idx]; } };
  const apply = e => { const ex = restoreExtras(e); if ("gridOffsets" in ex) st.offsets = ex.gridOffsets; if ("customCenter" in ex) st.cc = ex.customCenter; if ("customCenterSize" in ex) st.size = ex.customCenterSize; };
  const undo = () => { if (st.idx > 0) { st.idx--; apply(st.history[st.idx]); } };
  const redo = () => { if (st.idx < st.history.length - 1) { st.idx++; apply(st.history[st.idx]); } };
  push("start"); st.live = null;
  return { st, push, setOffsets, undo, redo, tick: () => { st.live = null; } };
};

test("undoing a move restores the offsets (and redo brings them back)", () => {
  const h = mini();
  h.setOffsets({ "1,1": { x: 3, y: 4 } }); h.push("Draw"); h.tick();
  h.setOffsets({ "2,2": { x: 3, y: 4 } }); h.push("Move"); h.tick(); // the move lifted 1,1 and put it on 2,2
  h.undo();
  assert.deepStrictEqual(h.st.offsets, { "1,1": { x: 3, y: 4 } });
  h.undo();
  assert.deepStrictEqual(h.st.offsets, {});
  h.redo(); h.redo();
  assert.deepStrictEqual(h.st.offsets, { "2,2": { x: 3, y: 4 } });
});

test("undoing a magnet position or size change restores both", () => {
  const h = mini();
  h.st.cc = { r: 3, c: 4 }; h.push("Magnet"); h.tick();
  h.st.size = 2; h.push("Magnet"); h.tick();
  h.st.cc = null; h.st.size = 1; h.push("Reset Origin"); h.tick();
  h.undo(); assert.deepStrictEqual([h.st.cc, h.st.size], [{ r: 3, c: 4 }, 2]);
  h.undo(); assert.deepStrictEqual([h.st.cc, h.st.size], [{ r: 3, c: 4 }, 1]);
  h.undo(); assert.deepStrictEqual([h.st.cc, h.st.size], [null, 1]);
  h.redo(); h.redo(); h.redo(); assert.deepStrictEqual([h.st.cc, h.st.size], [null, 1]);
});

test("offsets set just AFTER the grid push of the same action land in that action's entry", () => {
  const h = mini();
  h.push("Draw"); // setGrid pushed first (offsets still old) ...
  h.setOffsets({ "5,5": { x: 1, y: 1 } }); // ... then the mirror-offset override is written in the same tick
  h.tick();
  h.push("Draw"); h.tick();
  h.undo();
  assert.deepStrictEqual(h.st.offsets, { "5,5": { x: 1, y: 1 } });
  // a later tick does not touch an old entry
  h.setOffsets({}); assert.deepStrictEqual(h.st.history[h.st.idx].gridOffsets, { "5,5": { x: 1, y: 1 } });
});

test("snapshots without the new fields leave offsets and magnet alone", () => {
  assert.deepStrictEqual(restoreExtras({ grid: [] }), {});
  assert.deepStrictEqual(restoreExtras(null), {});
  assert.deepStrictEqual(restoreExtras({ customCenterSize: 9, gridOffsets: 5 }), {});
  assert.deepStrictEqual(restoreExtras({ customCenter: null }), { customCenter: null });
});

test("index.html: every snapshot builder stores the extras and applySnap restores them", () => {
  const withTileset = html.split("\n").filter(l => /\btileset: (activeTilesetRef\.current|newTilesetName)/.test(l) && /\bw: /.test(l) && !/grid: o\.grid/.test(l));
  assert.ok(withTileset.length >= 4, "snapshot literals found: " + withTileset.length);
  for (const l of withTileset) assert.ok(/snapExtras\(/.test(l), "snapshot without snapExtras: " + l.trim().slice(0, 120));
  assert.ok(/makeSnap = [\s\S]*?snapExtras\(/.test(html));
  assert.ok(/const ex = restoreExtras\(snap\)/.test(html));
  assert.ok(/gridOffsetsRef\.current = next/.test(html));
  // the raw setter is only used by the wrapper
  assert.strictEqual((html.match(/setGridOffsetsRaw\(/g) || []).length, 1);
  // the magnet writes push a history entry
  assert.strictEqual((html.match(/save\("oph_custom_center", \{ r: clampedR, c: clampedC \}\); pushMagnetHistory\(\);/g) || []).length, 3);
});

console.log(`\n${passed} tests passed`);
