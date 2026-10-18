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

  // Symbol field: "" -> null; otherwise the last typed code point. 'A' (warn tile) and 'S' (space tile) are reserved for the special tiles.
  const parseSymbolInput = text => {
    const ch = [...String(text == null ? "" : text).trim()].slice(-1)[0];
    if (ch === undefined) return { ok: true, value: null };
    if (TilePalette.isReservedSymbol(ch)) return { ok: false, value: null, error: `'${ch}' is reserved for the ${ch === TilePalette.SYMBOL_WARN ? "warn" : "space"} tile.` };
    return { ok: true, value: ch };
  };
  // Symbols already used by a tileset's tiles / folders (for suggestions): array of single characters.
  const usedSymbols = tiles => (tiles || []).map(t => t && t.symbol).filter(Boolean);
  const suggestSymbol = (tiles, alsoTaken) => TilePalette.suggestSymbol(usedSymbols(tiles), alsoTaken);

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
  // Only the symbol is shared by every row of a (tileset, folder_key) sensor group. Size, offsets and all flags (priority, bottom_render,
  // auto_shadow, otg_passable, mirror_offset, rotatable, flippable) belong to each variant.
  const GROUP_COLUMNS = ["symbol"];
  const splitGroupPatch = patch => {
    const group = {}, own = {};
    for (const k of Object.keys(patch || {})) (GROUP_COLUMNS.includes(k) ? group : own)[k] = patch[k];
    return { group, own };
  };

  // ── Folders ───────────────────────────────────────────────────────────────────────────────────────────
  const cmpSort = (a, b) => ((a.sortIndex ?? 0) - (b.sortIndex ?? 0)) || String(a.ref).localeCompare(String(b.ref));
  // Fields compared for the folder's ⚖️ button. sensor_code, image, codename, sort index, sensor_roll and filename never count.
  // Only a symbol mismatch is a real warning (it is the one group-synced field); flags, size and offsets are per variant by design,
  // so their differences are informational.
  const DIVERGENCE_FIELDS = [
    ["symbol", "Symbol", "warning"],
    ["dbBottomRender", "Bottom render", "info"], ["dbPriority", "Priority", "info"], ["dbAutoShadow", "Auto shadow", "info"], ["dbOtgPassable", "OTG passable", "info"],
    ["dbRotatable", "Rotatable", "info"], ["dbFlippable", "Flippable", "info"], ["dbMirrorOffset", "Mirror offset", "info"],
    ["dbSizeMultiplier", "Size", "info"], ["dbOffsetX", "Offset X", "info"], ["dbOffsetY", "Offset Y", "info"],
  ];
  const DIVERGENCE_NOTE = "If these differences are intended, you can ignore this.";
  // DB numerics can arrive as strings ("1.5"); compare them as numbers.
  const norm = v => (v == null ? null : (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) ? Number(v) : v);
  // -> [{ field, label, level: "warning"|"info", values: [{ value, tiles: [name] }] }] for fields where the labelled variants disagree.
  const divergence = tiles => {
    const out = [];
    const list = tiles.filter(t => Sensor.isCode(t.sensorCode));
    if (list.length < 2) return out;
    for (const [field, label, level] of DIVERGENCE_FIELDS) {
      const groups = new Map();
      for (const t of list) {
        const v = norm(t[field]);
        const k = JSON.stringify(v);
        if (!groups.has(k)) groups.set(k, { value: v, tiles: [] });
        groups.get(k).tiles.push(t.codename || t.sensorCode || t.ref);
      }
      if (groups.size > 1) out.push({ field, label, level, values: [...groups.values()] });
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

  // ── Global (manifest) sensor folders ──────────────────────────────────────────────────────────────────
  // cfg is the manifest's sensor block: { codes, names?, order?, spin, flip, symbol }. Files in `order` come first (in that order), the rest
  // keep manifest order. A file's explicit name (cfg.names) wins; null means "no explicit name" (caller falls back).
  const globalFolderFiles = (files, cfg) => {
    const order = cfg && Array.isArray(cfg.order) ? cfg.order : null;
    if (!order) return files.slice();
    return [...order.filter(f => files.includes(f)), ...files.filter(f => !order.includes(f))];
  };
  const globalFileName = (file, cfg) => (cfg && cfg.names && cfg.names[file]) || null;

  // ── Image preloading (loading overlay) ────────────────────────────────────────────────────────────────
  // load(url, cb): starts loading and calls cb(ok) once, synchronously when the image is already cached. -> { total, done, failed,
  // isDone(), promise }. isDone() is true right after the call when everything was cached, so callers can skip any overlay.
  const preloadImages = (urls, load, onProgress) => {
    const list = Array.from(new Set((urls || []).filter(Boolean)));
    const job = { total: list.length, done: 0, failed: 0, finished: false, isDone: () => job.finished };
    let resolveFn;
    job.promise = new Promise(r => { resolveFn = r; });
    const finishIfDone = () => { if (!job.finished && job.done >= job.total) { job.finished = true; resolveFn({ total: job.total, failed: job.failed }); } };
    list.forEach(url => {
      let called = false;
      load(url, ok => {
        if (called) return;
        called = true;
        job.done++;
        if (!ok) job.failed++;
        if (onProgress) onProgress(job.done, job.total);
        finishIfDone();
      });
    });
    finishIfDone();
    return job;
  };
  // "Loading tiles 12/30"
  const progressLabel = (label, done, total) => (total > 0 ? `${label} ${done}/${total}` : label);

  // ── Image spin / flip (tile modal) ────────────────────────────────────────────────────────────────────
  // ops: "rotL" | "rotR" | "flipH" | "flipV", applied to the image in order. -> { width, height, matrix: [a, b, c, d, e, f] } for
  // ctx.setTransform(...matrix) followed by ctx.drawImage(img, 0, 0): x' = a x + c y + e, y' = b x + d y + f. A quarter turn swaps width and height.
  const mul = (m, n) => [ // m after n
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
  const imageOps = (ops, w, h) => {
    let m = [1, 0, 0, 1, 0, 0], cw = w, ch = h;
    for (const op of ops || []) {
      let step, nw = cw, nh = ch;
      if (op === "rotR") { step = [0, 1, -1, 0, ch, 0]; nw = ch; nh = cw; }
      else if (op === "rotL") { step = [0, -1, 1, 0, 0, cw]; nw = ch; nh = cw; }
      else if (op === "flipH") step = [-1, 0, 0, 1, cw, 0];
      else if (op === "flipV") step = [1, 0, 0, -1, 0, ch];
      else continue;
      m = mul(step, m); cw = nw; ch = nh;
    }
    return { width: cw, height: ch, matrix: m };
  };
  // Cache-busted link for a repo file: the same URL with a fresh ?v=.
  const withFreshVersion = (url, v) => String(url).split("?")[0] + "?v=" + v;

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
  // rerolls: Map | object of sensorRef -> integer reroll seed (missing = 0). The one seed map the screen and Download Map both read.
  const rerollOf = (rerolls, ref) => { const v = rerolls ? (typeof rerolls.get === "function" ? rerolls.get(ref) : rerolls[ref]) : 0; return Number.isFinite(v) ? v | 0 : 0; };
  const deriveLayer = ({ grid, refs, folders, rerolls }) => {
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
        const res = Sensor.resolve(f.folder, nb, { x: c, y: r, salt: ref, reroll: rerollOf(rerolls, ref), candidates: f.candidates });
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
  // "flip", "spin 2", "flip, spin 1" or "no transform" (flip happens first, then the spin).
  const transformLabel = (flip, steps) => [flip && "flip", steps && `spin ${steps}`].filter(Boolean).join(", ") || "no transform";
  // Breakdown of a composed variant, one line per quadrant (TL TR BR BL): "TL <- 01101011 (Water_01101011) (flip)".
  // nameOf(ref) -> tile name (falls back to the ref). -> [{ quadrant, label, text }]
  const recipeLines = (recipe, nameOf) => (recipe || []).map(e => ({
    quadrant: e.quadrant, label: e.quadrantName,
    text: `${e.quadrantName} <- ${e.sourceCode} (${(nameOf && nameOf(e.sourceTileRef)) ?? e.sourceTileRef}) (${transformLabel(e.flip, e.spinSteps)})`,
  }));
  const FALLBACK_LABEL = "Fallback tile: used whenever no tile matches the exact shape.";

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

  // ── Plain <-> sensor folder resolution (tileset switch, saved map load) ──────────────────────────────
  // A palette entry of one tileset finds its stand-in in another, across the plain / sensor divide:
  //   plain tile    -> 1. a plain tile with the same codename   2. a sensor folder whose folder key equals the codename   3. the same symbol
  //   sensor folder -> 1. a sensor folder with the same key     2. a plain tile whose codename equals the folder key       3. the same symbol
  // Only when all three fail is the entry a mismatch (the compat modal). "Same symbol" picks the lowest sortIndex (then ref).
  // rows are DB rows { id, codename, folder_key, sensor_code, symbol, sort_index }. A sensor folder = rows sharing a folder_key where at least one
  // has a sensor_code; its rows with a code are the folder, its rows without one are plain (unlabelled) tiles.
  const groupRows = (rows, tsId) => {
    const list = (rows || []).slice().sort((a, b) => ((a.sort_index ?? 0) - (b.sort_index ?? 0)) || String(a.id).localeCompare(String(b.id)));
    const sensorKeys = new Set(list.filter(r => r.folder_key && Sensor.isCode(r.sensor_code)).map(r => r.folder_key));
    const plain = [], folders = new Map();
    for (const r of list) {
      if (r.folder_key && sensorKeys.has(r.folder_key) && Sensor.isCode(r.sensor_code)) {
        if (!folders.has(r.folder_key)) folders.set(r.folder_key, { ref: sensorRef(tsId, r.folder_key), folderKey: r.folder_key, symbol: r.symbol ?? null, sortIndex: r.sort_index ?? 0 });
        const f = folders.get(r.folder_key);
        if (f.symbol == null && r.symbol != null) f.symbol = r.symbol;
        f.sortIndex = Math.min(f.sortIndex, r.sort_index ?? 0);
      } else plain.push({ ref: TilePalette.makeRef("d", r.id), codename: r.codename ?? null, symbol: r.symbol ?? null, sortIndex: r.sort_index ?? 0 });
    }
    return { plain, folders: [...folders.values()] };
  };
  const targetIndex = (rows, tsId) => {
    const g = groupRows(rows, tsId);
    const bySymbol = new Map();
    [...g.plain, ...g.folders].forEach(e => { if (e.symbol) { if (!bySymbol.has(e.symbol)) bySymbol.set(e.symbol, []); bySymbol.get(e.symbol).push(e); } });
    bySymbol.forEach(list => list.sort((a, b) => (a.sortIndex - b.sortIndex) || String(a.ref).localeCompare(String(b.ref))));
    return {
      plainByName: new Map(g.plain.filter(e => e.codename).map(e => [e.codename, e])),
      folderByKey: new Map(g.folders.map(e => [e.folderKey, e])),
      bySymbol,
    };
  };
  // source: { kind: "plain", codename, symbol } | { kind: "sensor", folderKey, symbol }; index = targetIndex(...) -> a ref or null.
  const resolveAcross = (source, index) => {
    if (!source || !index) return null;
    const name = source.kind === "sensor" ? source.folderKey : source.codename;
    const first = source.kind === "sensor" ? index.folderByKey : index.plainByName, second = source.kind === "sensor" ? index.plainByName : index.folderByKey;
    if (name != null) {
      if (first.has(name)) return first.get(name).ref;
      if (second.has(name)) return second.get(name).ref;
    }
    const bySym = source.symbol ? index.bySymbol.get(source.symbol) : null;
    return bySym && bySym.length ? bySym[0].ref : null;
  };
  // The whole palette: d: entries of the outgoing tileset and its s: entries. Shape as TilePalette.planSwitch / planSensorSwitch:
  // { matched: [{from, to}], mismatches: [{ref, codename}], foreign: [ref] }. Global s: / g: / u: entries are left alone; an entry that
  // belongs to any other tileset is foreign.
  const planSwitchResolved = ({ refs, oldRows, oldTsId, newRows, newTsId }) => {
    const matched = [], mismatches = [], foreign = [];
    const oldByUuid = new Map((oldRows || []).map(r => [r.id, r]));
    const oldGroups = groupRows(oldRows, oldTsId);
    const oldFolders = new Map(oldGroups.folders.map(f => [f.folderKey, f]));
    const idx = newTsId != null ? targetIndex(newRows, newTsId) : null;
    (refs || []).forEach(ref => {
      if (!ref) return;
      const sp = parseSensorRef(ref);
      if (sp) {
        if (sp.scope === SCOPE_GLOBAL) return;
        if (sp.scope !== oldTsId) { foreign.push(ref); return; }
        const f = oldFolders.get(sp.folderKey);
        const to = resolveAcross({ kind: "sensor", folderKey: sp.folderKey, symbol: f ? f.symbol : null }, idx);
        if (to) matched.push({ from: ref, to }); else mismatches.push({ ref, codename: `Sensor folder: ${sp.folderKey}` });
        return;
      }
      const p = TilePalette.parseRef(ref);
      if (!p || p.kind !== "d") return;
      const row = oldByUuid.get(p.key);
      if (!row) { foreign.push(ref); return; }
      const to = resolveAcross({ kind: "plain", codename: row.codename ?? null, symbol: row.symbol ?? null }, idx);
      if (to) matched.push({ from: ref, to }); else mismatches.push({ ref, codename: row.codename ?? null });
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
    SCOPE_GLOBAL, GROUP_COLUMNS, DIVERGENCE_FIELDS, DIVERGENCE_NOTE,
    sensorRef, parseSensorRef, isSensorRef,
    parseCodeInput, parseRollInput, codeFieldState, codeGridCells, toggleCodeBit, normalisedHint, parseSymbolInput, usedSymbols, suggestSymbol,
    splitGroupPatch, divergence, makeFolder, engineFolder,
    globalFolderFiles, globalFileName,
    preloadImages, progressLabel, imageOps, withFreshVersion,
    variantOwners, hideSensorVariants, canonicalRef, canonicalRefs, folderPreviewTiles,
    deriveLayer, rerollOf, opsToCss, opsLabel, composePlan, composeKey, transformLabel, recipeLines, FALLBACK_LABEL,
    planSensorSwitch, resolveLoadedSensorRef, groupRows, targetIndex, resolveAcross, planSwitchResolved,
  };
});
