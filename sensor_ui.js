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
    if (TilePalette.isBannedSymbol(ch)) return { ok: false, value: null, error: ch === "," || ch === "/" || ch === "." || ch === "?" ? `'${ch}' cannot be a tile symbol (seeds use it as a separator or selector marker).` : "That character cannot be a tile symbol." };
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
      // tieBreak / reroll come from the manifest block of a global folder (cfg): see sensor.js (tieBreakOf, isRerollable)
      settings: { spin: cfg ? !!cfg.spin : !!first.dbRotatable, flip: cfg ? !!cfg.flip : !!first.dbFlippable,
        ...(cfg && Array.isArray(cfg.tieBreak) ? { tieBreak: cfg.tieBreak.slice() } : {}), ...(cfg && cfg.reroll === false ? { reroll: false } : {}) },
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
  // deterministic: Map | object of sensorRef -> true (reroll mode OFF: ties resolve without the hash); picks: Map | object of sensorRef -> { code: tile ref }
  // (the "Choose variants" picks). Both are session state of the screen, never part of a map or a seed.
  const lookup = (m, ref) => (m ? (typeof m.get === "function" ? m.get(ref) : m[ref]) : undefined);
  const deriveLayer = ({ grid, refs, folders, rerolls, deterministic, picks }) => {
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
        const res = Sensor.resolve(f.folder, nb, { x: c, y: r, salt: ref, reroll: rerollOf(rerolls, ref), candidates: f.candidates, deterministic: !!lookup(deterministic, ref), picks: lookup(picks, ref) });
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
  // Quadrant geometry, shared by sources, targets and every consumer (canvas composition, simulator highlight, tileset export).
  // topEdge = the highest pixel row with a visible (alpha > 0) pixel over all tiles of the sensor folder (see topEdgeOfPixels). The
  // vertical seam is x = w/2, the horizontal one y = min(h, topEdge + w/2): the seam sits at the centre of the art, which is as wide as the
  // image and sits at the bottom of a taller one. TL / TR start at row 0 (transparent rows above the art included), BL / BR run to the very
  // bottom. topEdge null / undefined (not computable) = the old centred layout (y = h/2); for a square image with no margin both agree.
  const quadrantGeometry = (w, h, topEdge) => {
    const sx = w / 2, sy = Number.isFinite(topEdge) ? Math.min(h, Math.max(0, topEdge) + w / 2) : h / 2;
    return { sx, sy, rects: [{ x: 0, y: 0, w: sx, h: sy }, { x: sx, y: 0, w: w - sx, h: sy }, { x: sx, y: sy, w: w - sx, h: h - sy }, { x: 0, y: sy, w: sx, h: h - sy }] }; // TL TR BR BL
  };
  // Highest row with alpha > 0 in RGBA pixels (w x h), or null when the image is fully transparent.
  const topEdgeOfPixels = (w, h, px) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (px[(y * w + x) * 4 + 3] > 0) return y;
    return null;
  };
  // Shared top edge of a folder: the minimum over its tiles' top edges (nulls ignored); null when no tile has a visible pixel.
  const folderTopEdge = edges => { const v = (edges || []).filter(Number.isFinite); return v.length ? Math.min(...v) : null; };
  // Cache key of a folder's top edge: its tiles' image URLs (they carry ?v=, so a new upload invalidates it).
  const topEdgeKey = (folderRef, urls) => `${folderRef}|${(urls || []).slice().sort().join(",")}`;
  // For each quadrant of a w x h target: the clip rect (x, y, w, h), the target seam (tx, ty) and the source tile to draw. The source is
  // mirrored left-right first when `flip`, then rotated clockwise by `steps` quarter-turns about ITS seam (sx, sy; from sizeOf(ref) -> { w, h },
  // default the target's size) and placed about the target seam, so source quadrant sq lands on quadrant q. The same topEdge applies to both.
  const composePlan = (recipe, w, h, topEdge, sizeOf) => {
    const t = quadrantGeometry(w, h, topEdge);
    return (recipe || []).map(e => {
      const sz = (sizeOf && sizeOf(e.sourceTileRef)) || { w, h }, s = quadrantGeometry(sz.w, sz.h, topEdge);
      const r = t.rects[e.quadrant];
      return { quadrant: e.quadrant, x: r.x, y: r.y, w: r.w, h: r.h, tx: t.sx, ty: t.sy, sx: s.sx, sy: s.sy, sourceTileRef: e.sourceTileRef, steps: e.spinSteps, flip: !!e.flip };
    });
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

  // ── Duplicate tile ────────────────────────────────────────────────────────────────────────────────────
  // The copy of a DB tile joins the original's sensor pool (same folder_key and sensor_code) and keeps its flags, size, offsets and symbol.
  const DUPLICATE_COLUMNS = ["folder_key", "sensor_code", "sensor_roll", "rotatable", "flippable", "otg_passable", "mirror_offset", "bottom_render", "priority", "auto_shadow", "size_multiplier", "offset_x", "offset_y", "symbol"];
  // "<name>_copy", else "<name>_copy2", "_copy3" ... (taken: Set of the tileset's codenames).
  const duplicateCodename = (codename, taken) => {
    const base = `${codename}_copy`;
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base}${n}`)) return `${base}${n}`;
  };
  // 1 + the highest sort_index of the tileset (0 for an empty one).
  const nextSortIndex = rows => (rows || []).reduce((m, r) => Math.max(m, Number(r.sort_index) || 0), -1) + 1;
  // Body of the INSERT for the copy: the original's DUPLICATE_COLUMNS (null kept as null), a NEW codename, image_url and sort_index.
  const duplicateRowBody = ({ row, tilesetId, codename, imageUrl, sortIndex }) => {
    const body = { tileset_id: tilesetId, codename, image_url: imageUrl, sort_index: sortIndex };
    for (const k of DUPLICATE_COLUMNS) if (row[k] !== undefined) body[k] = row[k];
    return body;
  };
  // Local uploads are kept in localStorage, so a copy is scaled down to fit this many px on its longer side.
  const LOCAL_UPLOAD_MAX_PX = 256;
  const localCopySize = (w, h) => { const k = Math.min(1, LOCAL_UPLOAD_MAX_PX / Math.max(w, h, 1)); return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) }; };

  // ── Panel order ───────────────────────────────────────────────────────────────────────────────────────
  // Plain tiles and folders are listed TOGETHER by lowest sortIndex (a folder's is the lowest of its tiles). Ties: plain tile first, then
  // folder, then name. entries: { type: "flat", tile } | { type: "folder", label, tiles }. -> a new sorted array.
  const entrySortIndex = e => (e.type === "flat" ? (e.tile && e.tile.sortIndex) ?? 0 : Math.min(...((e.tiles || []).map(t => t.sortIndex ?? 0)), Infinity));
  const entryName = e => String(e.type === "flat" ? ((e.tile && (e.tile.codename ?? e.tile.label)) ?? "") : (e.label ?? ""));
  const orderEntries = entries => (entries || []).map((e, i) => ({ e, i, k: entrySortIndex(e) }))
    .sort((a, b) => ((a.k === Infinity ? 1e15 : a.k) - (b.k === Infinity ? 1e15 : b.k)) || ((a.e.type === "flat" ? 0 : 1) - (b.e.type === "flat" ? 0 : 1)) || entryName(a.e).localeCompare(entryName(b.e)) || (a.i - b.i))
    .map(x => x.e);

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

  // ── Tileset export (zip) ──────────────────────────────────────────────────────────────────────────────
  // Pure parts of "Export tileset (zip)": a store-only zip writer, file naming, the plan of what to export and the offset / shadow bake
  // geometry. The canvas and fetch side lives in index.html. Nothing here reads or writes the database.
  const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = bytes => { let c = 0xffffffff; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const utf8 = str => (typeof TextEncoder !== "undefined" ? new TextEncoder().encode(str) : Uint8Array.from(Buffer.from(str, "utf8")));
  // files: [{ name ("/" separated, no leading slash), data: Uint8Array }] -> Uint8Array holding a valid .zip (method 0 = stored, UTF-8 names).
  const zipStore = files => {
    const DOS_TIME = 0, DOS_DATE = (1 << 5) | 1 | ((2024 - 1980) << 9); // 2024-01-01 00:00: the export is reproducible
    const parts = [], central = [];
    let offset = 0;
    const u16 = n => [n & 0xff, (n >>> 8) & 0xff], u32 = n => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
    for (const f of files) {
      const name = utf8(f.name), data = f.data, crc = crc32(data);
      if (data.length >= 0xffffffff || offset >= 0xffffffff || files.length >= 0xffff) throw new Error("zip too large for this writer");
      const local = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, ...u16(20), ...u16(0x0800), ...u16(0), ...u16(DOS_TIME), ...u16(DOS_DATE), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0)]);
      parts.push(local, name, data);
      central.push(Uint8Array.from([0x50, 0x4b, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(DOS_TIME), ...u16(DOS_DATE), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]), name);
      offset += local.length + name.length + data.length;
    }
    const cdSize = central.reduce((n, a) => n + a.length, 0);
    const end = Uint8Array.from([0x50, 0x4b, 0x05, 0x06, ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(offset), ...u16(0)]);
    const all = [...parts, ...central, end], out = new Uint8Array(all.reduce((n, a) => n + a.length, 0));
    let at = 0;
    for (const a of all) { out.set(a, at); at += a.length; }
    return out;
  };
  // A file / folder name that is safe in a zip on every platform.
  const safeName = (s, fallback = "tile") => (String(s == null ? "" : s).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^\.+/, "_").trim() || fallback);
  // name.ext unique among `taken` (case-insensitive Set of full lower-cased paths): name_2.ext, name_3.ext ... The result is added to `taken`.
  const uniquePath = (taken, dir, base, ext) => {
    let n = 1, path;
    do { path = `${dir ? dir + "/" : ""}${base}${n > 1 ? "_" + n : ""}${ext}`; n++; } while (taken.has(path.toLowerCase()));
    taken.add(path.toLowerCase());
    return path;
  };
  const extOfUrl = url => { const m = /\.([a-z0-9]{2,5})$/i.exec(String(url == null ? "" : url).split("?")[0]); return m ? "." + m[1].toLowerCase() : ".png"; };
  // DB offsets: both components set -> numbers, otherwise 0,0 (the app's rule for DB tiles). Percent of a cell.
  const rowOffset = row => (row && row.offset_x != null && row.offset_y != null ? { ox: Number(row.offset_x) || 0, oy: Number(row.offset_y) || 0 } : { ox: 0, oy: 0 });
  const SHADOW_ALPHA = 0.2, SHADOW_SHIFT = 0.3; // the app's auto shadow: a black copy at 20% opacity, 30% of a cell down
  // Geometry of a baked image. The cell is the image's own size (multiplier 1 is NOT changed or applied); offsets are percent of the cell and the image is
  // centred on the cell. The canvas stays centred on the cell, so the transparent padding goes on the side OPPOSITE to each offset
  // (offset right -> padding on the left). -> { width, height, image: { x, y }, shadow: { x, y } | null, padding: { left, right, top, bottom } }
  const bakeLayout = ({ w, h, ox = 0, oy = 0, bakeOffset = false, bakeShadow = false }) => {
    const dx = bakeOffset ? Math.round((ox / 100) * w) : 0, dy = bakeOffset ? Math.round((oy / 100) * h) : 0;
    const sy = bakeShadow ? Math.round(SHADOW_SHIFT * h) : 0;
    // extents of the content relative to the cell centre
    const left = Math.min(dx - w / 2, bakeShadow ? dx - w / 2 : Infinity), right = Math.max(dx + w / 2, bakeShadow ? dx + w / 2 : -Infinity);
    const top = Math.min(dy - h / 2, bakeShadow ? dy + sy - h / 2 : Infinity), bottom = Math.max(dy + h / 2, bakeShadow ? dy + sy + h / 2 : -Infinity);
    const hx = Math.ceil(Math.max(-left, right)), hy = Math.ceil(Math.max(-top, bottom));
    const width = 2 * hx, height = 2 * hy;
    const image = { x: hx + dx - w / 2, y: hy + dy - h / 2 };
    return { width, height, image, shadow: bakeShadow ? { x: image.x, y: image.y + sy } : null,
      padding: { left: image.x, right: width - image.x - w, top: Math.min(image.y, bakeShadow ? image.y + sy : image.y), bottom: height - image.y - h - (bakeShadow ? sy : 0) } };
  };
  const hasOffset = row => { const o = rowOffset(row); return o.ox !== 0 || o.oy !== 0; };
  // rows: DB tile rows { id, codename, image_url, folder_key, sensor_code, sensor_roll, sort_index, symbol, offset_x, offset_y, size_multiplier, rotatable, flippable, ... }.
  // -> { dir, items: [{ kind: "real"|"derived"|"composed", path, file, folder, code, row (metadata source), sourceRows: [row], ops, recipe, roll }] }
  // Every row is exported as itself ("real"); a sensor folder additionally gets every derived (spin / flip) and composed variant the engine builds for it,
  // named <Folder>_<code>[_n] like the real ones. Plain tiles keep their codename. Exact-mode folders add nothing derived or composed.
  const planTilesetExport = (rows, tilesetName) => {
    const dir = safeName(tilesetName, "tileset");
    const list = (rows || []).slice().sort((a, b) => ((a.sort_index ?? 0) - (b.sort_index ?? 0)) || String(a.id).localeCompare(String(b.id)));
    const taken = new Set(), items = [];
    const sensorKeys = new Set(list.filter(r => r.folder_key && Sensor.isCode(r.sensor_code)).map(r => r.folder_key));
    const dirOf = r => (r.folder_key ? `${dir}/${safeName(r.folder_key)}` : dir);
    const folderRows = new Map();
    for (const r of list) {
      if (r.folder_key && sensorKeys.has(r.folder_key) && Sensor.isCode(r.sensor_code)) {
        if (!folderRows.has(r.folder_key)) folderRows.set(r.folder_key, []);
        folderRows.get(r.folder_key).push(r);
        continue;
      }
      const d = dirOf(r), path = uniquePath(taken, d, safeName(r.codename, "tile"), extOfUrl(r.image_url));
      items.push({ kind: "real", path, file: path.slice(d.length + 1), folder: r.folder_key || null, code: r.sensor_code ?? null, row: r, sourceRows: [r], ops: [], recipe: null, roll: r.sensor_roll ?? null });
    }
    for (const [key, group] of folderRows) {
      const d = `${dir}/${safeName(key)}`, base = safeName(key, "folder");
      for (const r of group) {
        const path = uniquePath(taken, d, `${base}_${r.sensor_code}`, extOfUrl(r.image_url));
        items.push({ kind: "real", path, file: path.slice(d.length + 1), folder: key, code: r.sensor_code, row: r, sourceRows: [r], ops: [], recipe: null, roll: r.sensor_roll ?? null });
      }
      const byId = new Map(group.map(r => [String(r.id), r]));
      const tiles = group.map(r => ({ ref: r.id, codename: r.codename, sensorCode: r.sensor_code, sensorRoll: r.sensor_roll ?? 1, sortIndex: r.sort_index ?? 0, symbol: r.symbol ?? null, dbRotatable: r.rotatable, dbFlippable: r.flippable, src: r.image_url }));
      const folder = makeFolder({ scope: "export", folderKey: key, label: key, tiles });
      if (!folder) continue;
      const cands = Sensor.buildCandidates(engineFolder(folder));
      for (const code of Sensor.ALL_CODES) {
        const c = cands[code];
        if (c.status === "derived") {
          for (const e of c.pool) {
            const src = byId.get(String(e.derivedFrom.ref)), path = uniquePath(taken, d, `${base}_${code}`, ".png");
            items.push({ kind: "derived", path, file: path.slice(d.length + 1), folder: key, code, row: src, sourceRows: [src], ops: e.ops.slice(), recipe: null, roll: e.roll });
          }
        } else if (c.status === "composed") {
          const rec = c.recipe, major = byId.get(String(rec.majorityRef)), path = uniquePath(taken, d, `${base}_${code}`, ".png");
          const refs = Array.from(new Set(rec.map(q => String(q.sourceTileRef))));
          items.push({ kind: "composed", path, file: path.slice(d.length + 1), folder: key, code, row: major, sourceRows: refs.map(x => byId.get(x)), ops: [], recipe: rec.map(q => ({ quadrant: q.quadrant, sourceTileRef: String(q.sourceTileRef), spinSteps: q.spinSteps, flip: !!q.flip })), roll: 1 });
        }
      }
    }
    return { dir, items };
  };
  // Image ops of a derived entry as imageOps() names: engine "spin" = clockwise 90 (rotR), "flipH" = mirror (flipH).
  const exportImageOps = ops => (ops || []).map(o => (o === "spin" ? "rotR" : "flipH"));
  // One tiles.json record. Sizes are recorded, never applied.
  const exportRecord = (item, bake) => {
    const r = item.row || {}, o = rowOffset(r);
    return {
      codename: item.kind === "real" ? (r.codename ?? null) : `${item.folder}_${item.code}`, folder: item.folder, file: item.path, kind: item.kind,
      sensorCode: item.code, sensorRoll: item.roll, symbol: r.symbol ?? null, offsetX: o.ox, offsetY: o.oy, sizeMultiplier: r.size_multiplier ?? null, sizeApplied: false,
      flags: { rotatable: !!r.rotatable, flippable: !!r.flippable, otgPassable: !!r.otg_passable, mirrorOffset: !!r.mirror_offset, bottomRender: !!r.bottom_render, priority: !!r.priority, autoShadow: !!r.auto_shadow },
      bakedOffsets: !!(bake && bake.offsets), bakedShadow: !!(bake && bake.shadow),
      sourceCodenames: item.kind === "real" ? undefined : (item.sourceRows || []).map(x => x && x.codename),
    };
  };

  return {
    SCOPE_GLOBAL, GROUP_COLUMNS, DIVERGENCE_FIELDS, DIVERGENCE_NOTE,
    sensorRef, parseSensorRef, isSensorRef,
    parseCodeInput, parseRollInput, codeFieldState, codeGridCells, toggleCodeBit, normalisedHint, parseSymbolInput, usedSymbols, suggestSymbol,
    splitGroupPatch, divergence, makeFolder, engineFolder,
    globalFolderFiles, globalFileName,
    preloadImages, progressLabel, imageOps, withFreshVersion,
    variantOwners, hideSensorVariants, canonicalRef, canonicalRefs, folderPreviewTiles,
    deriveLayer, rerollOf, opsToCss, opsLabel, composePlan, quadrantGeometry, topEdgeOfPixels, folderTopEdge, topEdgeKey, composeKey, transformLabel, recipeLines, FALLBACK_LABEL,
    planSensorSwitch, resolveLoadedSensorRef, groupRows, targetIndex, resolveAcross, planSwitchResolved, orderEntries, DUPLICATE_COLUMNS, duplicateCodename, nextSortIndex, duplicateRowBody, LOCAL_UPLOAD_MAX_PX, localCopySize,
    crc32, zipStore, safeName, uniquePath, extOfUrl, rowOffset, hasOffset, SHADOW_ALPHA, SHADOW_SHIFT, bakeLayout, planTilesetExport, exportImageOps, exportRecord,
  };
});
