// Sensor engine: bit model, spin/flip, folder candidates (explicit / derived / composed), resolver.
//
// Code = 8-char string of 0/1, order NW N NE W E SW S SE (centre skipped).
// Plain JS, no dependencies. Browser: window.Sensor. Node: require("./sensor.js").
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Sensor = api;
})(typeof self !== "undefined" ? self : this, function () {
  const NW = 0, N = 1, NE = 2, W = 3, E = 4, SW = 5, S = 6, SE = 7;
  const OFFSETS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]]; // (dr, dc) per bit
  const BIT_NAMES = ["NW", "N", "NE", "W", "E", "SW", "S", "SE"];

  const isCode = c => typeof c === "string" && /^[01]{8}$/.test(c);

  // Sentinel code: the fallback tile of an exact-mode folder. Never a real neighbourhood (it is not normalised).
  const FALLBACK_CODE = "10100101"; // the one place the value lives
  const isFallback = c => c === FALLBACK_CODE;

  // Diagonal kept only if both adjacent orthogonals are set.
  const normaliseBits = code => {
    const b = code.split("").map(Number);
    if (!(b[N] && b[W])) b[NW] = 0;
    if (!(b[N] && b[E])) b[NE] = 0;
    if (!(b[S] && b[W])) b[SW] = 0;
    if (!(b[S] && b[E])) b[SE] = 0;
    return b.join("");
  };
  // Public: the fallback sentinel passes through unchanged. Neighbourhoods inside the engine use normaliseBits.
  const normalise = code => (code === FALLBACK_CODE ? code : normaliseBits(code));

  // Clockwise 90: source bit i moves to SPIN_TO[i].
  const SPIN_TO = [NE, E, SE, N, S, NW, W, SW];
  const spin = code => {
    const out = new Array(8);
    for (let i = 0; i < 8; i++) out[SPIN_TO[i]] = code[i];
    return out.join("");
  };
  const FLIP_TO = [NE, N, NW, E, W, SE, S, SW];
  const flipH = code => {
    const out = new Array(8);
    for (let i = 0; i < 8; i++) out[FLIP_TO[i]] = code[i];
    return out.join("");
  };

  const ALL_CODES = (() => {
    const set = new Set();
    for (let n = 0; n < 256; n++) set.add(normaliseBits(n.toString(2).padStart(8, "0")));
    return Array.from(set).sort();
  })();

  // Neighbour code of cell (r, c): isSame(r, c) -> bool. Out of range handling is up to isSame (map edge = air).
  const neighbourCode = (r, c, isSame) => OFFSETS.map(([dr, dc]) => (isSame(r + dr, c + dc) ? "1" : "0")).join("");

  // ── Tiles / folders ───────────────────────────────────────────────────────────────────────────────────
  // tile: { id|ref, sensorCode, sensorRoll, sortIndex, rotatable?, flippable? }. folder: { tiles:[tile], settings?:{spin,flip}, key }.
  // What a tile can derive or contribute is decided by ITS OWN flags: `rotatable` / `flippable` (or the UI's dbRotatable / dbFlippable).
  // folder.settings is only the default for tiles that carry no flag at all.
  const tileRef = t => (t.ref != null ? t.ref : t.id);
  const rollOf = t => (t.sensorRoll == null ? 1 : Number.isFinite(t.sensorRoll) ? Math.max(0, Math.floor(t.sensorRoll)) : 1);
  const cmpTiles = (a, b) => ((a.sortIndex ?? 0) - (b.sortIndex ?? 0)) || String(tileRef(a)).localeCompare(String(tileRef(b)));
  const defaults = folder => ({ spin: !!(folder.settings && folder.settings.spin), flip: !!(folder.settings && folder.settings.flip) });
  const flagOf = (t, a, b, dflt) => (t[a] != null ? !!t[a] : t[b] != null ? !!t[b] : dflt);
  const canSpin = (t, folder) => flagOf(t, "rotatable", "dbRotatable", defaults(folder).spin);
  const canFlip = (t, folder) => flagOf(t, "flippable", "dbFlippable", defaults(folder).flip);

  const entryFor = (t, code, ops, from) => ({
    ref: tileRef(t), tile: t, roll: rollOf(t), code, ops: ops.slice(),
    derivedFrom: from ? { ref: tileRef(from), tile: from, code: normalise(from.sensorCode) } : null,
  });

  // code -> usable (roll > 0) explicit variants, sorted. Unusable-only codes are reported in `disabled`. The fallback sentinel
  // 10100101 never joins `pools` (it is never derived from, composed from or scored): its usable tiles are `fallback`.
  const explicitPools = folder => {
    const pools = {}, disabled = new Set(), fallback = [];
    for (const t of (folder.tiles || []).slice().sort(cmpTiles)) {
      if (!isCode(t.sensorCode)) continue;
      const code = normalise(t.sensorCode);
      if (isFallback(code)) { if (rollOf(t) > 0) fallback.push(entryFor(t, code, [], null)); continue; }
      if (rollOf(t) > 0) (pools[code] = pools[code] || []).push(entryFor(t, code, [], null));
      else disabled.add(code);
    }
    return { pools, disabled, fallback };
  };
  // Exact mode: the folder has a usable (roll > 0) 10100101 tile.
  const isExactFolder = folder => explicitPools(folder).fallback.length > 0;

  const allEntries = pools => Object.keys(pools).sort().flatMap(c => pools[c]);
  // What the folder's usable tiles can do at all: { spin, flip } = some tile can.
  const folderCan = (folder, _pools) => {
    const es = allEntries(_pools || explicitPools(folder).pools);
    if (!es.length) return defaults(folder); // nothing to read flags from: the folder default
    return { spin: es.some(e => canSpin(e.tile, folder)), flip: es.some(e => canFlip(e.tile, folder)) };
  };

  // Op lists tried for derivation, cheapest first.
  const opLists = ({ spin: sp, flip: fl }) => {
    const lists = [];
    for (let s = 0; s <= (sp ? 3 : 0); s++) for (let f = 0; f <= (fl ? 1 : 0); f++) {
      if (!s && !f) continue;
      lists.push([...Array(s).fill("spin"), ...(f ? ["flipH"] : [])]);
    }
    return lists.sort((a, b) => a.length - b.length);
  };
  const applyOps = (code, ops) => ops.reduce((c, op) => (op === "spin" ? spin(c) : flipH(c)), code);

  // ── Quadrant composition ──────────────────────────────────────────────────────────────────────────────
  // Quadrants: 0 TL, 1 TR, 2 BR, 3 BL. Each is the triple of ring bits [diagonal, orthoA, orthoB], listed so that
  // spin moves quadrant q to q+1 and maps its triple element-wise.
  const QUAD_NAMES = ["TL", "TR", "BR", "BL"];
  const QUAD_BITS = [[NW, N, W], [NE, E, N], [SE, S, E], [SW, W, S]];
  const QUAD_HORIZ_FIRST = [false, true, false, true]; // is orthoA the W/E neighbour?
  const quadrantBits = (code, q) => QUAD_BITS[q].map(i => code[i]).join("");

  // outer | edgeH | edgeV | inner | interior  (edgeH: border runs horizontally, i.e. the N/S neighbour is missing)
  const quadrantType = (code, q) => {
    const [d, a, b] = quadrantBits(code, q);
    if (a === "1" && b === "1") return d === "1" ? "interior" : "inner";
    if (a === "0" && b === "0") return "outer";
    const missingIsHoriz = (a === "0") === QUAD_HORIZ_FIRST[q];
    return missingIsHoriz ? "edgeV" : "edgeH";
  };

  // ── Quadrant library ──────────────────────────────────────────────────────────────────────────────────
  // Every explicit (usable) tile contributes its four quadrants, each classified by position (0 TL, 1 TR, 2 BR, 3 BL)
  // and type. A "slot" is a (position, type) pair: 4 x 5 = 20 slots. A slot is covered when some tile quadrant lands on it
  // under the transforms THAT TILE allows: flip (horizontal mirror, TL<->TR and BL<->BR) and spin (clockwise quarter
  // turns; an odd number of turns swaps edgeH and edgeV). Order of application: flip first, then spin.
  const SLOT_TYPES = ["outer", "edgeH", "edgeV", "inner", "interior"];
  const FLIP_POS = [1, 0, 3, 2];
  const SWAP_EDGE = { outer: "outer", edgeH: "edgeV", edgeV: "edgeH", inner: "inner", interior: "interior" };
  const POS_NAMES = ["top-left", "top-right", "bottom-right", "bottom-left"];
  const slotKey = (q, type) => q + "|" + type;
  const slotLabel = (q, type) => {
    if (type === "outer") return POS_NAMES[q] + " outer corner";
    if (type === "inner") return POS_NAMES[q] + " inner corner";
    if (type === "interior") return POS_NAMES[q] + " interior";
    if (type === "edgeH") return POS_NAMES[q] + (q === 0 || q === 1 ? " top edge" : " bottom edge");
    return POS_NAMES[q] + (q === 0 || q === 3 ? " left edge" : " right edge");
  };
  const ALL_SLOTS = (() => { const out = []; for (let q = 0; q < 4; q++) for (const t of SLOT_TYPES) out.push({ quadrant: q, type: t, key: slotKey(q, t), label: slotLabel(q, t) }); return out; })();

  // Transforms one tile allows, cheapest first: [{ flip, steps }].
  const transformCost = t => (t.flip ? 1 : 0) + (t.steps ? 2 : 0); // none 0 < flip 1 < spin 2 < spin+flip 3
  const tileTransforms = (tile, folder) => {
    const sp = canSpin(tile, folder), fl = canFlip(tile, folder), out = [];
    for (let f = 0; f <= (fl ? 1 : 0); f++) for (let k = 0; k <= (sp ? 3 : 0); k++) out.push({ flip: !!f, steps: k });
    return out.sort((a, b) => transformCost(a) - transformCost(b) || a.steps - b.steps);
  };
  const landing = (sq, type, t) => {
    const pos = ((t.flip ? FLIP_POS[sq] : sq) + t.steps) % 4;
    return { quadrant: pos, type: t.steps % 2 ? SWAP_EDGE[type] : type };
  };
  // The tile's code after the transform (flip first, then spin).
  const transformedCode = (code, t) => { let c = code; if (t.flip) c = flipH(c); for (let i = 0; i < t.steps; i++) c = spin(c); return c; };

  // slot key -> [option], option = { entry, tile, code, sourceQuadrant, flip, steps }: every way a usable tile can fill the slot.
  const slotOptions = (folder, _pools) => {
    const pools = _pools || explicitPools(folder).pools;
    const map = new Map();
    for (const e of allEntries(pools)) {
      for (const t of tileTransforms(e.tile, folder)) {
        for (let sq = 0; sq < 4; sq++) {
          const to = landing(sq, quadrantType(e.code, sq), t), key = slotKey(to.quadrant, to.type);
          if (!map.has(key)) map.set(key, []);
          map.get(key).push({ entry: e, tile: e.tile, code: e.code, sourceQuadrant: sq, flip: t.flip, steps: t.steps });
        }
      }
    }
    return map;
  };

  const diffBits = (a, b, idx) => { let n = 0; for (const i of idx) if (a[i] !== b[i]) n++; return n; };
  const CARD = [N, W, E, S], DIAG = [NW, NE, SW, SE];
  // Rank key of an option for a target code (lower is better): fewest transforms, then cardinal-bit difference of the (transformed)
  // source tile vs the target, then diagonal-bit difference, then sortIndex, ref, quadrant (and spin steps).
  const rankKey = (o, target) => {
    const tc = transformedCode(o.code, o);
    return [transformCost(o), target ? diffBits(tc, target, CARD) : 0, target ? diffBits(tc, target, DIAG) : 0, o.steps,
      o.tile.sortIndex ?? 0, String(tileRef(o.tile)), o.sourceQuadrant];
  };
  const cmpKey = (a, b) => { for (let i = 0; i < a.length; i++) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1; } return 0; };
  const best = (opts, target) => { let b = null, bk = null; for (const o of opts) { const k = rankKey(o, target); if (!b || cmpKey(k, bk) < 0) { b = o; bk = k; } } return b && { opt: b, key: bk }; };

  // slot key -> best option ignoring any target (used for coverage of slots).
  const quadrantLibrary = (folder, _pools) => {
    const lib = new Map();
    for (const [key, opts] of slotOptions(folder, _pools)) { const b = best(opts, null).opt; lib.set(key, { code: b.code, tileRef: tileRef(b.tile), sourceQuadrant: b.sourceQuadrant, flip: b.flip, spinSteps: b.steps }); }
    return lib;
  };

  // Slots (objects with a label) that no tile can supply under its own transforms. When no tile can spin or flip nothing is
  // composed, so this is [] there. Composition per code only needs the four slots that code uses.
  const missingSlots = folder => {
    const { pools } = explicitPools(folder), can = folderCan(folder, pools);
    if (!can.spin && !can.flip) return [];
    const opts = slotOptions(folder, pools);
    return ALL_SLOTS.filter(s => !opts.has(s.key));
  };
  const computeRequiredBase = folder => missingSlots(folder).map(s => s.label);

  // Recipe for one code: 4 entries { quadrant, type, slot, sourceCode, sourceTileRef, sourceQuadrant, spinSteps, flip }.
  // The source tile is mirrored first when `flip`, then rotated clockwise by `spinSteps` quarter-turns about the image
  // centre; that puts source quadrant `sourceQuadrant` onto `quadrant`. Sources are ranked per quadrant (see rankKey); when one
  // tile+transform can supply a whole left or right half with no more transforms than the separate best picks, it does.
  // The recipe also lists `majorityRef` (the tile supplying most quadrants; ties go to the best-ranked source).
  // null if no tile can transform, a slot has no source, or the code is invalid.
  const compositionRecipe = (folder, code, _slots, _pools) => {
    if (!isCode(code) || isFallback(code)) return null;
    const pools = _pools || explicitPools(folder).pools, can = folderCan(folder, pools);
    if (!can.spin && !can.flip) return null;
    const slots = _slots || slotOptions(folder, pools);
    const norm = normaliseBits(code);
    const types = [0, 1, 2, 3].map(q => quadrantType(norm, q));
    const picks = [];
    for (let q = 0; q < 4; q++) {
      const opts = slots.get(slotKey(q, types[q]));
      if (!opts) return null;
      picks[q] = best(opts, norm);
    }
    for (const half of [[0, 3], [1, 2]]) {
      if (picks[half[0]].opt.entry === picks[half[1]].opt.entry && picks[half[0]].opt.flip === picks[half[1]].opt.flip && picks[half[0]].opt.steps === picks[half[1]].opt.steps) continue;
      const budget = half.reduce((a, q) => a + transformCost(picks[q].opt), 0);
      let bestPair = null;
      const a = slots.get(slotKey(half[0], types[half[0]]));
      for (const oa of a) {
        const ob = (slots.get(slotKey(half[1], types[half[1]])) || []).find(o => o.entry === oa.entry && o.flip === oa.flip && o.steps === oa.steps);
        if (!ob || transformCost(oa) * 2 > budget) continue;
        const ka = rankKey(oa, norm), kb = rankKey(ob, norm);
        const key = [ka[0] + kb[0], ka[1] + kb[1], ka[2] + kb[2], ka[3], ka[4], ka[5], ka[6]];
        if (!bestPair || cmpKey(key, bestPair.key) < 0) bestPair = { key, oa, ob };
      }
      if (bestPair) { picks[half[0]] = { opt: bestPair.oa, key: rankKey(bestPair.oa, norm) }; picks[half[1]] = { opt: bestPair.ob, key: rankKey(bestPair.ob, norm) }; }
    }
    const recipe = picks.map((p, q) => ({
      quadrant: q, quadrantName: QUAD_NAMES[q], type: types[q], slot: slotLabel(q, types[q]), sourceCode: p.opt.code,
      sourceTileRef: tileRef(p.opt.tile), sourceQuadrant: p.opt.sourceQuadrant, spinSteps: p.opt.steps, flip: p.opt.flip, rankKey: p.key,
    }));
    // Majority source tile: most quadrants; ties -> the tile with the best-ranked quadrant.
    const tally = new Map();
    recipe.forEach((e, q) => { const t = tally.get(e.sourceTileRef) || { ref: e.sourceTileRef, n: 0, key: e.rankKey, tile: picks[q].opt.tile }; t.n++; if (cmpKey(e.rankKey, t.key) < 0) t.key = e.rankKey; tally.set(e.sourceTileRef, t); });
    const maj = [...tally.values()].sort((x, y) => (y.n - x.n) || cmpKey(x.key, y.key))[0];
    Object.defineProperty(recipe, "majorityRef", { value: maj.ref, enumerable: false });
    Object.defineProperty(recipe, "majorityTile", { value: maj.tile, enumerable: false });
    return recipe;
  };

  // Renderer hook: calls drawFn(entry, index) for the four entries in TL, TR, BR, BL order; returns the results.
  const composeQuadrants = (recipe, drawFn) => {
    if (!Array.isArray(recipe) || typeof drawFn !== "function") return [];
    return recipe.map((entry, i) => drawFn(entry, i));
  };

  // ── Simple fence ──────────────────────────────────────────────────────────────────────────────────────
  // Legacy rule, ONLY for folders without a 10100101 tile: a folder whose usable coded variants are exactly
  // {00000000, 00011000, 01000010} is resolved by the four cardinal bits only.
  const FENCE_CODES = ["00000000", "00011000", "01000010"];
  const isFenceFolder = (folder, _pools) => {
    if (!_pools && isExactFolder(folder)) return false;
    const keys = Object.keys(_pools || explicitPools(folder).pools).sort();
    return keys.length === 3 && FENCE_CODES.every(c => keys.includes(c));
  };
  const CARDINAL_BITS = [N, W, E, S];
  const cardinalOnly = code => { const b = code.split(""); return b.map((v, i) => (CARDINAL_BITS.includes(i) ? v : "0")).join(""); };
  // True when no coded variant uses a diagonal bit (fence, rope, rails): only the 16 cardinal codes matter.
  const usesOnlyCardinals = (folder, _pools) => {
    const codes = Object.keys(_pools || explicitPools(folder).pools);
    return codes.length > 0 && codes.every(c => cardinalOnly(c) === c);
  };
  const CARDINAL_CODES = ALL_CODES.filter(c => cardinalOnly(c) === c);
  // What a folder does with the codes it has no tile for: "exact" (10100101 fallback tile) | "fence" | "compose" (a tile can spin
  // and/or flip) | "connections" (scoring).
  const folderMode = folder => {
    const { pools, fallback } = explicitPools(folder), can = folderCan(folder, pools);
    const exact = fallback.length > 0, fence = !exact && isFenceFolder(folder, pools);
    return { kind: exact ? "exact" : fence ? "fence" : (can.spin || can.flip) ? "compose" : "connections", spin: can.spin, flip: can.flip, cardinalOnly: usesOnlyCardinals(folder, pools) };
  };

  // ── Candidates ────────────────────────────────────────────────────────────────────────────────────────
  // -> { [code]: { code, status: explicit|derived|composed|missing, pool:[entry], recipe?, disabled? } } for all 47 codes.
  // Exact-mode folders also carry "10100101": { status: "explicit", fallback: true, pool }. They never compose.
  const buildCandidates = folder => {
    const { pools, disabled, fallback } = explicitPools(folder);
    const exact = fallback.length > 0;
    const out = {};
    for (const code of ALL_CODES) out[code] = { code, status: "missing", pool: [], disabled: disabled.has(code) && !pools[code] };
    for (const code of Object.keys(pools)) { out[code].status = "explicit"; out[code].pool = pools[code]; out[code].disabled = false; }

    // Derived: shortest op list wins; variants from every source at that cost share the pool. A tile only derives with its own flags.
    const derived = {}; // code -> { cost, pool, seen }
    for (const ops of opLists({ spin: true, flip: true })) {
      const needSpin = ops.includes("spin"), needFlip = ops.includes("flipH");
      for (const srcCode of Object.keys(pools)) {
        const usable = pools[srcCode].filter(e => (!needSpin || canSpin(e.tile, folder)) && (!needFlip || canFlip(e.tile, folder)));
        if (!usable.length) continue;
        const code = normaliseBits(applyOps(srcCode, ops));
        if (out[code].status === "explicit") continue;
        const d = derived[code] || (derived[code] = { cost: ops.length, pool: [], seen: new Set() });
        if (ops.length > d.cost) continue;
        for (const e of usable) {
          if (d.seen.has(e.ref)) continue;
          d.seen.add(e.ref);
          d.pool.push(entryFor(e.tile, code, ops, e.tile));
        }
      }
    }
    for (const code of Object.keys(derived)) { out[code].status = "derived"; out[code].pool = derived[code].pool; }

    const fence = !exact && isFenceFolder(folder, pools);
    Object.defineProperty(out, "_fence", { value: fence, enumerable: false });
    Object.defineProperty(out, "_exact", { value: exact, enumerable: false });
    if (exact) out[FALLBACK_CODE] = { code: FALLBACK_CODE, status: "explicit", fallback: true, pool: fallback, disabled: false };
    const can = folderCan(folder, pools);
    if (!exact && (can.spin || can.flip) && !fence) {
      const slots = slotOptions(folder, pools);
      for (const code of ALL_CODES) {
        if (out[code].status !== "missing") continue;
        const recipe = compositionRecipe(folder, code, slots, pools);
        if (!recipe) continue;
        out[code].status = "composed";
        out[code].recipe = recipe;
        out[code].pool = [{ ref: "composed:" + code, tile: null, roll: 1, code, ops: [], derivedFrom: null, composed: true, recipe, majorityRef: recipe.majorityRef, majorityTile: recipe.majorityTile }];
      }
    }
    return out;
  };

  // ── Hashing / weighted pick ───────────────────────────────────────────────────────────────────────────
  const stringToInt = str => { // FNV-1a, 32 bit
    let h = 0x811c9dc5;
    const s = String(str == null ? "" : str);
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
    return h | 0;
  };

  // -> [0, 1). x, y integers; salt int; rerollSeed int (default 0 = the unseeded hash). The reroll seed is mixed in before the finaliser, so a
  // different seed reshuffles every hash-decided pick of a folder while the same seed always gives the same picks.
  const hash2D = (x, y, salt, rerollSeed) => {
    let h = (Math.imul(x | 0, 0x27d4eb2d) + Math.imul(y | 0, 0x165667b1) + Math.imul(salt | 0, 0x9e3779b1) + Math.imul(rerollSeed | 0, 0x2c1b3c6d)) | 0;
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };

  const weightedPick = (items, weightOf, r) => {
    let total = 0;
    for (const it of items) total += weightOf(it);
    if (!(total > 0)) return null;
    let t = r * total;
    for (const it of items) {
      t -= weightOf(it);
      if (t < 0) return it;
    }
    return items[items.length - 1];
  };

  // Pool of entries (or tiles) with roll / sensorRoll -> [{ ref, roll, probability }] (roll 0 excluded from picks, listed with 0).
  const pickPercentages = pool => {
    const rolls = pool.map(e => (e.roll != null ? e.roll : rollOf(e)));
    const total = rolls.reduce((a, b) => a + b, 0);
    return pool.map((e, i) => ({ ref: e.ref != null ? e.ref : tileRef(e), roll: rolls[i], probability: total > 0 ? rolls[i] / total : 0 }));
  };

  // ── Coverage ──────────────────────────────────────────────────────────────────────────────────────────
  // One row per code: { code, status: explicit|derived|composed|fallback|missing, fallbackCode?, sources, poolPercentages }.
  // "fallback": no tile of its own, the resolver uses another code (nearest, or 00000000). "missing" (red): the folder is
  // meant to compose its missing codes (spin and/or flip) but this one cannot be composed.
  const coverage = folder => {
    const cands = buildCandidates(folder);
    const mode = folderMode(folder);
    const srcOf = c => (c.status === "composed" ? c.recipe
      : c.status === "derived" ? c.pool.map(e => ({ ref: e.derivedFrom.ref, code: e.derivedFrom.code, ops: e.ops }))
      : c.pool.map(e => ({ ref: e.ref, code: c.code })));
    if (cands._exact) { // exact mode: only what is reachable (explicit / derived) plus the fallback tile
      const rows = ALL_CODES.filter(code => cands[code].status === "explicit" || cands[code].status === "derived")
        .map(code => ({ code, status: cands[code].status, fallbackCode: null, sources: srcOf(cands[code]), poolPercentages: pickPercentages(cands[code].pool) }));
      const fb = cands[FALLBACK_CODE];
      rows.push({ code: FALLBACK_CODE, status: "fallback-tile", fallbackCode: null, sources: srcOf(fb), poolPercentages: pickPercentages(fb.pool) });
      return rows;
    }
    return ALL_CODES.map(code => {
      const c = cands[code];
      let status = c.status, fallbackCode = null;
      if (status === "missing") {
        const r = resolve(folder, code, { x: 0, y: 0, candidates: cands });
        fallbackCode = r ? r.code : null;
        status = mode.kind === "compose" ? "missing" : "fallback";
      }
      return { code, status, fallbackCode, sources: srcOf(c), poolPercentages: pickPercentages(c.pool) };
    });
  };

  // ── Resolver ──────────────────────────────────────────────────────────────────────────────────────────
  const saltToInt = salt => (typeof salt === "number" ? salt | 0 : stringToInt(salt));
  const poolTotal = pool => pool.reduce((a, e) => a + e.roll, 0);
  const count = (cand, nb, cv, nv) => { let n = 0; for (let i = 0; i < 8; i++) if (cand[i] === cv && nb[i] === nv) n++; return n; };

  // The codes tied for best by connection scoring (matched neighbours, then fewest dangling connections); `avail` = usable codes.
  const scoreWinners = (avail, nb) => {
    if (avail.includes(nb)) return [nb]; // exact match wins outright
    const score = avail.map(code => ({ code, matched: count(code, nb, "1", "1"), dangling: count(code, nb, "1", "0") }));
    const maxM = Math.max(...score.map(s => s.matched));
    const top = score.filter(s => s.matched === maxM);
    const minD = Math.min(...top.map(s => s.dangling));
    return top.filter(s => s.dangling === minD).map(s => s.code);
  };

  // ctx: { x, y, salt, reroll?, candidates? }. `reroll` is the per-folder reroll seed (integer, default 0). Returns { code, status, ref, tile, ops, derivedFrom, recipe, entry } or null.
  const resolve = (folder, neighbourCodeIn, ctx) => {
    const c = ctx || {};
    const nb = normaliseBits(neighbourCodeIn);
    const cands = c.candidates || buildCandidates(folder);
    const avail = ALL_CODES.filter(code => cands[code].status !== "missing" && cands[code].pool.length > 0);
    if (!avail.length) return null;
    const salt = saltToInt(c.salt != null ? c.salt : folder.key), rr = c.reroll | 0;

    if (cands._exact) { // exact mode: exact match among explicit / derived tiles, else the 10100101 tile. No composition, no scoring.
      const hit = cands[nb] && cands[nb].pool.length ? cands[nb] : null, cand = hit || cands[FALLBACK_CODE];
      const entry = weightedPick(cand.pool, e => e.roll, hash2D(c.x | 0, c.y | 0, salt, rr));
      if (!entry) return null;
      return { code: cand.code, status: cand.status, fallback: !hit, ref: entry.ref, tile: entry.tile, ops: entry.ops, derivedFrom: entry.derivedFrom, recipe: null, entry };
    }
    if (cands._fence) { // simple fence: cardinal bits only, exact match among the three variants, else 00000000
      const card = cardinalOnly(nb), code = avail.includes(card) ? card : "00000000";
      const cand = cands[code];
      const entry = weightedPick(cand.pool, e => e.roll, hash2D(c.x | 0, c.y | 0, salt, rr));
      if (!entry) return null;
      return { code, status: cand.status, ref: entry.ref, tile: entry.tile, ops: entry.ops, derivedFrom: entry.derivedFrom, recipe: null, entry };
    }

    const winners = scoreWinners(avail, nb);

    let code;
    if (winners.length === 1) code = winners[0];
    else if (cands["00000000"].status !== "missing" && cands["00000000"].pool.length) code = "00000000";
    else code = weightedPick(winners, w => poolTotal(cands[w].pool), hash2D(c.x | 0, c.y | 0, (salt + 0x7f4a7c15) | 0, rr));

    const cand = cands[code];
    const entry = weightedPick(cand.pool, e => e.roll, hash2D(c.x | 0, c.y | 0, salt, rr));
    if (!entry) return null;
    return { code, status: cand.status, ref: entry.ref, tile: entry.tile, ops: entry.ops, derivedFrom: entry.derivedFrom, recipe: cand.recipe || null, entry };
  };

  // Does the folder have a pick that only the hash decides, i.e. would a reroll seed change anything? True when
  //  - a sensor code is shared by two or more explicit variants with roll > 0 (their pool is a weighted random pick), or
  //  - some neighbourhood ties between different codes (connection scoring) and the folder has neither a 00000000 tile (which wins ties)
  //    nor a fallback tile (exact mode never scores). Roll-0 variants never count. `candidates` may be passed to reuse buildCandidates.
  const hasRerollableTies = (folder, _cands) => {
    const { pools, fallback } = explicitPools(folder);
    if (Object.values(pools).some(p => p.length >= 2) || fallback.length >= 2) return true;
    if (fallback.length) return false; // exact mode: no scoring, so no cross-code ties
    const cands = _cands || buildCandidates(folder);
    if (cands._fence || (cands["00000000"].status !== "missing" && cands["00000000"].pool.length)) return false; // ties go to 00000000
    const avail = ALL_CODES.filter(code => cands[code].status !== "missing" && cands[code].pool.length > 0);
    if (avail.length < 2) return false;
    return ALL_CODES.some(nb => scoreWinners(avail, nb).length > 1);
  };

  return {
    BIT_NAMES, OFFSETS, ALL_CODES, CARDINAL_CODES, FENCE_CODES, SLOT_TYPES, ALL_SLOTS, QUAD_NAMES,
    FALLBACK_CODE, isFallback, isExactFolder, folderCan, canSpin, canFlip,
    normaliseNeighbourhood: normaliseBits,
    isCode, normalise, spin, flipH, neighbourCode,
    buildCandidates, coverage, computeRequiredBase, compositionRecipe, composeQuadrants,
    quadrantBits, quadrantType, quadrantLibrary, missingSlots, slotLabel, folderMode, isFenceFolder, cardinalOnly, usesOnlyCardinals,
    resolve, hasRerollableTies, hash2D, stringToInt, weightedPick, pickPercentages,
  };
});
