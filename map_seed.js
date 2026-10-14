// Map seeds: a compact text form of a whole map.  size/magnet/mirror/tileset/palette/code
//
// FORMAT (frozen: no version, no checksum, no map name; six positional fields separated by "/", "/" never occurs inside a field)
//   size     "3v3" = 21x33, "SD" = 60x60, otherwise "WxH" (1-99 each). Decoding also accepts "21x33" / "60x60".
//   magnet   "x" = the default centre; otherwise "col,row" (+ ",size" only when size is not 1). size is the app's customCenterSize:
//            2 = 2x2, 3 = 2x1 (two wide, one tall), 4 = 1x2 (one wide, two tall). col,row is the magnet cell (its top-left cell for
//            sizes 2-4). A magnet whose effective centre equals the default centre is written "x".
//   mirror   h  left<->right      (the app flag mirrorV, labelled "Horizontal")
//            v  top<->bottom      (the app flag mirrorH, labelled "Vertical")
//            d  180-degree central (the app flag mirrorD)
//            4  all three (h, v and d)
//            a  asymmetrical
//            The encoder picks the class with the SMALLEST fundamental region that holds exactly about the effective centre; ties go
//            in the order 4, d, h, v, a. (Any two of h, v, d imply the third while every mirror image lies inside the grid, so the
//            classes are h, v, d, 4, a; with an off-centre magnet some images fall outside the grid and are then unconstrained.)
//   tileset  decimal seed_id of the tileset the tile symbols belong to.
//   palette  the tile symbols used on the map, one code point each, concatenated with no delimiter, most frequent first
//            (cells counted over the FULL map), ties by code point. Cell index 0 is "empty"; palette entry i is index i + 1.
//            A symbol is never "/", whitespace or a control character. Case-sensitive.
//   code     the cell indexes of the FUNDAMENTAL REGION, run-length encoded as a bit stream and written in base62 (0-9A-Za-z).
//
// FUNDAMENTAL REGION. Let (SR, SC) = (2*centreRow, 2*centreCol), both integers (see effectiveSums). The mirror images of (r, c) are
//   h: (r, SC-c)   v: (SR-r, c)   d: (SR-r, SC-c)         (class 4 uses all three; "a" uses none)
// keeping only images inside the grid. The orbit of a cell is itself plus its images; the region is every cell that is the FIRST
// (row-major) of its orbit. For a centred map that is the left half (h), the top half (v), the top half plus the left half of the middle
// row (d) or the top-left quadrant (4), the centre row/column included; for "a" it is the whole map. The region is listed in row-major
// order and decoding copies each region cell to its whole orbit.
//
// CODE BIT STREAM. Runs of equal cell index over the region, in order, each run = VALUE then LENGTH:
//   VALUE   k bits, k = bit length of the palette size P (k = 0 when P = 0), most significant bit first
//   LENGTH  n >= 1 as Elias gamma: (floor(log2 n)) zeros, then n in binary (floor(log2 n) + 1 bits, leading 1)
// Runs are maximal (the encoder never emits two neighbouring runs with the same value) so one map gives one seed. The bits are prefixed
// with a single 1 (sentinel), the result is read as one big binary number and written in base62, most significant digit first, no
// leading zeros. Decoding: base62 -> number -> drop the sentinel -> read runs until the bits end exactly; the run lengths must add up
// to the region size.
//
// Plain JS, no dependencies. Browser: window.MapSeed. Node: require("./map_seed.js").
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MapSeed = api;
})(typeof self !== "undefined" ? self : this, function () {
  const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const MAX_DIM = 99;
  const MAX_PALETTE = 1000;
  const MAX_CODE_CHARS = 30000;
  const MAX_SEED_CHARS = MAX_CODE_CHARS + 2000;
  const SIZE_3V3 = { w: 21, h: 33 }, SIZE_SD = { w: 60, h: 60 };
  const CLASSES = ["4", "d", "h", "v", "a"]; // tie-break order
  // seed mirror class -> app flags. h (left<->right) is the app's mirrorV ("Horizontal"), v (top<->bottom) is mirrorH ("Vertical").
  const CLASS_FLAGS = Object.freeze({
    a: Object.freeze({ mirrorV: false, mirrorH: false, mirrorD: false }),
    h: Object.freeze({ mirrorV: true, mirrorH: false, mirrorD: false }),
    v: Object.freeze({ mirrorV: false, mirrorH: true, mirrorD: false }),
    d: Object.freeze({ mirrorV: false, mirrorH: false, mirrorD: true }),
    4: Object.freeze({ mirrorV: true, mirrorH: true, mirrorD: true }),
  });
  const CLASS_NAMES = Object.freeze({ a: "asymmetrical", h: "left-right (Horizontal mirror)", v: "top-bottom (Vertical mirror)", d: "180-degree central", 4: "all three (Horizontal + Vertical + Central)" });
  const MAGNET_SIZE_NAMES = Object.freeze({ 1: "1x1", 2: "2x2", 3: "2x1", 4: "1x2" });

  // ── Global tile symbols ───────────────────────────────────────────────────────────────────────────────
  // ref -> symbol for tiles that live in Resources/manifest.json. Sensor folders are keyed by their folder ref (cells hold that ref).
  // Gaps (no symbol, export blank): spawns 3-7 and 9, Unbreakable. ASSUMED, to be confirmed: the jumppad letters (H G L K P Z O U) were
  // given as a set without a file mapping; they are assigned here in manifest order B BL BR L R T TL TR.
  const G = "g:Resources/Global/";
  const GLOBAL_SYMBOLS = Object.freeze({
    "s:global|water": "W",
    "s:global|rails": "Q",
    [G + "Spawns/1.png"]: "1", [G + "Spawns/2.png"]: "2",
    [G + "Objectives/Bounty.png"]: "8", [G + "Objectives/Box.png"]: "8", [G + "Objectives/Gem_Grab.png"]: "8", [G + "Objectives/Heist.png"]: "8",
    [G + "Objectives/Hot_Zone.png"]: "8", [G + "Objectives/Brawl_Ball.png"]: "8", [G + "Objectives/goalRed.png"]: "8", [G + "Objectives/goalBlue.png"]: "8",
    [G + "Special Tiles/HealPad.png"]: "y", [G + "Special Tiles/SpeedTile.png"]: "w", [G + "Special Tiles/SlowTile.png"]: "z",
    [G + "Special Tiles/Spikes.png"]: "v", [G + "Special Tiles/Smoke.png"]: "x",
    [G + "Teleporters/Blue.png"]: "c", [G + "Teleporters/Green.png"]: "d", [G + "Teleporters/Red.png"]: "e", [G + "Teleporters/Yellow.png"]: "f",
    [G + "Jumppads/B.png"]: "H", [G + "Jumppads/BL.png"]: "G", [G + "Jumppads/BR.png"]: "L", [G + "Jumppads/L.png"]: "K",
    [G + "Jumppads/R.png"]: "P", [G + "Jumppads/T.png"]: "Z", [G + "Jumppads/TL.png"]: "O", [G + "Jumppads/TR.png"]: "U",
  });
  const SPECIAL_SYMBOLS = Object.freeze({ warn: "6", space: "7" });
  // Symbol of a global / special ref, or null.
  const globalSymbol = ref => {
    if (Object.prototype.hasOwnProperty.call(SPECIAL_SYMBOLS, ref)) return SPECIAL_SYMBOLS[ref];
    return Object.prototype.hasOwnProperty.call(GLOBAL_SYMBOLS, ref) ? GLOBAL_SYMBOLS[ref] : null;
  };
  // Global / special refs that carry `symbol`, in table order.
  const globalRefsForSymbol = symbol => {
    const out = Object.keys(SPECIAL_SYMBOLS).filter(r => SPECIAL_SYMBOLS[r] === symbol);
    return out.concat(Object.keys(GLOBAL_SYMBOLS).filter(r => GLOBAL_SYMBOLS[r] === symbol));
  };

  // ── Symbols ───────────────────────────────────────────────────────────────────────────────────────────
  const isValidSymbol = s => typeof s === "string" && Array.from(s).length === 1 && s !== "/" && !/[\s\p{C}]/u.test(s);

  // ── Geometry ──────────────────────────────────────────────────────────────────────────────────────────
  // magnet: { col, row, size } (size 1-4) or null. Mirrors the app's getEffectiveCenter, in doubled integer form.
  const sizeDims = size => ({ szR: size === 2 || size === 4 ? 1 : 0, szC: size === 2 || size === 3 ? 1 : 0 });
  const effectiveSums = (w, h, magnet) => {
    if (!magnet) return { sumR: h - 1, sumC: w - 1 };
    const { szR, szC } = sizeDims(magnet.size || 1);
    return {
      sumR: Math.max(szR, Math.min(2 * (h - 1) - szR, 2 * magnet.row + szR)),
      sumC: Math.max(szC, Math.min(2 * (w - 1) - szC, 2 * magnet.col + szC)),
    };
  };
  // Same centre as the app: { cR, cC } (half-integers possible). cc = { r, c } or null, size = customCenterSize.
  const effectiveCenter = (w, h, cc, size) => {
    const s = effectiveSums(w, h, cc ? { col: cc.c, row: cc.r, size: size || 1 } : null);
    return { cR: s.sumR / 2, cC: s.sumC / 2 };
  };
  // The app's magnet state -> the seed's: null (default centre) or { col, row, size } with col,row inside the grid.
  const magnetFromApp = (w, h, cc, size) => {
    if (!cc || typeof cc.r !== "number" || typeof cc.c !== "number") return null;
    const sz = size >= 1 && size <= 4 ? size : 1;
    const m = { col: Math.max(0, Math.min(w - 1, Math.round(cc.c))), row: Math.max(0, Math.min(h - 1, Math.round(cc.r))), size: sz };
    const a = effectiveSums(w, h, m), d = effectiveSums(w, h, null);
    return a.sumR === d.sumR && a.sumC === d.sumC ? null : m;
  };
  // Default magnet size of a grid (the app's defaultSz).
  const defaultMagnetSize = (w, h) => (w % 2 === 0 && h % 2 === 0 ? 2 : w % 2 !== 0 && h % 2 === 0 ? 4 : w % 2 === 0 && h % 2 !== 0 ? 3 : 1);

  const imagesOf = (r, c, cls, w, h, sums) => {
    const out = [];
    const add = (r2, c2) => { if (r2 >= 0 && r2 < h && c2 >= 0 && c2 < w && !(r2 === r && c2 === c) && !out.some(p => p[0] === r2 && p[1] === c2)) out.push([r2, c2]); };
    if (cls === "h" || cls === "4") add(r, sums.sumC - c);
    if (cls === "v" || cls === "4") add(sums.sumR - r, c);
    if (cls === "d" || cls === "4") add(sums.sumR - r, sums.sumC - c);
    return out;
  };
  const precedes = (r2, c2, r, c) => r2 < r || (r2 === r && c2 < c);
  // Region cells [[r, c], ...] in row-major order.
  const regionCells = (w, h, sums, cls) => {
    const out = [];
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      if (!imagesOf(r, c, cls, w, h, sums).some(([r2, c2]) => precedes(r2, c2, r, c))) out.push([r, c]);
    }
    return out;
  };
  const holds = (grid, w, h, sums, cls) => {
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      for (const [r2, c2] of imagesOf(r, c, cls, w, h, sums)) if (grid[r2][c2] !== grid[r][c]) return false;
    }
    return true;
  };
  // grid: rows of comparable cell values. -> the strongest class that holds exactly (see header).
  const detectMirror = (grid, w, h, magnet) => {
    const sums = effectiveSums(w, h, magnet);
    let best = "a", bestSize = w * h;
    for (const cls of CLASSES) {
      if (cls === "a") continue;
      if (!holds(grid, w, h, sums, cls)) continue;
      const n = regionCells(w, h, sums, cls).length;
      if (n < bestSize) { best = cls; bestSize = n; }
    }
    return best;
  };

  // ── Fields ────────────────────────────────────────────────────────────────────────────────────────────
  const encodeSize = (w, h) => {
    if (w === SIZE_3V3.w && h === SIZE_3V3.h) return "3v3";
    if (w === SIZE_SD.w && h === SIZE_SD.h) return "SD";
    return w + "x" + h;
  };
  const parseSize = s => {
    if (s === "3v3") return { w: SIZE_3V3.w, h: SIZE_3V3.h };
    if (s === "SD") return { w: SIZE_SD.w, h: SIZE_SD.h };
    const m = /^([1-9]\d?)x([1-9]\d?)$/.exec(s);
    if (!m) return null;
    return { w: Number(m[1]), h: Number(m[2]) };
  };
  const encodeMagnet = m => (m ? m.col + "," + m.row + (m.size && m.size !== 1 ? "," + m.size : "") : "x");
  // -> null (default centre) | { col, row, size } | undefined (malformed)
  const parseMagnet = (s, w, h) => {
    if (s === "x") return null;
    const m = /^(0|[1-9]\d?),(0|[1-9]\d?)(?:,([234]))?$/.exec(s);
    if (!m) return undefined;
    const col = Number(m[1]), row = Number(m[2]);
    if (col >= w || row >= h) return undefined;
    return { col, row, size: m[3] ? Number(m[3]) : 1 };
  };

  // ── Base62 / bits ─────────────────────────────────────────────────────────────────────────────────────
  const CHUNK = 8, CHUNK_BASE = BigInt(62) ** BigInt(CHUNK);
  const bitsToBase62 = bits => {
    let n = BigInt("0b1" + bits);
    const parts = [];
    while (n > BigInt(0)) {
      let v = Number(n % CHUNK_BASE);
      n = n / CHUNK_BASE;
      let s = "";
      for (let i = 0; i < CHUNK; i++) { s = B62[v % 62] + s; v = Math.floor(v / 62); }
      parts.push(s);
    }
    const out = parts.reverse().join("").replace(/^0+/, "");
    return out;
  };
  // -> bit string (sentinel removed) or null when the text is not canonical base62
  const base62ToBits = text => {
    if (!text || !/^[0-9A-Za-z]+$/.test(text) || text[0] === "0") return null;
    let n = BigInt(0);
    const first = text.length % CHUNK;
    const chunks = [];
    if (first) chunks.push(text.slice(0, first));
    for (let i = first; i < text.length; i += CHUNK) chunks.push(text.slice(i, i + CHUNK));
    for (const ch of chunks) {
      let v = 0;
      for (const c of ch) v = v * 62 + B62.indexOf(c);
      n = n * BigInt(62) ** BigInt(ch.length) + BigInt(v);
    }
    return n.toString(2).slice(1);
  };
  const bitLength = n => (n === 0 ? 0 : n.toString(2).length);
  const gamma = n => { const b = n.toString(2); return "0".repeat(b.length - 1) + b; };

  // ── Encode ────────────────────────────────────────────────────────────────────────────────────────────
  // input: { w, h, grid: rows of a symbol (one code point) or null, magnet: null | { col, row, size }, tileset: seed_id }
  // -> { seed, fields: { size, magnet, mirror, tileset, palette, code }, mirror, palette: [symbols], regionSize, runs }
  // Throws on malformed input (a programming error); decode never throws.
  const encode = ({ w, h, grid, magnet = null, tileset }) => {
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > MAX_DIM || h > MAX_DIM) throw new Error("size must be 1-" + MAX_DIM + " by 1-" + MAX_DIM);
    if (!Number.isInteger(tileset) || tileset < 0) throw new Error("tileset seed_id must be a non-negative integer");
    if (!Array.isArray(grid) || grid.length !== h || grid.some(row => !Array.isArray(row) || row.length !== w)) throw new Error("grid does not match " + w + "x" + h);
    const counts = new Map();
    for (const row of grid) for (const s of row) {
      if (s == null) continue;
      if (!isValidSymbol(s)) throw new Error("invalid symbol: " + JSON.stringify(s));
      counts.set(s, (counts.get(s) || 0) + 1);
    }
    const palette = Array.from(counts.keys()).sort((a, b) => (counts.get(b) - counts.get(a)) || (a.codePointAt(0) - b.codePointAt(0)));
    if (palette.length > MAX_PALETTE) throw new Error("too many distinct symbols");
    const indexOf = new Map(palette.map((s, i) => [s, i + 1]));
    const idx = grid.map(row => row.map(s => (s == null ? 0 : indexOf.get(s))));
    // A magnet at the default centre is the default.
    const sums0 = effectiveSums(w, h, null), sumsM = effectiveSums(w, h, magnet);
    const mag = magnet && !(sums0.sumR === sumsM.sumR && sums0.sumC === sumsM.sumC)
      ? { col: Math.max(0, Math.min(w - 1, magnet.col)), row: Math.max(0, Math.min(h - 1, magnet.row)), size: magnet.size || 1 } : null;
    const mirror = detectMirror(idx, w, h, mag);
    const sums = effectiveSums(w, h, mag);
    const cells = regionCells(w, h, sums, mirror);
    const k = bitLength(palette.length);
    let bits = "", runs = 0, i = 0;
    while (i < cells.length) {
      const v = idx[cells[i][0]][cells[i][1]];
      let j = i + 1;
      while (j < cells.length && idx[cells[j][0]][cells[j][1]] === v) j++;
      if (k) bits += v.toString(2).padStart(k, "0");
      bits += gamma(j - i);
      runs++; i = j;
    }
    const fields = { size: encodeSize(w, h), magnet: encodeMagnet(mag), mirror, tileset: String(tileset), palette: palette.join(""), code: bitsToBase62(bits) };
    return { seed: [fields.size, fields.magnet, fields.mirror, fields.tileset, fields.palette, fields.code].join("/"), fields, mirror, palette, regionSize: cells.length, runs, magnet: mag };
  };

  // ── Decode ────────────────────────────────────────────────────────────────────────────────────────────
  // Pulls the seed out of pasted text: a bare seed, "seed=<seed>", or a link with "#seed=<seed>" (percent-decoded). -> { text } | { error }
  const extractSeed = input => {
    let t = String(input == null ? "" : input).trim();
    const hit = t.search(/[#?&]?seed=/);
    const linked = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) || t.startsWith("#") || t.startsWith("seed=");
    if (linked && hit !== -1) {
      t = t.slice(t.indexOf("seed=", hit) + 5);
      try { t = decodeURIComponent(t); } catch { return { error: "The link's seed has broken % escapes." }; }
    } else if (linked) return { error: "The link has no #seed= part." };
    return { text: t.trim() };
  };

  // Never throws. -> { ok, error, errorField, seed, size:{w,h}|null, magnet (null default | {col,row,size}) , mirror, tileset, palette:[symbols]|null,
  //   regionSize, runs, cellCount, grid (rows of symbol|null) } where fields before the failing one are filled in.
  const decode = input => {
    const res = { ok: false, error: null, errorField: null, seed: null, size: null, magnet: undefined, mirror: null, tileset: null, palette: null, regionSize: null, runs: null, cellCount: null, grid: null };
    const fail = (field, msg) => { res.error = msg; res.errorField = field; return res; };
    try {
      const ex = extractSeed(input);
      if (ex.error) return fail(null, ex.error);
      const text = ex.text;
      res.seed = text;
      if (!text) return fail(null, "Paste a seed first.");
      if (text.length > MAX_SEED_CHARS) return fail(null, "That seed is too long.");
      if (/\s/.test(text)) return fail(null, "A seed has no spaces or line breaks.");
      const f = text.split("/");
      if (f.length !== 6) return fail(null, "A seed has 6 parts separated by \"/\" (size/magnet/mirror/tileset/palette/code), found " + f.length + ".");
      const [sizeS, magS, mirS, tsS, palS, codeS] = f;
      const size = parseSize(sizeS);
      if (!size) return fail("size", "Size \"" + sizeS + "\" is not valid (use 3v3, SD or WxH with 1-" + MAX_DIM + " each).");
      res.size = size;
      const magnet = parseMagnet(magS, size.w, size.h);
      if (magnet === undefined) return fail("magnet", "Magnet \"" + magS + "\" is not valid (x, or col,row with an optional ,2 / ,3 / ,4 inside the " + size.w + "x" + size.h + " grid).");
      res.magnet = magnet;
      if (!Object.prototype.hasOwnProperty.call(CLASS_FLAGS, mirS)) return fail("mirror", "Mirror \"" + mirS + "\" is not valid (use d, h, v, 4 or a).");
      res.mirror = mirS;
      if (!/^(0|[1-9]\d{0,9})$/.test(tsS) || Number(tsS) > 2147483647) return fail("tileset", "Tileset \"" + tsS + "\" is not a valid seed_id.");
      res.tileset = Number(tsS);
      const palette = Array.from(palS);
      if (palette.length > MAX_PALETTE) return fail("palette", "The palette is too long.");
      const seen = new Set();
      for (const s of palette) {
        if (!isValidSymbol(s)) return fail("palette", "The palette has a character that cannot be a tile symbol.");
        if (seen.has(s)) return fail("palette", "The palette lists \"" + s + "\" twice.");
        seen.add(s);
      }
      res.palette = palette;
      const sums = effectiveSums(size.w, size.h, magnet);
      const cells = regionCells(size.w, size.h, sums, mirS);
      res.regionSize = cells.length;
      if (!codeS) return fail("code", "The cell code is missing.");
      if (codeS.length > MAX_CODE_CHARS) return fail("code", "The cell code is too long.");
      const bits = base62ToBits(codeS);
      if (bits === null) return fail("code", "The cell code must be base62 (0-9, A-Z, a-z) without a leading 0.");
      const k = bitLength(palette.length);
      const values = [];
      let pos = 0, runs = 0;
      while (pos < bits.length) {
        let v = 0;
        if (k) {
          if (pos + k > bits.length) return fail("code", "The cell code ends in the middle of a run (truncated).");
          v = parseInt(bits.slice(pos, pos + k), 2); pos += k;
          if (v > palette.length) return fail("code", "The cell code uses tile number " + v + " but the palette has " + palette.length + " tile" + (palette.length === 1 ? "" : "s") + ".");
        }
        let z = 0;
        while (pos < bits.length && bits[pos] === "0") { z++; pos++; if (z > 20) return fail("code", "The cell code has a run that is far too long."); }
        if (pos >= bits.length) return fail("code", "The cell code ends in the middle of a run (truncated).");
        if (pos + 1 + z > bits.length) return fail("code", "The cell code ends in the middle of a run (truncated).");
        const n = parseInt(bits.slice(pos, pos + 1 + z), 2); pos += 1 + z;
        runs++;
        if (values.length + n > cells.length) return fail("code", "The cell code holds more cells than the map: the " + cells.length + " cells of the " + (mirS === "a" ? "map" : "mirrored region") + " were exceeded (map is " + size.w * size.h + " cells).");
        for (let i = 0; i < n; i++) values.push(v);
      }
      res.runs = runs;
      res.cellCount = values.length;
      if (values.length !== cells.length) return fail("code", "The cell code holds " + values.length + " cells but a " + size.w + "x" + size.h + " map needs " + cells.length + (mirS === "a" ? "" : " for its mirrored region (the full map is " + size.w * size.h + ")") + ".");
      const out = Array.from({ length: size.h }, () => Array(size.w).fill(undefined));
      cells.forEach(([r, c], i) => {
        const sym = values[i] === 0 ? null : palette[values[i] - 1];
        out[r][c] = sym;
        for (const [r2, c2] of imagesOf(r, c, mirS, size.w, size.h, sums)) out[r2][c2] = sym;
      });
      let total = 0;
      for (const row of out) for (const s of row) { if (s === undefined) return fail("code", "Internal error: a cell was not filled."); total++; }
      if (total !== size.w * size.h) return fail("code", "The decoded cell count does not equal " + size.w * size.h + ".");
      res.cellCount = total;
      res.grid = out;
      res.ok = true;
      return res;
    } catch (e) {
      return fail(res.errorField, "That seed could not be read (" + (e && e.message ? e.message : "unknown error") + ").");
    }
  };

  // ── Export helpers ────────────────────────────────────────────────────────────────────────────────────
  // grid of palette indexes + refs + symbolOf(ref) -> { grid: rows of symbol|null, blanks: { upload, noSymbol, badSymbol } (cell counts) }
  const symbolizeGrid = (grid, refs, symbolOf) => {
    const blanks = { upload: 0, noSymbol: 0, badSymbol: 0 };
    const cache = new Map();
    const symFor = idx => {
      if (cache.has(idx)) return cache.get(idx);
      const ref = refs[idx];
      let out = null, kind = null;
      if (typeof ref !== "string") kind = "noSymbol";
      else if (ref.startsWith("u:")) kind = "upload";
      else {
        const s = symbolOf(ref);
        if (s == null || s === "") kind = "noSymbol";
        else if (!isValidSymbol(s)) kind = "badSymbol";
        else if ((s === SPECIAL_SYMBOLS.warn && ref !== "warn") || (s === SPECIAL_SYMBOLS.space && ref !== "space")) kind = "badSymbol"; // 6 / 7 belong to warn / space
        else out = s;
      }
      const v = { out, kind };
      cache.set(idx, v);
      return v;
    };
    const out = grid.map(row => row.map(idx => {
      if (idx == null) return null;
      const v = symFor(idx);
      if (v.kind) blanks[v.kind]++;
      return v.out;
    }));
    return { grid: out, blanks };
  };
  const blankSummary = blanks => {
    const n = blanks.upload + blanks.noSymbol + blanks.badSymbol;
    if (!n) return null;
    const parts = [];
    if (blanks.upload) parts.push(blanks.upload + " local upload");
    if (blanks.noSymbol) parts.push(blanks.noSymbol + " without a symbol");
    if (blanks.badSymbol) parts.push(blanks.badSymbol + " with an unusable symbol");
    return n + " cells use tiles without symbols or local uploads and will be blank (" + parts.join(", ") + ").";
  };

  // ── Import helpers ────────────────────────────────────────────────────────────────────────────────────
  // entries: [{ ref, symbol, ... }] (plain tiles and sensor folders, variants excluded) -> Map(symbol -> [entry])
  const indexBySymbol = entries => {
    const m = new Map();
    for (const e of entries) {
      if (!e || !isValidSymbol(e.symbol)) continue;
      if (!m.has(e.symbol)) m.set(e.symbol, []);
      if (!m.get(e.symbol).some(x => x.ref === e.ref)) m.get(e.symbol).push(e);
    }
    return m;
  };
  // Candidates per palette symbol: the seed's tileset first, then the global tileset (specials 6 / 7 are always the warn / space tile).
  // tilesetIndex / globalIndex: Map(symbol -> [entry]). -> [{ symbol, candidates: [entry], source: "tileset"|"global"|null }]
  const resolveSymbols = (palette, tilesetIndex, globalIndex) => palette.map(symbol => {
    const sp = Object.keys(SPECIAL_SYMBOLS).find(r => SPECIAL_SYMBOLS[r] === symbol);
    if (sp) return { symbol, candidates: [{ ref: sp, symbol }], source: "global" };
    const t = tilesetIndex && tilesetIndex.get(symbol);
    if (t && t.length) return { symbol, candidates: t, source: "tileset" };
    const g = globalIndex && globalIndex.get(symbol);
    if (g && g.length) return { symbol, candidates: g, source: "global" };
    return { symbol, candidates: [], source: null };
  });
  // decoded symbol grid + chosen: Map(symbol -> ref|null) -> { grid (rows of ref|null), refs (palette refs in first-use order), missing: cells blanked }
  const gridToRefs = (symGrid, chosen) => {
    const refs = [], at = new Map();
    let missing = 0;
    const grid = symGrid.map(row => row.map(s => {
      if (s == null) return null;
      const ref = chosen.get(s);
      if (!ref) { missing++; return null; }
      if (!at.has(ref)) { at.set(ref, refs.length); refs.push(ref); }
      return at.get(ref);
    }));
    return { grid, refs, missing };
  };

  return {
    B62, MAX_DIM, CLASSES, CLASS_FLAGS, CLASS_NAMES, MAGNET_SIZE_NAMES, GLOBAL_SYMBOLS, SPECIAL_SYMBOLS,
    globalSymbol, globalRefsForSymbol, isValidSymbol,
    effectiveSums, effectiveCenter, magnetFromApp, defaultMagnetSize, imagesOf, regionCells, detectMirror,
    encodeSize, parseSize, encodeMagnet, parseMagnet, bitsToBase62, base62ToBits,
    encode, decode, extractSeed, symbolizeGrid, blankSummary, indexBySymbol, resolveSymbols, gridToRefs,
  };
});
