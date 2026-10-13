// Sensor UI helpers: pure functions used by index.html around sensor.js (no DOM, no React).
//
// Sensor refs are palette refs of kind "s": s:<tilesetId | "global">|<folderKey>. They name a LOGICAL tile (the folder);
// the variant drawn in a cell is derived from the grid (deriveLayer) and never stored in the map.
// Browser: window.SensorUI (needs window.Sensor). Node: require("./sensor_ui.js").
(function (root, factory) {
  const node = typeof module === "object" && module.exports;
  const api = factory(node ? require("./sensor.js") : root.Sensor, node ? require("./tile_palette.js") : root.TilePalette);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SensorUI = api;
})(typeof self !== "undefined" ? self : this, function (Sensor, TilePalette) {
  const SCOPE_GLOBAL = "global";

  // ── Refs ──────────────────────────────────────────────────────────────────────────────────────────────
  const sensorRef = (scope, folderKey) => `s:${scope}|${folderKey}`;
  // -> { scope, folderKey } or null. The scope never contains "|", the folder key may.
  const parseSensorRef = ref => {
    if (typeof ref !== "string" || !ref.startsWith("s:")) return null;
    const body = ref.slice(2), i = body.indexOf("|");
    if (i < 1 || i === body.length - 1) return null;
    return { scope: body.slice(0, i), folderKey: body.slice(i + 1) };
  };
  const isSensorRef = ref => parseSensorRef(ref) !== null;

  // ── Field parsing (tile modal / add tile / create tileset) ────────────────────────────────────────────
  // "" -> null (no code). "00000000" is a real code and stays distinct from empty.
  const parseCodeInput = text => {
    const s = String(text == null ? "" : text).trim();
    if (s === "") return { ok: true, value: null };
    if (/^[01]{8}$/.test(s)) return { ok: true, value: s };
    return { ok: false, value: null, error: "Sensor code must be 8 characters of 0 and 1 (leave empty for none)." };
  };
  // "" -> null (leave to the DB default). Otherwise an integer >= 0.
  const parseRollInput = text => {
    const s = String(text == null ? "" : text).trim();
    if (s === "") return { ok: true, value: null };
    if (/^\d+$/.test(s) && Number.isSafeInteger(Number(s))) return { ok: true, value: Number(s) };
    return { ok: false, value: null, error: "Roll must be a whole number, 0 or more (0 = never picked)." };
  };
  // Inline-edit state of a code field: "saved" (equals the DB value), "edited" (differs), "invalid".
  const codeFieldState = (text, savedCode) => {
    const p = parseCodeInput(text);
    if (!p.ok) return "invalid";
    return p.value === (savedCode == null ? null : savedCode) ? "saved" : "edited";
  };
  // 3x3 cells in reading order (NW N NE / W C E / SW S SE): { bit, filled, centre }.
  const codeGridCells = code => {
    const ok = Sensor.isCode(code);
    const order = [0, 1, 2, 3, null, 4, 5, 6, 7];
    return order.map(bit => (bit === null ? { bit: null, filled: false, centre: true } : { bit, filled: ok && code[bit] === "1", centre: false }));
  };

  // Symbol field: "" -> null; otherwise the last typed code point. '6' (warn tile) and '7' (space tile) are reserved for the special tiles.
  const parseSymbolInput = text => {
    const ch = [...String(text == null ? "" : text).trim()].slice(-1)[0];
    if (ch === undefined) return { ok: true, value: null };
    if (TilePalette.isReservedSymbol(ch)) return { ok: false, value: null, error: `'${ch}' is reserved for the ${ch === TilePalette.SYMBOL_WARN ? "warn" : "space"} tile.` };
    return { ok: true, value: ch };
  };
  // Symbols already used by a tileset's tiles / folders (for suggestions): array of single characters.
  const usedSymbols = tiles => (tiles || []).map(t => t && t.symbol).filter(Boolean);
  const suggestSymbol = tiles => TilePalette.suggestSymbol(usedSymbols(tiles));

  // Click on a bit of the 3x3 grid: flips that bit of the typed text (a short or empty text is padded with zeros first).
  const toggleCodeBit = (text, bit) => {
    const raw = String(text == null ? "" : text).replace(/[^01]/g, "").slice(0, 8).padEnd(8, "0").split("");
    raw[bit] = raw[bit] === "1" ? "0" : "1";
    return raw.join("");
  };
  // "acts as <code>" hint: the normalised code when the typed (valid) code is not normalised, else null.
  const normalisedHint = text => {
    const p = parseCodeInput(text);
    if (!p.ok || p.value === null) return null;
    const n = Sensor.normalise(p.value);
    return n === p.value ? null : n;
  };

  // ── Group-level fields ────────────────────────────────────────────────────────────────────────────────
  // These DB columns are shared by every row of a (tileset, folder_key) sensor group.
  // Size and offsets are NOT group fields: they belong to each variant.
  const GROUP_COLUMNS = ["symbol", "rotatable", "flippable", "otg_passable", "bottom_render", "priority", "auto_shadow", "mirror_offset"];
  const splitGroupPatch = patch => {
    const group = {}, own = {};
    for (const k of Object.keys(patch || {})) (GROUP_COLUMNS.includes(k) ? group : own)[k] = patch[k];
    return { group, own };
  };

  // ── Folders ───────────────────────────────────────────────────────────────────────────────────────────
  const cmpSort = (a, b) => ((a.sortIndex ?? 0) - (b.sortIndex ?? 0)) || String(a.ref).localeCompare(String(b.ref));
  // Fields compared for the warning button. sensor_code, image, codename, sort index, sensor_roll, filename, size and offsets never count.
  const DIVERGENCE_FIELDS = [
    ["symbol", "Symbol"],
    ["dbBottomRender", "Bottom render"], ["dbPriority", "Priority"], ["dbAutoShadow", "Auto shadow"], ["dbOtgPassable", "OTG passable"],
    ["dbRotatable", "Rotatable"], ["dbFlippable", "Flippable"], ["dbMirrorOffset", "Mirror offset"],
  ];
  // DB numerics can arrive as strings ("1.5"); compare them as numbers.
  const norm = v => (v == null ? null : (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) ? Number(v) : v);
  // -> [{ field, label, values: [{ value, tiles: [name] }] }] for fields where the labelled variants disagree.
  const divergence = tiles => {
    const out = [];
    const list = tiles.filter(t => Sensor.isCode(t.sensorCode));
    if (list.length < 2) return out;
    for (const [field, label] of DIVERGENCE_FIELDS) {
      const groups = new Map();
      for (const t of list) {
        const v = norm(t[field]);
        const k = JSON.stringify(v);
        if (!groups.has(k)) groups.set(k, { value: v, tiles: [] });
        groups.get(k).tiles.push(t.codename || t.sensorCode || t.ref);
      }
      if (groups.size > 1) out.push({ field, label, values: [...groups.values()] });
    }
    return out;
  };

  // A group of tiles sharing one folder. A sensor folder has at least one tile with a sensor code; tiles without one are
  // "unlabelled" (never auto-placed). `tiles` are tile objects: { ref, codename, sensorCode, sensorRoll, sortIndex, src, db* ... }.
  // cfg (global tilesets): { spin, flip, symbol } replaces the values read from the first variant.
  // -> null for a plain folder, else { ref, scope, folderKey, label, key, tiles, labelled, unlabelled, first, settings, symbol, warnings }.
  const makeFolder = ({ scope, folderKey, label, tiles, cfg }) => {
    const all = (tiles || []).slice().sort(cmpSort);
    const labelled = all.filter(t => Sensor.isCode(t.sensorCode));
    if (!labelled.length) return null;
    const unlabelled = all.filter(t => !Sensor.isCode(t.sensorCode));
    const first = labelled[0];
    const ref = sensorRef(scope, folderKey);
    return {
      ref, key: ref, scope, folderKey, label: label ?? folderKey,
      tiles: all, labelled, unlabelled, first,
      settings: { spin: cfg ? !!cfg.spin : !!first.dbRotatable, flip: cfg ? !!cfg.flip : !!first.dbFlippable },
      symbol: cfg && cfg.symbol != null ? cfg.symbol : (first.symbol ?? null),
      warnings: divergence(all),
    };
  };

  // Engine view of a folder (what sensor.js expects). Unlabelled tiles stay out: the resolver never picks them.
  const engineFolder = folder => ({ key: folder.ref, settings: folder.settings, tiles: folder.labelled });

  // ── Pickers ───────────────────────────────────────────────────────────────────────────────────────────
  // A sensor folder is ONE logical entry everywhere a tile is picked. `tiles` are UI tile objects; the folder's own entry is
  // the one with isSensor and sensorFolder (all its tiles, labelled or not, are the folder's members).
  const variantOwners = tiles => {
    const m = new Map();
    for (const t of tiles || []) if (t && t.isSensor && t.sensorFolder) for (const v of t.sensorFolder.tiles) m.set(v.ref, t.ref);
    return m;
  };
  // The list without the members of any sensor folder that is itself in the list.
  const hideSensorVariants = tiles => { const o = variantOwners(tiles); return (tiles || []).filter(t => !o.has(t.ref)); };
  // A member's ref becomes its folder's ref (starred / recent lists written before folders were logical entries).
  const canonicalRef = (ref, owners) => (owners && owners.get(ref)) || ref;
  // The refs with members mapped to their folder, first occurrence kept.
  const canonicalRefs = (refs, owners) => { const seen = new Set(), out = []; for (const r of refs || []) { const c = canonicalRef(r, owners); if (!seen.has(c)) { seen.add(c); out.push(c); } } return out; };
  // The (up to four) tiles of a folder shown as its preview, in folder order.
  const folderPreviewTiles = folder => ((folder && folder.labelled) || []).slice(0, 4);

  // ── Derived layer ─────────────────────────────────────────────────────────────────────────────────────
  // folders: Map(sensorRef -> { folder: engine folder, candidates }). Returns Map("r,c" -> result) with one entry per cell that
  // holds an s: entry. result is sensor.resolve()'s answer plus { nb, folderRef }, or { warn: true, nb, folderRef } when the
  // folder has no usable variant. Neighbours count only when they hold the SAME s: entry; the map edge counts as air.
  const deriveLayer = ({ grid, refs, folders }) => {
    const out = new Map();
    if (!folders || !folders.size || !grid) return out;
    for (let r = 0; r < grid.length; r++) {
      const row = grid[r];
      for (let c = 0; c < row.length; c++) {
        const idx = row[c];
        if (idx == null) continue;
        const ref = refs[idx];
        const f = ref ? folders.get(ref) : undefined;
        if (!f) continue;
        const isSame = (rr, cc) => rr >= 0 && rr < grid.length && cc >= 0 && cc < (grid[rr] || []).length && grid[rr][cc] != null && refs[grid[rr][cc]] === ref;
        const nb = Sensor.neighbourCode(r, c, isSame);
        const res = Sensor.resolve(f.folder, nb, { x: c, y: r, salt: ref, candidates: f.candidates });
        out.set(`${r},${c}`, res ? { ...res, nb, folderRef: ref } : { warn: true, nb, folderRef: ref });
      }
    }
    return out;
  };

  // CSS transform for a derived variant: ops are applied in order to the image, later ops on top of earlier ones, which in a
  // CSS transform list means the LAST op is written first. spin = clockwise 90, flipH = left-right mirror.
  const opsToCss = ops => (ops || []).slice().reverse().map(op => (op === "spin" ? "rotate(90deg)" : "scale(-1, 1)")).join(" ");
  // Human text: "spin x2, flip".
  const opsLabel = ops => {
    const spins = (ops || []).filter(o => o === "spin").length, flips = (ops || []).filter(o => o === "flipH").length;
    const parts = [];
    if (spins) parts.push(spins === 1 ? "spin" : `spin x${spins}`);
    if (flips) parts.push("flip");
    return parts.join(", ");
  };

  // ── Composition plan (the canvas side lives in index.html) ────────────────────────────────────────────
  // For each quadrant of a w x h target: the clip rect and the source tile to draw. The source is mirrored left-right first when
  // `flip`, then rotated clockwise by `steps` quarter-turns around the image centre, so source quadrant sq lands on quadrant q.
  const composePlan = (recipe, w, h) => {
    const hw = w / 2, hh = h / 2;
    const RECTS = [[0, 0], [hw, 0], [hw, hh], [0, hh]]; // TL TR BR BL
    return (recipe || []).map(e => ({ quadrant: e.quadrant, x: RECTS[e.quadrant][0], y: RECTS[e.quadrant][1], w: hw, h: hh, sourceTileRef: e.sourceTileRef, steps: e.spinSteps, flip: !!e.flip }));
  };
  const composeKey = (folderRef, code) => `${folderRef}#${code}`;

  // ── Tileset switch ────────────────────────────────────────────────────────────────────────────────────
  // s: entries of the outgoing tileset are matched by folder key into sensor folders of the incoming one. Global s: entries stay.
  // An s: entry of any other tileset is foreign (cleared). -> { matched:[{from,to}], mismatches:[{ref, codename}], foreign:[ref] }
  const planSensorSwitch = (refs, oldTsId, newTsId, newFolderKeys) => {
    const matched = [], mismatches = [], foreign = [];
    const keys = newFolderKeys instanceof Set ? newFolderKeys : new Set(newFolderKeys || []);
    (refs || []).forEach(ref => {
      const p = ref ? parseSensorRef(ref) : null;
      if (!p || p.scope === SCOPE_GLOBAL) return;
      if (p.scope !== oldTsId) { foreign.push(ref); return; }
      if (newTsId != null && keys.has(p.folderKey)) matched.push({ from: ref, to: sensorRef(newTsId, p.folderKey) });
      else mismatches.push({ ref, codename: `Sensor folder: ${p.folderKey}` });
    });
    return { matched, mismatches, foreign };
  };

  // Saved map load: where does an s: ref that is not among the loaded tiles go? -> a ref in the active tileset, or null.
  const resolveLoadedSensorRef = (ref, activeTsId, activeFolderKeys) => {
    const p = parseSensorRef(ref);
    if (!p || p.scope === SCOPE_GLOBAL || activeTsId == null) return null;
    return (activeFolderKeys instanceof Set ? activeFolderKeys : new Set(activeFolderKeys || [])).has(p.folderKey) ? sensorRef(activeTsId, p.folderKey) : null;
  };

  return {
    SCOPE_GLOBAL, GROUP_COLUMNS, DIVERGENCE_FIELDS,
    sensorRef, parseSensorRef, isSensorRef,
    parseCodeInput, parseRollInput, codeFieldState, codeGridCells, toggleCodeBit, normalisedHint, parseSymbolInput, usedSymbols, suggestSymbol,
    splitGroupPatch, divergence, makeFolder, engineFolder,
    variantOwners, hideSensorVariants, canonicalRef, canonicalRefs, folderPreviewTiles,
    deriveLayer, opsToCss, opsLabel, composePlan, composeKey,
    planSensorSwitch, resolveLoadedSensorRef,
  };
});
