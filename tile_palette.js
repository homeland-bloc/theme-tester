// Tile palette: a per-map table that turns stable tile references into small grid indexes.
//
// A ref is a tagged string "<kind>:<key>":
//   d:<uuid>               DB tile (tiles.id)
//   g:<Resources path>     global tile from Resources/manifest.json
//   u:<n>                  local upload (n = persisted monotonic counter)
//   s:<tilesetId>|<folder> sensor folder (RESERVED: nothing resolves it yet)
// plus the two special tiles, which are bare strings: "space" and "warn".
//
// A palette is { refs: (string|null)[] }. A cell holds an index into refs (or null for empty).
// A null entry is a free slot: indexes of other entries never change until compactForExport.
//
// Plain JS, no dependencies. Loaded with a <script> tag in the browser (window.TilePalette) and
// with require() from node (tests/palette.test.js).
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.TilePalette = api;
})(typeof self !== "undefined" ? self : this, function () {
  const KINDS = ["d", "g", "u", "s"];
  const SPACE_REF = "space";
  const WARN_REF = "warn";
  const STORAGE_VERSION = 2;

  const makeRef = (kind, key) => {
    if (kind === "x") return String(key); // special tiles: "space" / "warn"
    if (!KINDS.includes(kind)) throw new Error("unknown ref kind: " + kind);
    return kind + ":" + key;
  };

  // -> { kind, key } or null. Specials come back as kind "x".
  const parseRef = ref => {
    if (typeof ref !== "string" || !ref) return null;
    if (ref === SPACE_REF || ref === WARN_REF) return { kind: "x", key: ref };
    const i = ref.indexOf(":");
    if (i !== 1) return null;
    const kind = ref[0];
    if (!KINDS.includes(kind)) return null;
    const key = ref.slice(2);
    if (!key) return null;
    return { kind, key };
  };

  const isRef = ref => parseRef(ref) !== null;
  const refKind = ref => parseRef(ref)?.kind ?? null;

  const createPalette = () => ({ refs: [] });
  const clonePalette = palette => ({ refs: palette.refs.slice() });

  const indexOfRef = (palette, ref) => palette.refs.indexOf(ref);

  // Index of ref; appended on first use. Existing indexes never move.
  const paletteIndexFor = (palette, ref) => {
    if (!isRef(ref)) throw new Error("not a ref: " + ref);
    const i = palette.refs.indexOf(ref);
    if (i !== -1) return i;
    palette.refs.push(ref);
    return palette.refs.length - 1;
  };

  // Ref at index, or null for a free / out-of-range slot.
  const refAt = (palette, index) => (index == null ? null : (palette.refs[index] ?? null));

  const usedIndexes = grid => {
    const used = new Set();
    for (const row of grid) for (const c of row) if (c != null) used.add(c);
    return used;
  };

  // Entries no cell points at become free slots (null). Returns a new palette; indexes of the rest stay put.
  const removeUnused = (palette, grid) => {
    const used = usedIndexes(grid);
    return { refs: palette.refs.map((r, i) => (used.has(i) ? r : null)) };
  };

  // Renumber for storage: drop free/unused entries, keep order. Returns { refs, grid } (0-based, no gaps).
  const compactForExport = (palette, grid) => {
    const used = usedIndexes(grid);
    const newIndex = new Map();
    const refs = [];
    palette.refs.forEach((r, i) => {
      if (r != null && used.has(i)) { newIndex.set(i, refs.length); refs.push(r); }
    });
    return {
      refs,
      grid: grid.map(row => row.map(c => (c == null ? null : (newIndex.has(c) ? newIndex.get(c) : null)))),
    };
  };

  // Rewrite the entry for fromRef to toRef. If toRef already has an entry the two are merged by rewriting
  // cells (from's slot becomes free). Returns { palette, grid, merged }; grid is only copied when merged.
  const remapEntry = (palette, fromRef, toRef, grid) => {
    const from = palette.refs.indexOf(fromRef);
    if (from === -1 || fromRef === toRef) return { palette, grid, merged: false };
    const to = palette.refs.indexOf(toRef);
    const refs = palette.refs.slice();
    if (to === -1) {
      refs[from] = toRef;
      return { palette: { refs }, grid, merged: false };
    }
    refs[from] = null;
    const newGrid = grid ? grid.map(row => row.map(c => (c === from ? to : c))) : grid;
    return { palette: { refs }, grid: newGrid, merged: true };
  };

  // ── Counting ──────────────────────────────────────────────────────────
  // -> [{ ref, count }] for every entry used on the map, highest count first (ties keep palette order). Empty cells and free
  // slots are not counted; special tiles (space / warn) are entries like any other. A sensor folder is one entry (cells hold its s: ref).
  const countRefs = (palette, grid) => {
    const counts = new Map();
    for (const row of grid) for (const c of row) {
      if (c == null) continue;
      const ref = palette.refs[c];
      if (ref == null) continue;
      counts.set(ref, (counts.get(ref) || 0) + 1);
    }
    return Array.from(counts, ([ref, count]) => ({ ref, count, order: palette.refs.indexOf(ref) }))
      .sort((a, b) => (b.count - a.count) || (a.order - b.order))
      .map(({ ref, count }) => ({ ref, count }));
  };

  // ── Storage: {v:2, palette:[ref strings], grid:[[1-based index | null]]} ──────────────────────────────────
  // Global refs are written as the bare Resources path, exactly like the format before refs existed, so older
  // saves and newer saves are interchangeable. d:/u:/space/warn are written as they are.
  const refToStored = ref => (ref.startsWith("g:") ? ref.slice(2) : ref);
  const storedToRef = s => {
    if (typeof s !== "string" || !s) return null;
    if (s === SPACE_REF || s === WARN_REF) return s;
    if (s.startsWith("d:") || s.startsWith("u:") || s.startsWith("g:") || s.startsWith("s:")) return isRef(s) ? s : null;
    return "g:" + s; // legacy: bare Resources path
  };

  const encodeForStorage = (palette, grid) => {
    const c = compactForExport(palette, grid);
    return {
      v: STORAGE_VERSION,
      palette: c.refs.map(refToStored),
      grid: c.grid.map(row => row.map(i => (i == null ? null : i + 1))),
    };
  };

  // -> { palette, grid } (0-based, entries that cannot be parsed become free slots and their cells null),
  // or null if the data is not a v2 palette save.
  const decodeFromStorage = saved => {
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return null;
    if (saved.v !== STORAGE_VERSION || !Array.isArray(saved.palette) || !Array.isArray(saved.grid)) return null;
    const refs = saved.palette.map(storedToRef);
    const grid = saved.grid.map(row => (Array.isArray(row) ? row : []).map(i => {
      if (i == null || !Number.isInteger(i) || i < 1 || i > refs.length) return null;
      return refs[i - 1] == null ? null : i - 1;
    }));
    return { palette: { refs }, grid };
  };

  // ── Tileset switch over the palette ────────────────────────────────────
  // One tileset per map. d: entries of the outgoing tileset are matched by codename into the incoming one; a d: entry that
  // belongs to any other tileset is foreign (cleared). g:/u:/space/warn entries are untouched. Cells are never rewritten
  // for a matched entry: only its palette entry changes (remapEntry).
  const planSwitch = (palette, oldRows, newRows) => {
    const oldByUuid = new Map((oldRows ?? []).map(r => [r.id, r]));
    const newByCodename = new Map((newRows ?? []).filter(r => r.codename).map(r => [r.codename, r]));
    const matched = [], mismatches = [], foreign = [];
    palette.refs.forEach(ref => {
      const p = ref ? parseRef(ref) : null;
      if (!p || p.kind !== "d") return;
      const row = oldByUuid.get(p.key);
      if (!row) { foreign.push(ref); return; }
      const target = row.codename ? newByCodename.get(row.codename) : undefined;
      if (target) matched.push({ from: ref, to: makeRef("d", target.id) });
      else mismatches.push({ ref, codename: row.codename ?? null });
    });
    return { matched, mismatches, foreign };
  };
  // remaps: { [oldRef]: replacementRef } for the plan's mismatches (default: the warn tile).
  // Returns { palette, grid, cleared } where cleared counts the cells emptied because their tile belonged to a third tileset.
  const applySwitchPlan = (palette, grid, plan, remaps = {}) => {
    let pal = palette, g = grid, cleared = 0;
    plan.foreign.forEach(ref => {
      const idx = pal.refs.indexOf(ref);
      if (idx === -1) return;
      g = g.map(row => row.map(c => { if (c === idx) { cleared++; return null; } return c; }));
      pal = { refs: pal.refs.map((r, i) => (i === idx ? null : r)) };
    });
    plan.matched.forEach(({ from, to }) => { const r = remapEntry(pal, from, to, g); pal = r.palette; g = r.grid; });
    plan.mismatches.forEach(({ ref }) => { const r = remapEntry(pal, ref, remaps[ref] ?? WARN_REF, g); pal = r.palette; g = r.grid; });
    return { palette: pal, grid: g, cleared };
  };

  return {
    KINDS, SPACE_REF, WARN_REF, STORAGE_VERSION,
    makeRef, parseRef, isRef, refKind,
    createPalette, clonePalette, indexOfRef, paletteIndexFor, refAt,
    usedIndexes, removeUnused, compactForExport, remapEntry, countRefs,
    encodeForStorage, decodeFromStorage,
    planSwitch, applySwitchPlan,
  };
});
