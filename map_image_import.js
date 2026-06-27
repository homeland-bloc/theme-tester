/**
 * map_image_import.js — standalone PNG-to-grid import feature for Opheliapp
 *
 * Usage:
 *   MapImport.init(appInterface)   called once from index.html after tiles load
 *   MapImport.open()               called by the "Import Map" button
 *
 * appInterface shape:
 *   flatDefaultTiles   Array    all tile objects (DB + global)
 *   dbTilesets         Array    tileset metadata
 *   getTileMultiplier  fn(t)→float
 *   getTileOffset      fn(t)→{ox,oy}
 *   isPriority         fn(t)→bool
 *   isBottomRender     fn(t)→bool
 *   setGrid            fn(grid2D)
 *   setGridW           fn(w)
 *   setGridH           fn(h)
 *   gridW, gridH       int      current grid dimensions
 */
(function () {
  'use strict';

  // ── Config ─────────────────────────────────────────────────────────────
  const DEBUG = true;
  const CELL = 32;

  // Hardcoded BG colours for Ophelia tilesets — used for auto-detecting tileset
  // from the detected checkerboard palette.
  const OPHELIA_BG = {
    Airport:   { bg1: '#9cacbc', bg2: '#94a2b2' },
    Mausoleum: { bg1: '#67717d', bg2: '#6e7986' },
    Sewer:     { bg1: '#4F594A', bg2: '#586352' },
    Halloween: { bg1: '#3A313E', bg2: '#413643' },
    Cafe:      { bg1: '#AD6B45', bg2: '#B5714A' },
    Pharmacy:  { bg1: '#95a4ae', bg2: '#a2b0b8' },
  };

  const FAST_THRESHOLD = 15;    // max total RGB dist (both bg channels) for fast-path acceptance
  const SCAN_THRESHOLD = 40;    // max total RGB dist for fallback-scan acceptance
  const CONFIDENCE_MARGIN = 0.15; // winning tile's SSD must beat bg SSD by at least this fraction

  // ── Module state ───────────────────────────────────────────────────────
  let _app = null;       // injected app interface
  let _overlayEl = null; // DOM node for the modal overlay

  // ── Public API ─────────────────────────────────────────────────────────

  function init(appInterface) {
    _app = appInterface;
    if (DEBUG) {
      console.log('[MapImport] init() — tiles:', appInterface.flatDefaultTiles?.length ?? 0,
        '  tilesets:', appInterface.dbTilesets?.length ?? 0);
    }
  }

  function open() {
    if (!_app) {
      console.warn('[MapImport] Not initialised — call MapImport.init() first');
      return;
    }
    if (_overlayEl) {
      _overlayEl.style.display = 'flex';
      return;
    }
    _buildModal();
  }

  // ── Theme helper ───────────────────────────────────────────────────────

  function _theme() {
    const cold = document.documentElement.getAttribute('data-theme') === 'cold';
    return cold ? {
      bg: '#06101a', panel: '#0a1b2e', panelDeep: '#071320',
      border: 'rgba(56,189,248,0.22)', accent: '#38bdf8',
      accentDim: 'rgba(56,189,248,0.15)', text: '#e2f0fe',
      muted: 'rgba(226,240,254,0.45)', danger: '#f87171', success: '#4ade80',
    } : {
      bg: '#1a0f06', panel: '#2b1a0a', panelDeep: '#1f1207',
      border: 'rgba(251,146,60,0.18)', accent: '#fb923c',
      accentDim: 'rgba(251,146,60,0.14)', text: '#fef3e2',
      muted: 'rgba(254,243,226,0.45)', danger: '#f87171', success: '#4ade80',
    };
  }

  // ── DOM helpers ────────────────────────────────────────────────────────

  function _el(tag, css) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    return e;
  }

  function _btnCss(C, primary) {
    return [
      'flex:1', 'padding:7px 12px', 'border-radius:7px',
      'font-size:12px', 'font-weight:600', 'cursor:pointer',
      'user-select:none', 'outline:none',
      "font-family:'Inter',sans-serif", 'transition:all 0.12s',
      `background:${primary ? C.accentDim : 'rgba(255,255,255,0.04)'}`,
      `color:${primary ? C.accent : C.muted}`,
      `border:1px solid ${primary ? C.accent : 'rgba(255,255,255,0.1)'}`,
    ].join(';');
  }

  function _inputCss(C, w) {
    return [
      `width:${w || '64px'}`, 'background:rgba(0,0,0,0.22)',
      `border:1px solid ${C.border}`, 'border-radius:5px',
      `color:${C.text}`, 'font-size:12px', 'padding:4px 7px',
      "font-family:'Inter',monospace", 'outline:none',
    ].join(';');
  }

  function _tick() { return new Promise(r => setTimeout(r, 0)); }

  // ── Modal construction ─────────────────────────────────────────────────

  function _buildModal() {
    const C = _theme();

    // ── overlay ──────────────────────────────────────────────────────────
    const overlay = _el('div', [
      'position:fixed', 'inset:0', 'background:rgba(0,0,0,0.78)',
      'display:flex', 'align-items:center', 'justify-content:center',
      'z-index:10002', 'padding:20px', "font-family:'Inter',sans-serif",
    ].join(';'));
    _overlayEl = overlay;

    const box = _el('div', [
      `background:${C.panel}`, `border:1px solid ${C.border}`, 'border-radius:14px',
      'padding:22px', 'max-width:530px', 'width:100%',
      'display:flex', 'flex-direction:column', 'gap:14px',
      'max-height:92vh', 'overflow-y:auto',
    ].join(';'));

    // ── modal-local state ─────────────────────────────────────────────────
    let imgFile = null;
    let imgEl   = null;   // original Image element (for preview redraws)
    let imgW = 0, imgH = 0;
    let imgCtx = null;            // 2d context with willReadFrequently
    let fullImgData = null;       // pre-fetched ImageData for the whole source image
    let detectedOrigin = null;    // { ox, oy, bg1, bg2 }
    let selectedTsId = null;
    let importGridW = 21, importGridH = 33;
    let isExtracting = false;

    // ── header ────────────────────────────────────────────────────────────
    const header = _el('div', 'display:flex;align-items:center;justify-content:space-between;');
    const titleEl = _el('span', `font-size:14px;font-weight:700;color:${C.accent};`);
    titleEl.textContent = 'Import Map from PNG';
    const closeBtn = _el('button',
      `background:none;border:none;cursor:pointer;color:${C.muted};font-size:22px;line-height:1;padding:0 4px;outline:none;`);
    closeBtn.textContent = '×';
    closeBtn.onclick = () => { overlay.style.display = 'none'; };
    header.append(titleEl, closeBtn);

    // ── drop zone ─────────────────────────────────────────────────────────
    const dropZone = _el('div', [
      `border:2px dashed ${C.border}`, 'border-radius:10px', 'padding:28px 20px',
      'text-align:center', 'cursor:pointer', `color:${C.muted}`,
      'font-size:13px', 'transition:border-color 0.15s,color 0.15s',
      `background:${C.panelDeep}`, 'user-select:none',
    ].join(';'));
    dropZone.textContent = 'Drop exported map PNG here, or click to browse';

    const fileInput = _el('input', 'display:none;');
    fileInput.type = 'file';
    fileInput.accept = 'image/png,image/jpeg';

    dropZone.onclick = () => fileInput.click();
    dropZone.ondragover = e => { e.preventDefault(); dropZone.style.borderColor = C.accent; };
    dropZone.ondragleave = () => { dropZone.style.borderColor = C.border; };
    dropZone.ondrop = e => {
      e.preventDefault();
      dropZone.style.borderColor = C.border;
      const f = e.dataTransfer.files[0];
      if (f) handleFile(f);
    };
    fileInput.onchange = () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); };

    // ── config section (shown after image load) ───────────────────────────
    const configSection = _el('div', 'display:none;flex-direction:column;gap:10px;');

    // tileset selector
    const tsRow = _el('div', 'display:flex;align-items:center;gap:8px;');
    const tsLabel = _el('span', `font-size:11px;color:${C.muted};width:90px;flex-shrink:0;`);
    tsLabel.textContent = 'Tileset';
    const tsSelect = _el('select', [
      'flex:1', `background:${C.panelDeep}`, `border:1px solid ${C.border}`,
      'border-radius:5px', `color:${C.text}`, 'font-size:12px',
      'padding:4px 7px', 'outline:none',
    ].join(';'));
    const byAlpha = (a, b) => a.name.localeCompare(b.name);
    const opheliaTsList = [...(_app.dbTilesets || [])].filter(ts => ts.type === 'base' || ts.type === 'custom').sort((a, b) => { const si = (a.sort_index ?? 9999) - (b.sort_index ?? 9999); return si !== 0 ? si : byAlpha(a, b); });
    const atlasTsList   = [...(_app.dbTilesets || [])].filter(ts => ts.type === 'atlas' || ts.type === 'atlas2').sort((a, b) => (a.type === b.type ? byAlpha(a, b) : a.type === 'atlas' ? -1 : 1));
    const _addGroup = (label, list) => {
      if (!list.length) return;
      const grp = document.createElement('optgroup');
      grp.label = label;
      list.forEach(ts => {
        const opt = document.createElement('option');
        opt.value = ts.id;
        opt.textContent = ts.name;
        grp.appendChild(opt);
      });
      tsSelect.appendChild(grp);
    };
    _addGroup('Opheliapp', opheliaTsList);
    _addGroup('Atlas', atlasTsList);
    const firstTs = opheliaTsList[0] ?? atlasTsList[0];
    if (firstTs) {
      selectedTsId = firstTs.id;
      tsSelect.value = selectedTsId;
    }
    tsSelect.onchange = () => {
      selectedTsId = tsSelect.value;
      // When the image had no automatic match, derive bg colors from the chosen tileset
      // so runExtraction() has usable palette data for SSD comparison.
      if (detectedOrigin && !detectedOrigin.matched) _applyBgFromTileset(selectedTsId);
      updatePreview();
      // Prefetch tiles in the background so Extract doesn't stall when this tileset
      // hasn't been loaded in the main editor yet.
      if (_app.ensureTilesetLoaded) _app.ensureTilesetLoaded(selectedTsId);
    };
    tsRow.append(tsLabel, tsSelect);

    // grid size inputs
    const sizeRow = _el('div', 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;');
    const sizeLabel = _el('span', `font-size:11px;color:${C.muted};width:90px;flex-shrink:0;`);
    sizeLabel.textContent = 'Grid (W × H)';
    const wIn = _el('input', _inputCss(C));
    wIn.type = 'number'; wIn.min = '1'; wIn.max = '200'; wIn.value = '21';
    const xSpan = _el('span', `color:${C.muted};font-size:12px;`);
    xSpan.textContent = '×';
    const hIn = _el('input', _inputCss(C));
    hIn.type = 'number'; hIn.min = '1'; hIn.max = '200'; hIn.value = '33';
    wIn.oninput = () => { importGridW = Math.max(1, parseInt(wIn.value) || 21); updatePreview(); };
    hIn.oninput = () => { importGridH = Math.max(1, parseInt(hIn.value) || 33); updatePreview(); };
    sizeRow.append(sizeLabel, wIn, xSpan, hIn);

    // bg colour display
    const bgRow = _el('div', 'display:flex;align-items:center;gap:8px;');
    const bgLabel = _el('span', `font-size:11px;color:${C.muted};width:90px;flex-shrink:0;`);
    bgLabel.textContent = 'Detected BG';
    const bgSwatchWrap = _el('div', 'display:flex;align-items:center;gap:6px;');
    const bgSwatch1 = _el('div', 'width:18px;height:18px;border-radius:3px;border:1px solid rgba(255,255,255,0.15);');
    const bgSwatch2 = _el('div', 'width:18px;height:18px;border-radius:3px;border:1px solid rgba(255,255,255,0.15);');
    const bgHexEl   = _el('span', `font-size:10px;color:${C.muted};font-family:monospace;`);
    bgSwatchWrap.append(bgSwatch1, bgSwatch2, bgHexEl);
    bgRow.append(bgLabel, bgSwatchWrap);

    // preview canvas with grid overlay
    const previewWrap = _el('div', [
      'border-radius:6px', 'overflow:hidden', `background:${C.panelDeep}`,
      'display:flex', 'justify-content:center', 'align-items:center', 'min-height:60px',
    ].join(';'));
    const previewCanvas = _el('canvas',
      'max-width:100%;max-height:220px;image-rendering:pixelated;display:block;');
    previewWrap.appendChild(previewCanvas);

    configSection.append(tsRow, sizeRow, bgRow, previewWrap);

    // ── status + progress ─────────────────────────────────────────────────
    const statusEl = _el('div', `font-size:11px;color:${C.muted};min-height:16px;`);
    const progressWrap = _el('div', [
      'height:4px', 'border-radius:2px', `background:${C.panelDeep}`,
      'overflow:hidden', 'display:none',
    ].join(';'));
    const progressBar = _el('div',
      `height:100%;width:0%;background:${C.accent};transition:width 0.08s;`);
    progressWrap.appendChild(progressBar);

    // ── buttons ───────────────────────────────────────────────────────────
    const btnRow = _el('div', 'display:flex;gap:8px;margin-top:2px;');
    const cancelBtn = _el('button', _btnCss(C, false));
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = () => { overlay.style.display = 'none'; };
    const extractBtn = _el('button', _btnCss(C, true));
    extractBtn.textContent = 'Extract';
    extractBtn.disabled = true;
    extractBtn.onclick = () => { if (!isExtracting) runExtraction(); };
    btnRow.append(cancelBtn, extractBtn);

    box.append(header, dropZone, fileInput, configSection, statusEl, progressWrap, btnRow);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) overlay.style.display = 'none'; });

    // ── file handler ──────────────────────────────────────────────────────
    function handleFile(f) {
      imgFile = f;
      const blobUrl = URL.createObjectURL(f);
      const img = new Image();
      img.onload = () => {
        imgEl = img;
        imgW = img.naturalWidth;
        imgH = img.naturalHeight;

        // Build a source canvas with willReadFrequently for fast per-cell getImageData
        const srcCv = document.createElement('canvas');
        srcCv.width = imgW; srcCv.height = imgH;
        imgCtx = srcCv.getContext('2d', { willReadFrequently: true });
        imgCtx.drawImage(img, 0, 0);

        // Grab the full image data once for origin detection
        fullImgData = imgCtx.getImageData(0, 0, imgW, imgH);
        URL.revokeObjectURL(blobUrl);

        dropZone.textContent = `${f.name} (${imgW}×${imgH})`;
        dropZone.style.color = C.text;
        configSection.style.display = 'flex';

        // Detect grid origin + tileset in one step
        const t0 = performance.now();
        const det = _detectOrigin(fullImgData.data, imgW, imgH);
        if (DEBUG) console.log(`[MapImport] Detection in ${(performance.now() - t0).toFixed(1)}ms:`, det);

        if (det === null) {
          // Image too small — still let the user try with manual settings
          detectedOrigin = { ox: 0, oy: CELL, bg1: null, bg2: null, tilesetId: null, matched: false };
          bgSwatch1.style.background = 'transparent';
          bgSwatch2.style.background = 'transparent';
          bgHexEl.textContent = '—';
          statusEl.textContent = 'Image too small to detect grid. Check dimensions and set manually.';
        } else if (det.matched) {
          detectedOrigin = det;
          bgSwatch1.style.background = det.bg1;
          bgSwatch2.style.background = det.bg2;
          bgHexEl.textContent = `${det.bg1}  /  ${det.bg2}`;
          statusEl.textContent = `Grid detected at origin (${det.ox}, ${det.oy}).`;
          if (det.tilesetId) { tsSelect.value = det.tilesetId; selectedTsId = det.tilesetId; }
        } else {
          // Processable image but no known-palette match; leave ox/oy at default,
          // fill bg from whatever tileset the user has selected so extraction still works.
          detectedOrigin = det;
          _applyBgFromTileset(selectedTsId);
          statusEl.textContent = "Couldn't match a known tileset — set origin and tileset manually.";
        }

        extractBtn.disabled = false;
        updatePreview();
      };
      img.onerror = () => {
        statusEl.textContent = 'Failed to load image.';
        URL.revokeObjectURL(blobUrl);
      };
      img.src = blobUrl;
    }

    // ── preview updater ───────────────────────────────────────────────────
    function updatePreview() {
      if (!imgEl || !detectedOrigin) return;
      const { ox, oy } = detectedOrigin;
      const maxW = Math.max(200, (box.offsetWidth || 490) - 44);
      const scale = Math.min(1, maxW / Math.max(1, imgW), 220 / Math.max(1, imgH));
      previewCanvas.width  = Math.max(1, Math.round(imgW  * scale));
      previewCanvas.height = Math.max(1, Math.round(imgH * scale));
      const pCtx = previewCanvas.getContext('2d');
      pCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
      pCtx.drawImage(imgEl, 0, 0, previewCanvas.width, previewCanvas.height);

      // Grid overlay
      pCtx.strokeStyle = 'rgba(255,70,70,0.7)';
      pCtx.lineWidth = 0.5;
      for (let c = 0; c <= importGridW; c++) {
        const x = (ox + c * CELL) * scale;
        pCtx.beginPath();
        pCtx.moveTo(x, oy * scale);
        pCtx.lineTo(x, (oy + importGridH * CELL) * scale);
        pCtx.stroke();
      }
      for (let r = 0; r <= importGridH; r++) {
        const y = (oy + r * CELL) * scale;
        pCtx.beginPath();
        pCtx.moveTo(ox * scale, y);
        pCtx.lineTo((ox + importGridW * CELL) * scale, y);
        pCtx.stroke();
      }
    }

    // ── extraction ────────────────────────────────────────────────────────
    async function runExtraction() {
      if (!detectedOrigin || !selectedTsId || !imgCtx) return;
      isExtracting = true;
      extractBtn.disabled = true;
      cancelBtn.disabled = true;
      progressWrap.style.display = 'block';
      statusEl.style.color = C.muted;
      statusEl.textContent = 'Loading tile images…';

      const t0 = DEBUG ? performance.now() : 0;
      const { ox, oy, bg1, bg2 } = detectedOrigin;

      // Ensure the selected tileset's tiles are loaded (fetches if not already cached).
      // This handles the case where the user picks a tileset they haven't visited in
      // the main editor yet, which would otherwise produce an empty tile list.
      statusEl.textContent = 'Loading tiles…';
      let allTiles;
      if (_app.ensureTilesetLoaded) {
        allTiles = await _app.ensureTilesetLoaded(selectedTsId);
      } else {
        allTiles = (_app.flatDefaultTiles || []).filter(t => t.isDb && t.tilesetId === selectedTsId);
      }

      if (!allTiles.length) {
        statusEl.textContent =
          'No tiles found for this tileset. The tileset may be empty or unavailable.';
        isExtracting = false;
        extractBtn.disabled = false;
        cancelBtn.disabled = false;
        return;
      }

      // ── Load tile images (crossOrigin required for getImageData) ─────────
      const tileImgs = new Map(); // tile.id → HTMLImageElement
      await Promise.all(allTiles.map(tile => new Promise(resolve => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload  = () => { tileImgs.set(tile.id, img); resolve(); };
        img.onerror = () => resolve(); // skip unavailable tiles
        img.src = tile.src;
      })));

      if (DEBUG) {
        console.log(`[MapImport] ${tileImgs.size}/${allTiles.length} tile images loaded`,
          `in ${(performance.now() - t0).toFixed(0)}ms`);
      }

      // ── Offscreen canvas for tile compositing ─────────────────────────────
      // A fresh canvas per extraction session avoids any CORS-taint carry-over.
      const ofc  = document.createElement('canvas');
      ofc.width  = CELL; ofc.height = CELL;
      const octx = ofc.getContext('2d', { willReadFrequently: true });

      // Returns ImageData for a CELL×CELL tile composite on the given bg colour.
      // Mirrors the export renderer: tile drawn centred at (CELL/2 + ox%, CELL/2 + oy%)
      // with drawW = CELL * multiplier and drawH proportional.
      function composeTile(img, mult, off, bgColor) {
        octx.clearRect(0, 0, CELL, CELL);
        octx.fillStyle = bgColor;
        octx.fillRect(0, 0, CELL, CELL);
        const drawW = CELL * mult;
        const iW    = img.naturalWidth  || img.width  || 1;
        const iH    = img.naturalHeight || img.height || 1;
        const drawH = drawW * (iH / iW);
        const cx = CELL / 2 + (off.ox / 100) * CELL;
        const cy = CELL / 2 + (off.oy / 100) * CELL;
        octx.drawImage(img, cx - drawW / 2, cy - drawH / 2, drawW, drawH);
        try {
          return octx.getImageData(0, 0, CELL, CELL);
        } catch {
          // CORS taint: skip this tile
          return null;
        }
      }

      // Solid-background reference for the bg-baseline SSD comparison
      function solidBgData(color) {
        octx.clearRect(0, 0, CELL, CELL);
        octx.fillStyle = color;
        octx.fillRect(0, 0, CELL, CELL);
        return octx.getImageData(0, 0, CELL, CELL).data;
      }

      const bgPixels = [solidBgData(bg1), solidBgData(bg2)];

      // Reference cache: `${tile.id}_${bgClass}` → Uint8ClampedArray | null
      const refCache = new Map();
      function getRef(tile, bgClass) {
        const key = tile.id + '_' + bgClass;
        if (refCache.has(key)) return refCache.get(key);
        const img = tileImgs.get(tile.id);
        if (!img) { refCache.set(key, null); return null; }
        const bgColor = bgClass === 0 ? bg1 : bg2;
        const mult = _app.getTileMultiplier(tile);
        const off  = _app.getTileOffset(tile);
        const imgData = composeTile(img, mult, off, bgColor);
        const pixels  = imgData ? imgData.data : null;
        refCache.set(key, pixels);
        return pixels;
      }

      // ── Categorise tiles into three passes ───────────────────────────────
      const priorityGroup    = allTiles.filter(t =>  _app.isPriority(t));
      const bottomGroup      = allTiles.filter(t => !_app.isPriority(t) && _app.isBottomRender(t));
      const normalGroup      = allTiles.filter(t => !_app.isPriority(t) && !_app.isBottomRender(t));
      if (DEBUG) {
        console.log(`[MapImport] Tile groups — priority:${priorityGroup.length}`,
          `normal:${normalGroup.length} bottomRender:${bottomGroup.length}`);
      }

      // ── Result state ──────────────────────────────────────────────────────
      const result  = Array.from({ length: importGridH }, () => Array(importGridW).fill(null));
      const matched = Array.from({ length: importGridH }, () => Array(importGridW).fill(false));
      let cellsDone = 0;
      const totalSteps = importGridH * importGridW * 3; // 3 passes

      function setProgress(n) {
        progressBar.style.width =
          Math.min(100, Math.round((n / totalSteps) * 100)) + '%';
      }

      // ── Single pass ───────────────────────────────────────────────────────
      // rowAscending=true → row 0..H-1; false → row H-1..0 (bottom-to-top)
      async function doPass(name, tileSet, rowAscending) {
        if (!tileSet.length) {
          // Advance progress counter even if no tiles in this category
          cellsDone += importGridW * importGridH;
          setProgress(cellsDone);
          return { found: 0, empty: 0, skipped: 0 };
        }
        statusEl.textContent = `Pass: ${name} (${tileSet.length} tiles)…`;
        let found = 0, empty = 0, skipped = 0;

        for (let ri = 0; ri < importGridH; ri++) {
          const r = rowAscending ? ri : (importGridH - 1 - ri);

          for (let c = 0; c < importGridW; c++) {
            if (matched[r][c]) { skipped++; cellsDone++; continue; }

            const bgClass = (r + c) % 2;
            const px = ox + c * CELL;
            const py = oy + r * CELL;

            // Skip out-of-bounds cells (grid larger than image)
            if (px < 0 || py < 0 || px + CELL > imgW || py + CELL > imgH) {
              empty++; cellsDone++; continue;
            }

            // Crop this cell from the source image
            const crop = imgCtx.getImageData(px, py, CELL, CELL).data;

            // Baseline: how different is this crop from pure background?
            const bgSSD = _alphaSSD(crop, bgPixels[bgClass]);

            let bestSSD  = Infinity;
            let bestTile = null;

            for (const tile of tileSet) {
              const ref = getRef(tile, bgClass);
              if (!ref) continue;
              const s = _alphaSSD(crop, ref);
              if (s < bestSSD) { bestSSD = s; bestTile = tile; }
            }

            // Accept match only when the winning tile beats the background
            // by a meaningful margin (reduces false positives on empty cells)
            if (bestTile !== null && bestSSD < bgSSD * (1 - CONFIDENCE_MARGIN)) {
              result[r][c]  = bestTile.id;
              matched[r][c] = true;
              found++;
            } else {
              empty++;
            }

            cellsDone++;
          }

          setProgress(cellsDone);
          // Yield to the browser every 4 rows to keep the UI responsive
          if (ri % 4 === 3) await _tick();
        }

        if (DEBUG) {
          console.log(`[MapImport] ${name}: found=${found} empty=${empty} skipped=${skipped}`);
        }
        return { found, empty, skipped };
      }

      // ── Run the three passes ──────────────────────────────────────────────
      // Pass 1 — priority tiles: always fully visible, match first
      const p1 = await doPass('Priority',    priorityGroup, true);
      // Pass 2 — normal tiles: scan bottom-to-top because tall tiles bleed upward
      const p2 = await doPass('Normal',      normalGroup,   false);
      // Pass 3 — bottom_render tiles: heal pads, jumppads etc., attempt last
      const p3 = await doPass('BottomRender', bottomGroup,  true);

      if (DEBUG) {
        const elapsed = (performance.now() - t0).toFixed(0);
        const filled  = result.flat().filter(v => v !== null).length;
        console.log(
          `[MapImport] Extraction done in ${elapsed}ms — filled ${filled}/${importGridW * importGridH}`,
          { p1, p2, p3 }
        );
      }

      setProgress(totalSteps);
      statusEl.textContent = 'Applying to grid…';
      await _tick();

      // Resize the app grid if dimensions differ from the current editor state
      const needsResize = importGridW !== _app.gridW || importGridH !== _app.gridH;
      if (needsResize) {
        _app.setGridW(importGridW);
        _app.setGridH(importGridH);
        // Let React process the size change before overwriting the grid contents
        await _tick();
      }

      _app.setGrid(result);

      const filled = result.flat().filter(v => v !== null).length;
      statusEl.style.color = C.success;
      statusEl.textContent = `Import complete — ${filled} tile${filled !== 1 ? 's' : ''} placed.`;

      extractBtn.textContent = 'Done ✓';
      isExtracting = false;
      setTimeout(() => {
        overlay.style.display = 'none';
        extractBtn.textContent = 'Extract';
        extractBtn.disabled = false;
        cancelBtn.disabled = false;
      }, 1500);
    }
  }

  // ── Origin + tileset detection (merged single step) ─────────────────────
  //
  // Genuine doExport() exports always place the grid at (ox=0, oy=CELL).
  //
  // Fast path: sample that fixed origin immediately and match the two checkerboard
  // class-means against every known tileset palette (OPHELIA_BG + DB records),
  // checking both parity orderings. Accepts on the first candidate that clears
  // FAST_THRESHOLD — lossless flat-filled PNGs should be near-zero distance.
  //
  // Fallback: if the fast path misses (cropped / resized / older export), scan
  // every candidate origin (ox ∈ [0,CELL), oy ∈ [0,CELL*5]) applying the same
  // known-palette matching at each position. The scan winner is accepted if it
  // clears SCAN_THRESHOLD.
  //
  // Returns { ox, oy, bg1, bg2, tilesetId, matched:true } on success,
  //         { ox:0, oy:CELL, bg1:null, bg2:null, tilesetId:null, matched:false } when no
  //         palette entry clears the threshold (caller shows an honest failure message),
  //         or null when the image is too small to sample.

  function _buildKnownPalette() {
    const dbTs = _app.dbTilesets || [];
    const entries = [];
    const coveredByDb = new Set();

    // DB tileset records take priority (more authoritative for custom/newer tilesets)
    for (const ts of dbTs) {
      if (!ts.bg_color_light || !ts.bg_color_dark) continue;
      entries.push({
        tilesetId: ts.id,
        bg1Hex: ts.bg_color_light, bg2Hex: ts.bg_color_dark,
        bg1Rgb: _hexToRgb(ts.bg_color_light), bg2Rgb: _hexToRgb(ts.bg_color_dark),
      });
      coveredByDb.add(ts.name);
    }

    // OPHELIA_BG hardcoded entries for names not covered by DB records
    for (const [name, c] of Object.entries(OPHELIA_BG)) {
      if (coveredByDb.has(name)) continue;
      const ts = dbTs.find(t => t.name === name);
      if (!ts) continue;
      entries.push({
        tilesetId: ts.id,
        bg1Hex: c.bg1, bg2Hex: c.bg2,
        bg1Rgb: _hexToRgb(c.bg1), bg2Rgb: _hexToRgb(c.bg2),
      });
    }

    return entries;
  }

  // Sample 4×4 patches at the top-left corner of each cell across a
  // SAMPLE_COLS×SAMPLE_ROWS grid at (ox, oy). Corner pixels sit on the grid
  // line boundary where tile art is least likely to bleed, so they reliably
  // reflect the checkerboard background even on dense/fully-covered maps.
  // Returns two checkerboard class means as plain [R,G,B] triples, or null
  // when there are not enough opaque samples.
  function _sampleClasses(pixels, imgW, imgH, ox, oy) {
    const SAMPLE_COLS = 6, SAMPLE_ROWS = 5;
    const class0 = [], class1 = [];
    for (let sr = 0; sr < SAMPLE_ROWS; sr++) {
      for (let sc = 0; sc < SAMPLE_COLS; sc++) {
        const cx = ox + sc * CELL;      // grid-line corner x (was: + CELL/2 - 2)
        const cy = oy + sr * CELL;      // grid-line corner y (was: + CELL/2 - 2)
        if (cx < 0 || cy < 0 || cx + 4 > imgW || cy + 4 > imgH) continue;
        let r = 0, g = 0, b = 0, a = 0;
        for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) {
          const i = ((cy + dy) * imgW + (cx + dx)) * 4;
          r += pixels[i]; g += pixels[i+1]; b += pixels[i+2]; a += pixels[i+3];
        }
        const avg = [r/16, g/16, b/16, a/16];
        if ((sr + sc) % 2 === 0) class0.push(avg); else class1.push(avg);
      }
    }
    const c0 = class0.filter(v => v[3] > 100);
    const c1 = class1.filter(v => v[3] > 100);
    if (c0.length < 4 || c1.length < 4) return null;
    const m0 = _meanRGBA(c0), m1 = _meanRGBA(c1);
    return { m0: [m0[0], m0[1], m0[2]], m1: [m1[0], m1[1], m1[2]] };
  }

  // Find the best-matching palette entry for class means m0/m1.
  // Checks both parity orderings (bg1↔m0 and bg1↔m1) so the checkerboard
  // phase doesn't have to match any particular convention.
  // Returns { dist, entry, swapped } where swapped=true means bg1 matched m1.
  function _bestPaletteMatch(m0, m1, palette) {
    let bestDist = Infinity, bestEntry = null, bestSwapped = false;
    for (const e of palette) {
      const dA = _distRGB(m0, e.bg1Rgb) + _distRGB(m1, e.bg2Rgb); // normal ordering
      const dB = _distRGB(m0, e.bg2Rgb) + _distRGB(m1, e.bg1Rgb); // swapped ordering
      if (dA < bestDist) { bestDist = dA; bestEntry = e; bestSwapped = false; }
      if (dB < bestDist) { bestDist = dB; bestEntry = e; bestSwapped = true; }
    }
    return { dist: bestDist, entry: bestEntry, swapped: bestSwapped };
  }

  function _makeResult(ox, oy, entry, swapped) {
    return {
      ox, oy,
      bg1: swapped ? entry.bg2Hex : entry.bg1Hex,
      bg2: swapped ? entry.bg1Hex : entry.bg2Hex,
      tilesetId: entry.tilesetId,
      matched: true,
    };
  }

  function _detectOrigin(pixels, imgW, imgH) {
    const SAMPLE_COLS = 6, SAMPLE_ROWS = 5;
    if (imgW < SAMPLE_COLS * CELL || imgH < (SAMPLE_ROWS + 1) * CELL) return null;

    const palette = _buildKnownPalette();
    if (!palette.length) return { ox: 0, oy: CELL, bg1: null, bg2: null, tilesetId: null, matched: false };

    // ── Fast path: genuine export origin (ox=0, oy=CELL) ─────────────────
    const fast = _sampleClasses(pixels, imgW, imgH, 0, CELL);
    if (fast) {
      const { dist, entry, swapped } = _bestPaletteMatch(fast.m0, fast.m1, palette);
      if (dist <= FAST_THRESHOLD && entry) {
        if (DEBUG) console.log(`[MapImport] Fast-path match: dist=${dist.toFixed(1)}`);
        return _makeResult(0, CELL, entry, swapped);
      }
    }

    // ── Fallback: scan candidate origins, palette-match at each ──────────
    const maxOy = Math.min(imgH - SAMPLE_ROWS * CELL, CELL * 5);
    let bestDist = Infinity, bestOx = 0, bestOy = CELL, bestEntry = null, bestSwapped = false;

    for (let testOy = 0; testOy <= maxOy; testOy++) {
      for (let testOx = 0; testOx < CELL; testOx++) {
        if (testOx + SAMPLE_COLS * CELL > imgW) break;
        const s = _sampleClasses(pixels, imgW, imgH, testOx, testOy);
        if (!s) continue;
        const { dist, entry, swapped } = _bestPaletteMatch(s.m0, s.m1, palette);
        if (dist < bestDist) { bestDist = dist; bestOx = testOx; bestOy = testOy; bestEntry = entry; bestSwapped = swapped; }
      }
    }

    if (bestDist <= SCAN_THRESHOLD && bestEntry) {
      if (DEBUG) console.log(`[MapImport] Scan-path match at (${bestOx},${bestOy}): dist=${bestDist.toFixed(1)}`);
      return _makeResult(bestOx, bestOy, bestEntry, bestSwapped);
    }

    // ── No confident palette match ────────────────────────────────────────
    if (DEBUG) console.log(`[MapImport] No palette match; best dist=${bestDist.toFixed(1)}`);
    return { ox: 0, oy: CELL, bg1: null, bg2: null, tilesetId: null, matched: false };
  }

  // Returns { bg1, bg2 } for a tileset ID, or null if not found.
  function _getBgForTileset(tsId) {
    if (!tsId) return null;
    const ts = (_app.dbTilesets || []).find(t => t.id === tsId);
    if (!ts) return null;
    if (ts.bg_color_light && ts.bg_color_dark) return { bg1: ts.bg_color_light, bg2: ts.bg_color_dark };
    const known = OPHELIA_BG[ts.name];
    return known ?? null;
  }

  // Updates the bg swatches and detectedOrigin.bg1/bg2 from a tileset's known palette.
  // Called when the image didn't auto-match so the user can pick the tileset manually.
  function _applyBgFromTileset(tsId) {
    const bg = _getBgForTileset(tsId);
    if (!bg) return;
    if (detectedOrigin) { detectedOrigin = { ...detectedOrigin, bg1: bg.bg1, bg2: bg.bg2 }; }
    bgSwatch1.style.background = bg.bg1;
    bgSwatch2.style.background = bg.bg2;
    bgHexEl.textContent = `${bg.bg1}  /  ${bg.bg2}  (from tileset)`;
  }

  // ── Pixel math helpers ─────────────────────────────────────────────────

  // Alpha-weighted SSD as specified: weight each pixel by the reference tile's alpha.
  // For background references (fully opaque) this degenerates to equal-weight SSD.
  function _alphaSSD(cropPixels, refPixels) {
    let s = 0;
    const n = CELL * CELL;
    for (let i = 0; i < n; i++) {
      const p = i * 4;
      const w = refPixels[p + 3] / 255;
      if (w < 0.01) continue;
      const dr = cropPixels[p]     - refPixels[p];
      const dg = cropPixels[p + 1] - refPixels[p + 1];
      const db = cropPixels[p + 2] - refPixels[p + 2];
      s += w * (dr * dr + dg * dg + db * db);
    }
    return s;
  }

  function _meanRGBA(arr) {
    const s = [0, 0, 0, 0];
    for (const v of arr) { s[0] += v[0]; s[1] += v[1]; s[2] += v[2]; s[3] += v[3]; }
    const n = arr.length;
    return [s[0] / n, s[1] / n, s[2] / n, s[3] / n];
  }

  function _distRGB(a, b) {
    const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
    return Math.sqrt(dr * dr + dg * dg + db * db);
  }

  function _rgbaToHex(rgba) {
    return '#' + [0, 1, 2]
      .map(i => Math.max(0, Math.min(255, Math.round(rgba[i])))
        .toString(16).padStart(2, '0'))
      .join('');
  }

  function _hexToRgb(h) {
    const s = h.replace('#', '');
    return [
      parseInt(s.slice(0, 2), 16) || 0,
      parseInt(s.slice(2, 4), 16) || 0,
      parseInt(s.slice(4, 6), 16) || 0,
    ];
  }

  function _hexDist(h1, h2) {
    try { return _distRGB(_hexToRgb(h1), _hexToRgb(h2)); } catch { return 999; }
  }

  // ── Export ─────────────────────────────────────────────────────────────
  window.MapImport = { init, open };
})();
