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

  // Diagonal kept only if both adjacent orthogonals are set.
  const normalise = code => {
    const b = code.split("").map(Number);
    if (!(b[N] && b[W])) b[NW] = 0;
    if (!(b[N] && b[E])) b[NE] = 0;
    if (!(b[S] && b[W])) b[SW] = 0;
    if (!(b[S] && b[E])) b[SE] = 0;
    return b.join("");
  };

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
    for (let n = 0; n < 256; n++) set.add(normalise(n.toString(2).padStart(8, "0")));
    return Array.from(set).sort();
  })();

  // Neighbour code of cell (r, c): isSame(r, c) -> bool. Out of range handling is up to isSame (map edge = air).
  const neighbourCode = (r, c, isSame) => OFFSETS.map(([dr, dc]) => (isSame(r + dr, c + dc) ? "1" : "0")).join("");

  // ── Tiles / folders ───────────────────────────────────────────────────────────────────────────────────
  // tile: { id|ref, sensorCode, sensorRoll, sortIndex }. folder: { tiles:[tile], settings:{spin,flip}, key }.
  const tileRef = t => (t.ref != null ? t.ref : t.id);
  const rollOf = t => (t.sensorRoll == null ? 1 : Number.isFinite(t.sensorRoll) ? Math.max(0, Math.floor(t.sensorRoll)) : 1);
  const cmpTiles = (a, b) => ((a.sortIndex ?? 0) - (b.sortIndex ?? 0)) || String(tileRef(a)).localeCompare(String(tileRef(b)));
  const settingsOf = folder => ({ spin: !!(folder.settings && folder.settings.spin), flip: !!(folder.settings && folder.settings.flip) });

  const entryFor = (t, code, ops, from) => ({
    ref: tileRef(t), tile: t, roll: rollOf(t), code, ops: ops.slice(),
    derivedFrom: from ? { ref: tileRef(from), tile: from, code: normalise(from.sensorCode) } : null,
  });

  // code -> usable (roll > 0) explicit variants, sorted. Unusable-only codes are reported in `disabled`.
  const explicitPools = folder => {
    const pools = {}, disabled = new Set();
    for (const t of (folder.tiles || []).slice().sort(cmpTiles)) {
      if (!isCode(t.sensorCode)) continue;
      const code = normalise(t.sensorCode);
      if (rollOf(t) > 0) (pools[code] = pools[code] || []).push(entryFor(t, code, [], null));
      else disabled.add(code);
    }
    return { pools, disabled };
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
  // under the transforms the folder allows: flip (horizontal mirror, TL<->TR and BL<->BR) and spin (clockwise quarter
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

  // Transforms allowed by the folder settings, cheapest first: [{ flip, steps }].
  const transformsFor = ({ spin: sp, flip: fl }) => {
    const out = [];
    for (let f = 0; f <= (fl ? 1 : 0); f++) for (let k = 0; k <= (sp ? 3 : 0); k++) out.push({ flip: !!f, steps: k });
    return out.sort((a, b) => ((a.flip ? 1 : 0) + (a.steps ? 1 : 0)) - ((b.flip ? 1 : 0) + (b.steps ? 1 : 0)));
  };
  const landing = (sq, type, t) => {
    const pos = ((t.flip ? FLIP_POS[sq] : sq) + t.steps) % 4;
    return { quadrant: pos, type: t.steps % 2 ? SWAP_EDGE[type] : type };
  };

  // slot key -> { code, tileRef, sourceQuadrant, flip, spinSteps } (cheapest source; ties go to the lowest code, then quadrant).
  const quadrantLibrary = (folder, _pools) => {
    const pools = _pools || explicitPools(folder).pools;
    const ts = transformsFor(settingsOf(folder));
    const lib = new Map(), costOf = new Map();
    for (const code of Object.keys(pools).sort()) {
      const tile = pools[code][0].tile;
      for (let sq = 0; sq < 4; sq++) {
        const type = quadrantType(code, sq);
        for (const t of ts) {
          const to = landing(sq, type, t), key = slotKey(to.quadrant, to.type);
          const cost = (t.flip ? 1 : 0) + (t.steps ? 1 : 0);
          if (costOf.has(key) && costOf.get(key) <= cost) continue;
          costOf.set(key, cost);
          lib.set(key, { code, tileRef: tileRef(tile), sourceQuadrant: sq, flip: t.flip, spinSteps: t.steps });
        }
      }
    }
    return lib;
  };

  // Slots (objects with a label) that no tile can supply under the folder's transforms. Without spin and flip nothing is
  // composed, so this is [] there. Composition per code only needs the four slots that code uses.
  const missingSlots = folder => {
    const st = settingsOf(folder);
    if (!st.spin && !st.flip) return [];
    const lib = quadrantLibrary(folder);
    return ALL_SLOTS.filter(s => !lib.has(s.key));
  };
  const computeRequiredBase = folder => missingSlots(folder).map(s => s.label);

  // Recipe for one code: 4 entries { quadrant, type, slot, sourceCode, sourceTileRef, sourceQuadrant, spinSteps, flip }.
  // The source tile is mirrored first when `flip`, then rotated clockwise by `spinSteps` quarter-turns about the image
  // centre; that puts source quadrant `sourceQuadrant` onto `quadrant`. null if spin and flip are both off, a slot has no
  // source, or the code is invalid.
  const compositionRecipe = (folder, code, _lib) => {
    const st = settingsOf(folder);
    if (!isCode(code) || (!st.spin && !st.flip)) return null;
    const lib = _lib || quadrantLibrary(folder);
    const norm = normalise(code);
    const recipe = [];
    for (let q = 0; q < 4; q++) {
      const type = quadrantType(norm, q), src = lib.get(slotKey(q, type));
      if (!src) return null;
      recipe.push({
        quadrant: q, quadrantName: QUAD_NAMES[q], type, slot: slotLabel(q, type), sourceCode: src.code,
        sourceTileRef: src.tileRef, sourceQuadrant: src.sourceQuadrant, spinSteps: src.spinSteps, flip: src.flip,
      });
    }
    return recipe;
  };

  // Renderer hook: calls drawFn(entry, index) for the four entries in TL, TR, BR, BL order; returns the results.
  const composeQuadrants = (recipe, drawFn) => {
    if (!Array.isArray(recipe) || typeof drawFn !== "function") return [];
    return recipe.map((entry, i) => drawFn(entry, i));
  };

  // ── Simple fence ──────────────────────────────────────────────────────────────────────────────────────
  // A folder whose usable coded variants are exactly {00000000, 00011000, 01000010} is resolved by the four cardinal bits only.
  const FENCE_CODES = ["00000000", "00011000", "01000010"];
  const isFenceFolder = (folder, _pools) => {
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
  // What a folder does with the codes it has no tile for: "fence" | "compose" (spin and/or flip) | "connections" (scoring).
  const folderMode = folder => {
    const { pools } = explicitPools(folder), st = settingsOf(folder);
    const fence = isFenceFolder(folder, pools);
    return { kind: fence ? "fence" : (st.spin || st.flip) ? "compose" : "connections", spin: st.spin, flip: st.flip, cardinalOnly: usesOnlyCardinals(folder, pools) };
  };

  // ── Candidates ────────────────────────────────────────────────────────────────────────────────────────
  // -> { [code]: { code, status: explicit|derived|composed|missing, pool:[entry], recipe?, disabled? } } for all 47 codes.
  const buildCandidates = folder => {
    const st = settingsOf(folder);
    const { pools, disabled } = explicitPools(folder);
    const out = {};
    for (const code of ALL_CODES) out[code] = { code, status: "missing", pool: [], disabled: disabled.has(code) && !pools[code] };
    for (const code of Object.keys(pools)) { out[code].status = "explicit"; out[code].pool = pools[code]; out[code].disabled = false; }

    // Derived: shortest op list wins; variants from every source at that cost share the pool.
    const derived = {}; // code -> { cost, pool, seen }
    for (const ops of opLists(st)) {
      for (const srcCode of Object.keys(pools)) {
        const code = normalise(applyOps(srcCode, ops));
        if (out[code].status === "explicit") continue;
        const d = derived[code] || (derived[code] = { cost: ops.length, pool: [], seen: new Set() });
        if (ops.length > d.cost) continue;
        for (const e of pools[srcCode]) {
          if (d.seen.has(e.ref)) continue;
          d.seen.add(e.ref);
          d.pool.push(entryFor(e.tile, code, ops, e.tile));
        }
      }
    }
    for (const code of Object.keys(derived)) { out[code].status = "derived"; out[code].pool = derived[code].pool; }

    const fence = isFenceFolder(folder, pools);
    Object.defineProperty(out, "_fence", { value: fence, enumerable: false });
    if ((st.spin || st.flip) && !fence) {
      const lib = quadrantLibrary(folder, pools);
      for (const code of ALL_CODES) {
        if (out[code].status !== "missing") continue;
        const recipe = compositionRecipe(folder, code, lib);
        if (!recipe) continue;
        out[code].status = "composed";
        out[code].recipe = recipe;
        out[code].pool = [{ ref: "composed:" + code, tile: null, roll: 1, code, ops: [], derivedFrom: null, composed: true, recipe }];
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

  // -> [0, 1). x, y integers; salt int.
  const hash2D = (x, y, salt) => {
    let h = (Math.imul(x | 0, 0x27d4eb2d) + Math.imul(y | 0, 0x165667b1) + Math.imul(salt | 0, 0x9e3779b1)) | 0;
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
    return ALL_CODES.map(code => {
      const c = cands[code];
      let status = c.status, fallbackCode = null;
      if (status === "missing") {
        const r = resolve(folder, code, { x: 0, y: 0, candidates: cands });
        fallbackCode = r ? r.code : null;
        status = mode.kind === "compose" ? "missing" : "fallback";
      }
      const sources = c.status === "composed" ? c.recipe
        : c.status === "derived" ? c.pool.map(e => ({ ref: e.derivedFrom.ref, code: e.derivedFrom.code, ops: e.ops }))
        : c.pool.map(e => ({ ref: e.ref, code }));
      return { code, status, fallbackCode, sources, poolPercentages: pickPercentages(c.pool) };
    });
  };

  // ── Resolver ──────────────────────────────────────────────────────────────────────────────────────────
  const saltToInt = salt => (typeof salt === "number" ? salt | 0 : stringToInt(salt));
  const poolTotal = pool => pool.reduce((a, e) => a + e.roll, 0);
  const count = (cand, nb, cv, nv) => { let n = 0; for (let i = 0; i < 8; i++) if (cand[i] === cv && nb[i] === nv) n++; return n; };

  // ctx: { x, y, salt, candidates? }. Returns { code, status, ref, tile, ops, derivedFrom, recipe, entry } or null.
  const resolve = (folder, neighbourCodeIn, ctx) => {
    const c = ctx || {};
    const nb = normalise(neighbourCodeIn);
    const cands = c.candidates || buildCandidates(folder);
    const avail = ALL_CODES.filter(code => cands[code].status !== "missing" && cands[code].pool.length > 0);
    if (!avail.length) return null;
    const salt = saltToInt(c.salt != null ? c.salt : folder.key);

    if (cands._fence) { // simple fence: cardinal bits only, exact match among the three variants, else 00000000
      const card = cardinalOnly(nb), code = avail.includes(card) ? card : "00000000";
      const cand = cands[code];
      const entry = weightedPick(cand.pool, e => e.roll, hash2D(c.x | 0, c.y | 0, salt));
      if (!entry) return null;
      return { code, status: cand.status, ref: entry.ref, tile: entry.tile, ops: entry.ops, derivedFrom: entry.derivedFrom, recipe: null, entry };
    }

    let winners;
    if (avail.includes(nb)) winners = [nb]; // exact match wins outright
    else {
      const score = avail.map(code => ({ code, matched: count(code, nb, "1", "1"), dangling: count(code, nb, "1", "0") }));
      const maxM = Math.max(...score.map(s => s.matched));
      const top = score.filter(s => s.matched === maxM);
      const minD = Math.min(...top.map(s => s.dangling));
      winners = top.filter(s => s.dangling === minD).map(s => s.code);
    }

    let code;
    if (winners.length === 1) code = winners[0];
    else if (cands["00000000"].status !== "missing" && cands["00000000"].pool.length) code = "00000000";
    else code = weightedPick(winners, w => poolTotal(cands[w].pool), hash2D(c.x | 0, c.y | 0, (salt + 0x7f4a7c15) | 0));

    const cand = cands[code];
    const entry = weightedPick(cand.pool, e => e.roll, hash2D(c.x | 0, c.y | 0, salt));
    if (!entry) return null;
    return { code, status: cand.status, ref: entry.ref, tile: entry.tile, ops: entry.ops, derivedFrom: entry.derivedFrom, recipe: cand.recipe || null, entry };
  };

  return {
    BIT_NAMES, OFFSETS, ALL_CODES, CARDINAL_CODES, FENCE_CODES, SLOT_TYPES, ALL_SLOTS, QUAD_NAMES,
    isCode, normalise, spin, flipH, neighbourCode,
    buildCandidates, coverage, computeRequiredBase, compositionRecipe, composeQuadrants,
    quadrantBits, quadrantType, quadrantLibrary, missingSlots, slotLabel, folderMode, isFenceFolder, cardinalOnly, usesOnlyCardinals,
    resolve, hash2D, stringToInt, weightedPick, pickPercentages,
  };
});
