# AUDIT — Opheliapp mapmaker (post tilesets.type drop)

Read-only audit. No code, DB, GitHub or live service was changed or called (the one write is this file). Everything below comes from reading index.html (8434 lines, single-file React via in-browser Babel), worker.js (688), map_image_import.js (837), auth/callback.html (178), wrangler.toml, manifest.json, Resources/manifest.json. Nothing was executed; where a claim is an inference rather than a direct reading it is marked (inference) or (unverified).

Line numbers refer to index.html as audited (8434 lines); the file has since changed.

## Repo facts that shape everything

- There is no build step, package.json, test suite, CI config, or SQL/migration/RLS file in this repo. Schema and RLS are invisible from here.
- Frontend = index.html (+ map_image_import.js). All data access is fetch() to the Cloudflare worker (WORKER_URL, index.html:147); there is no supabase-js client.
- Worker writes tile images to GitHub repo bicipikay/ophelia (worker.js:275,340; raw URLs built at index.html:4465,5768,5930), not to this repo (homeland-bloc/theme-tester). CORS is pinned to https://bicipikay.github.io (worker.js:18), and the Discord redirect is https://bicipikay.github.io/ophelia/auth/callback.html (worker.js:19, index.html:2259, auth/callback.html:66).
- GitHub docs could not be fetched: docs.github.com, developer.github.com, api.github.com and raw.githubusercontent.com are all blocked by the sandbox egress policy (403 on CONNECT). Section 6 therefore uses only what web-search snippets of the docs returned; everything else about the GitHub API is labelled unverified.

## 1. BROKEN BY THE TYPE DROP

Every read/write of tilesets.type in the repo. (There are no SQL files, no mocks and no TypeScript types/interfaces in the repo — only these.)

| # | Location | What it does | Effect now | Should become |
|---|---|---|---|---|
| 1 | index.html:2052 `tsBase.searchParams.set('type','in.(atlas,atlas2,base,custom)')` | Filters the tilesets list query | PostgREST rejects an unknown column (HTTP 4xx) → tsResp.ok false → [] → setDbTilesets([]) (2061-2072). Root cause of "app is erroring": no tilesets load at all. | Delete the line. |
| 2 | index.html:2081 `ts.is_published && ts.type === 'custom'` (+ sort by created_at) | Picks default active tileset when none saved | Always empty → falls to tilesets[0] (2082) | Pick by seed_id/name/most recent, no type. |
| 3 | index.html:5774 `body: JSON.stringify({ name, folder_path, type: 'custom', owner_id, is_published:false })` (doCreateTs) | INSERT into tilesets | Create Tileset fails (unknown column). The GitHub upload at 5756 has already happened → orphaned file in GitHub (upload happens before the DB insert). | Drop type. Consider reordering (DB first, or rollback). |
| 4 | index.html:1301, 1773, 1805 `tilesetType: tsDef.type` | Copied onto every tile object / per-tileset entry | Becomes undefined (harmless by itself) | Remove field. |
| 5 | index.html:4853 and 4916: `t.tilesetType !== 'atlas' && !== 'atlas2'` | Gate for Replace Image and Delete buttons in the tile modal | undefined !== 'atlas' is true → buttons now visible for everything (correct outcome by accident) | Remove the atlas clause. |
| 6 | index.html:5901-5902 `if (ts?.type === 'atlas' \|\| …) 'Cannot add tiles to atlas tilesets.'` (doAddTile) | Guard | Dead now | Remove. |
| 7 | index.html:7126 `tilesetType !== 'atlas' && tilesetType !== 'atlas2'` | Shows "+ Add Tile" card | Works by accident | Remove clause. |
| 8 | index.html:680 `isAdmin && tsData.type !== 'atlas' && tsData.type !== 'atlas2'` | Shows Transfer Ownership in TilesetGearModal | Works by accident | Remove clause. |
| 9 | index.html:5411-5413 (ConvertModal) `ts.type === 'base' \|\| 'custom'` / `'atlas'\|\|'atlas2'` | Builds From/To lists | Both lists empty → Convert dropdowns empty, allAvailableNames=[], Convert unusable | Use dbTilesets directly. |
| 10 | index.html:6582-6583 (tileset dropdown) same filter pair | Builds "Opheliapp" and "Atlas" sections of the tileset selector | Dropdown lists nothing (only "Create Tileset") → cannot switch tilesets | Single flat list. |
| 11 | index.html:6601 `ownerUsername && (ts.type==='base'\|\|'custom')` and 6604 `ts.type==='atlas2'` "Community Tileset" | "by <owner>" / label in dropdown | Neither renders | Show owner unconditionally. |
| 12 | index.html:8267-8268, 8280 (background-preset dropdown) same filter pair + `ts.type==='atlas2'` colour | Lists tileset BG presets | Empty | Flat list. |
| 13 | index.html:6190 `<span>{ts.type}</span>` (Admin Dashboard) | Shows type column | Renders empty | Replace with creator (see §3). |
| 14 | map_image_import.js:194-195 same filter pair (Import modal tileset select) | Populates select | Empty (feature is slated for removal anyway) | n/a |

Related fallout that is not a .type read but is caused by the same migration:

- `select=*,profiles(username)` (index.html:2054) relies on an FK tilesets.owner_id → profiles.id for the embed. Snowtel Gifts has owner_id null → profiles: null (not an error). Used at 684 (`tsData.profiles?.username ?? tsData.owner_id`) and 6588 (`ts.profiles?.username`).
- tilesets.sort_index is read (5411, 6582, 8267) but only inside the type-gated lists; it is never written by the client. (question: does that column still exist?)
- All atlas/atlas2 deleted: any user's saved map (localStorage oph_grid) containing d:<uuid> of deleted tiles resolves to null and shows the "N tile(s) … were cleared" banner (2318-2321, 6212-6220). oph_active_ts pointing at a deleted tileset is ignored (2083).

## 2. ATLAS SPECIAL-CASING

Type-based (all listed in §1): 680, 4853, 4916, 5411-5413, 5468-5470, 5901, 6582-6583, 6601-6604, 6626-6627, 7126, 8267-8268, 8280, 8326-8327.

Constants / ID ranges

- index.html:139-140 ATLAS_ID_START=300 ("300–499 and 700–9999"), ATLAS_ID_MAX=9999 (unused). ATLAS_ID_START is also used as the upper bound of the "global" ID range: 5091, 5211 (`id >= GLOBAL_ID_START && id < ATLAS_ID_START`). Removing the constant requires re-pointing these two filters.
- index.html:182 comment, 1130 panelCollapsed default has an atlas:false key (unused section), 6365 comment "wider panel for large Atlas folders" (cols = tiles.length > 16 ? 5 : 4).

Codename scheme

- index.html:248,257,267 getTileCodename / resolveCodename: the `"a:"+codename` prefix and t.isAtlas. Nothing sets isAtlas any more (only 4363, 5612, 257, 267 read it) → dead branches. 4363 `t.isAtlas ? (t.baseCodename ?? …)` also dead.
- index.html:2279,2304 comments about "atlas tiles persisted in localStorage".

Size/offset hard-coding for atlas art

- index.html:1457-1458 and 1486-1487: `src.includes("/Rope/Post_R"|"/Rope/Post_TR")` → multiplier 1.5 / offset {25,0} ("Atlas Post_R / Post_TR"). These apply to any tile (incl. DB tiles whose size_multiplier is null) with such a path.

Hardcoded tileset names / IDs

- OPHELIA_BG (index.html:150-157): Airport, Mausoleum, Sewer, Halloween, Cafe, Pharmacy → used at 1938,1960 (switch), 2421,2432 (undo restore), 8271 (BG dropdown). Duplicated in map_image_import.js:29-36,653-661,769. The 1938/1960/8271 fallbacks only matter when a DB row lacks bg_color_light/dark.
- Resources/manifest.json tilesets[] (Mausoleum, Sewer, Airport, Halloween, Cafe, Pharmacy) and the on-disk folders Resources/{Airport,Cafe,Halloween,Mausoleum,Pharmacy,Sewer}/… are not read by the app — only data.global is used (index.html:2029-2032). Legacy/dead assets.
- WIP_TILESETS (159) is an empty, unused Set.
- No occurrence of "Snowtel", "Gifts" or any tileset UUID in the code (grep, case-insensitive). Nothing singles out Snowtel.
- Deleting the type concept does not touch deriveCodename (216-242), which maps file stems ("1","2","B","L","Blue", "WaterCurve" …) to display names regardless of tileset; because DB tiles use arbitrary filenames this can mislabel a DB tile (e.g. a DB file named B.png is labelled "BottomJumppad" in history/replace labels via tileDisplayName 4186-4192 and commitMultipleCells 2753-2757).

The hardcoded "global" tileset

- Source: Resources/manifest.json → global (order: water, spawns, objectives, special, teleporters, jumppads; folderPaths like Global/Special Tiles/). Fetched with a relative URL fetch("Resources/manifest.json") (index.html:2029) → served from the app's own host, not from bicipikay/ophelia raw, and with no ?v= cache-buster.
- Built in flatDefaultTiles memo (1810-1837): IDs are assigned sequentially from GLOBAL_ID_START=200 in manifest order (makeTile, 1812), after skipping EXCLUDED_GLOBAL_FILES = {jumppads:["TL.png","L.png","BL.png"]} (1825). Resulting IDs: water 200-203, spawns 204-211, objectives 212-219, special 220-225, teleporters 226-229, jumppads 230-234. Reordering/adding a file in the manifest shifts every later global ID, silently re-keying all per-tile settings maps, starred ids and recent ids (all numeric — see §4). Saved maps are safe because they store the Resources/… path (getTileCodename returns tile.src, 259).
- Tile object fields: {id, src:"Resources/<folderPath><file>", isDefault:true, folderKey:"global_<key>", folderLabel, codename:"Global_<stem>"} (1812,1830-1832) — no isDb, no dbId, tilesetName undefined.
- Display: right after the per-tileset sections, a SectionHeader id="global" and globalEntries.map(renderEntry) (7139-7143); folder tiles open the floating folder panel (6359-6434). So "below the selected tileset" = it is simply the next block in the same flex-wrap list; it is not tied to the active tileset and is always shown.
- Behaviour that special-cases it by path substring (so it breaks if files move): TILE_SETTINGS (163-170), getDefaultMultiplier (1437-1460: Spawns/, Jumppads/, Teleporters/, HealPad, Hot_Zone, Smoke, Brawl_Ball, goalRed|goalBlue, Gem_Grab|Heist, Bounty), getDefaultOffset (1468-1493), spawn/goal team swap 1507-1524 (Spawns/1.png etc.), objective fallback in switchTileset (1898-1911: matches Gem_Grab/Brawl_Ball/Heist in src), TilesetCompatModal "Global Tiles" (5612).
- Global water files are named with 8-bit patterns (00001011.png, 01101011.png, 01111111.png, 11111111.png) and mapped in deriveCodename (221). Observation: same 0/1-string shape as the planned sensor_code.

## 3. REMOVAL SURFACE

### 3a. "Import Map from Image"

- index.html:120 `<script src="map_image_import.js">`.
- index.html:1418-1435 effect calling window.MapImport.init({ flatDefaultTiles, dbTilesets, ensureTilesetLoaded, getTileMultiplier, getTileOffset, isPriority, isBottomRender, setGrid, setGridW, setGridH, gridW, gridH }).
- index.html:8261 the button Import Map From Image → window.MapImport?.open() (bottom bar "Row 3", next to History).
- index.html:1167 ref comment "for MapImport" — flatDefaultTilesRef itself is still used by the R/[ ] hotkeys (4091,4124) and Rotate (7486); keep (or re-evaluate when identity is reworked).
- map_image_import.js (entire file): DOM-built modal (imperative, not React), origin/tileset detection (_detectOrigin, _buildKnownPalette, OPHELIA_BG copy), SSD tile matching, 3 passes. Dead helpers inside it even today: _rgbaToHex, _hexDist (815-833).
- It assumes the export layout (ox=0, oy=CELL) of doExport (4243-4307, comment 619). No other module depends on it.
- Dependencies used only by it: none external (no package.json). App-side only ensureTilesetLoaded is shared (also used by ConvertModal 5427) → keep. It bypasses applyGridSize clamps (it calls setGridW/H directly, 594-595, allows up to 200 vs app clamp 99 at 4149).
- Related commit history: 3 recent PRs (#101–#103) were all Import fixes.

### 3b. Rotate tool (essentials)

- State: rotateMode + ref + rotatePendingCellRef (1024-1026, 1221).
- Card (Essentials "1e"): 6896-6926. Info text toolDefs.rotate 5320. Collapsed-strip: toolIconMap/actionMap/activeMap/colorMap entries 7931,7950,7968,7978; selKey/SelectedCard 7210,7235-7239.
- Behaviour: mouse path = canvas onMouseDown shared with Hand (7434-7516; cell flip/rotate cycle at 7475-7502); touch path = onTouchEnd 3841-3890; onCell 2992-2996, 3112, touch start 3681. Cursor 7432. Badges (🐬/🦭) 7646-7666.
- Scattered setRotateMode(false) calls in tool/card/hotkey handlers (e.g. 4086-4119, 6405,6684,6768,6791,6811,6855,6876,6932,6997,7038,7318,7935-7952) — roughly 30 sites.
- Caveat: Rotate is the only UI for changing rotation/flip of an already-placed cell (other than pick-up-and-redrop, which preserves rot/flip: 3118-3119). Removing it removes post-placement rotation entirely.

### 3c. Explore tool (essentials)

- State exploreMode, exploreModeRef, explorePicker (1008-1010, 1225); onCell early-return 2991; card (Essentials "1b-x") 6827-6850; overlay chevrons 7685-7712; picker popup 7872-7917; info text 5323; selKey 7210,7240; clear calls in many handlers (setExploreMode(false)/setExplorePicker(null) ≈ 25 sites); getTileFolderKey (3231) is used only by Explore (7694,7696,7882).
- starredTiles may contain the strings "rotate"/"explore" in users' oph_starred (1062): "explore" is not in toolIconMap so it is filtered out; "rotate" is in toolIconMap (7931) so a stale star would render a dead button unless the map entry is removed.

### 3d. "Mirror rotation" parameter

- Setting mirrorSettings.mirrorRotation (default true): 996, 1169; UI checkbox in Tools Settings 8123-8131.
- Consumers: applyDuplicate 2500; paintCells 2685; commitMultipleCells 2785; highlight-drag drop 3433, 3959 (touch); drag-drop 3533, 4021; helper applyRotMirror 2633-2645 (also contains the fV/fH/fD rotation algebra).
- Note: this is a rotation of mirrored copies of rotatable tiles (water), not part of the Rotate tool itself. Removing the setting forces a decision on what mirrored copies of rotatable tiles do (see questions).

### 3e. Admin dashboard (tileset type + creator)

- Admin modal 6124-6209. Tileset rows 6187-6198: name, {ts.type} at 6190, WIP, DRAFT, ⚙. Title shows Tilesets (n) at 6185. No owner shown today.
- Data needed for "creator" is already in dbTilesets: select=*,profiles(username) (2054) → ts.profiles?.username (null for Snowtel → show "-"). Admin sees all tilesets (2045-2046); non-admins see published + own (2048).
- Gear modal also uses owner (684) and an admin profiles?select=id,username list (456).

## 4. TILE IDENTITY (most important)

### 4.1 What a "tile" is at runtime

The canvas grid is a 2-D array of small integers (or null): grid (964-980), written by setGrid/setGridRaw, read everywhere via getTile(id) (3228: `id === SPACE_TILE_ID ? SPACE_TILE : tiles.find(t => t.id === id)`).

Integer ID ranges (135-143): tileset tiles 1–199; global 200–299 (sequential, manifest order); atlas 300–499/700–9999 (obsolete); user uploads 500–699 (nextId 1152, persisted in oph_user_tiles); 997 warn; 998 space; -1 erase sentinel in Replace.

DB tile → integer: uuidToStableId(uuid, tilesetId) (183-211): FNV-style hash of the UUID mod 199 into [1,199], linear probing within a per-tileset "pool" (occupied: Map<id,uuid> per tileset). Therefore:

- IDs are unique within one tileset in one browser session, but two tilesets draw from the same 1–199 range independently → cross-tileset collisions are normal (the code even says so: comment 176-182, "harmless because allTilesByIdRef is rebuilt… active tileset written last"). Expected collisions between two tilesets with a and b tiles ≈ a·b/199 (inference: arithmetic, not measured) — e.g. two 40-tile tilesets ≈ 8 shared IDs.
- Within a tileset the id depends on processing order (pools are filled in whatever order tiles first reach uuidToStableId, normally sort_index order). Adding/deleting/re-sorting a tile whose hash collides can change another tile's id between sessions. Anything persisted by numeric id (see list in 4.5) then re-attaches to the wrong tile.
- Persisted identity used for saving the map is different: getTileCodename (252-260) → "d:<uuid>" for DB tiles, src path for global, "u:<id>" for local uploads, "space", "warn"; stored as a palette {v:2, palette:[…], grid:[[index|null]]} (encodeGridForStorage 270-282, saved in effect 1330-1334, restored 2287-2322). So storage already has a per-map palette; memory does not.

### 4.2 Which key is used where

| Place | Key |
|---|---|
| Canvas cell | numeric id (grid[r][c]) |
| Selection sel (987), eraser, cards 6658, folder panel 6383, folder-active 6708 | numeric id; active = sel === t.id |
| Eyedropper 3013-3015 | copies the numeric id from the cell |
| Starred (1062) / recent (1068, 1407-1413) | numeric id (persisted oph_starred, oph_recent) |
| Tile modal infoTile (1058, setInfoTile(t.id) 6421,6695) | numeric id; getTile(infoTile) first match |
| Replace modal step 1 (5042-5086) & step 2 (5088-5178), replaceA/B (1085-1086) | numeric id |
| Undo/redo snapshot {grid,w,h,tileset,bg1,bg2,highlight,rots,flips,label} (2405) | numeric ids inside grid; tileset = tileset name |
| Mirroring (getMirrorMeta 2616, swapSpawnId 1514-1524) | positions; spawn swap finds counterpart by src substring in tiles (global tiles only) |
| Tileset switch (1846-2000) | numeric id ↔ codename (per-tileset unique string) |
| Per-cell extras | position key "r,c": gridRotations (1124), gridFlips (1125), gridOffsets (1126) |
| Tileset identity | name: activeTileset (1704, saved oph_active_ts 2323), snap.tileset, selectedBgPreset, folderKey = "<tileset name>/<folder_key>" (1789), panelCollapsed["tileset_<name>"] (7096) |
| Folder identity | folderKey string (name-based) |

### 4.3 Why clicking one tile can "select three"

Root cause: a numeric ID is not unique across the set of tiles that are simultaneously in memory, while selection/highlight is `selected === t.id`.

- flatDefaultTiles (1748-1841) pushes tiles of every tileset whose rows are cached, not just the active one: `flatTiles.push(tileObj)` at 1796 is outside the `if (isActive)` block (1799). The cache dbTilesByTsId grows whenever a tileset is visited, loaded by Convert (5427), by TilesetCompatModal (5577-5599), by switchTileset (1853-1872), or discovered from a saved map's d: palette (2105-2142).
- tiles = [...defaultTiles, ...userTiles] (957; defaultTiles ← flatDefaultTiles 2005) therefore contains N tile objects that may share one integer.
- Replace — "which tile?" (step 1): `tilesOnMap = tiles.filter(t => idsOnMap.has(t.id))` (5046) returns every tile object with that id → one map id renders as several cards (keys are t.dbId ?? t.id, so React no longer complains — 561aaa1 "duplicate keys" fix only masked this). RCard highlights `selected === t.id` (5018-5019) and onSelect sets a single number (5016) → clicking any one of them highlights all of them ("three"). doReplace/doSwap then act on the number (4209, 4233), i.e. on all cells of that id, whatever tileset the user thought they picked.
- Replace with — step 2: lists tilesetTiles_ = tiles.filter(id in [1,199)) (5089), groups by tilesetName, shows only the active one (5147); other tilesets' tiles can still be the target of a click on a shared id. userTiles_, globalTiles_ ranges (5090-5091). Picking B writes only the integer.
- Same pattern: OTGSettingsModal (5209-5227, key={t.id} duplicates → React key collisions), starred/recent strips (7308-7418, getTile(sid) first-match), bfsFill by folder (2947-2972).
- Which tile object "wins" differs by code path: render/getTile/tiles.find → first in tiles (DB tilesets in dbTilesets order = order=name, so alphabetically first cached tileset); allTilesByIdRef (1252-1259) → active tileset wins; encodeGridForStorage (271) builds `new Map(tiles.map(t=>[t.id,t]))` → last duplicate wins. The code itself documents the mismatch at 7478-7485 ("rotate badge uses tiles.find() (first match)… handler looks up the active-tileset tile"). Consequence: the object shown, the object whose flags are applied, and the object serialised on save can be three different tiles; a save→reload then re-resolves d:<uuid> to the serialised tile's own id, which can silently change what a cell shows (inference from code paths, not reproduced).

### 4.4 Why tiles show stray flags (bottom_render, auto_shadow, priority …)

- Per-tile flag state is stored in objects keyed by numeric id: priorityTiles, bottomTiles, autoShadowTiles (1101-1105) plus tileMultipliers, tileOffsets, rotatableMap, allowFlipMap, mirrorOffsetTiles, otgWallOverrides, tileNames, tileCountMap.
- On every flatDefaultTiles change the effect 2004-2025 rebuilds these maps with rebuildDefaultFlags: it keeps entries ≥500 and sets `next[t.id] = true` for every tile in flatDefaultTiles (all cached tilesets) whose own DB flag is true. A true flag on tile A therefore turns the flag on for every tile that shares A's integer, including tiles in other tilesets that are false in DB.
- Consumers read the map by the id of the (first-match) tile: render passes bottomTiles[t.id] / priorityTiles[t.id] / autoShadowTiles[t.id] (7571,7583,7597-7598,7610,7624,7636), card badges (TileBadge 1672-1701: compares to the tile's own DB default and shows ⚓/🚨/👻 when they differ → stray badge), InfoModal checkboxes show orange "differs from default" (4680-4687).
- Overrides that are not rebuilt (tileMultipliers, tileOffsets, rotatableMap, allowFlipMap, mirrorOffsetTiles, otgWallOverrides) persist in localStorage by integer and are only pruned in switchTileset (1975-1992: keeps keys ≥200), not on load. If a tile's integer changes between sessions (see 4.1 order dependence) its overrides land on another tile.
- tileCounts / CountBadge (1653-1669) count by integer → a count badge includes cells of colliding tiles.

### 4.5 Everything keyed by numeric tile id (rework surface)

React state: sel, starredTiles, recentTileIds, infoTile, replaceA/B, dragTile, failedTiles, deleteCustomSel, tileMultipliers, tileOffsets, priorityTiles, bottomTiles, autoShadowTiles, rotatableMap, allowFlipMap, mirrorOffsetTiles, otgWallOverrides, tileNames, tileCountMap, cardRotations, cardFlipModes, cardFlipSteps (987-1130, 1058-1125). Refs: allTilesByIdRef, flatDefaultTilesRef, cardRotationsRef, dragTileRef, etc. Persistence: oph_multipliers, oph_priority, oph_offsets, oph_bottom, oph_auto_shadow, oph_rotatable, oph_allow_flip, oph_mirror_offset, oph_otg_walls, oph_tile_names, oph_tile_count_map, oph_starred, oph_recent (1319-1351,1403-1405).

### 4.6 Tileset switching today (switchTileset, 1846-2000)

1. Fetch the new tileset's tiles if not cached (1853-1872).
2. futureCodenameToId[codename] = uuidToStableId(row.id, newTs.id) (1876-1882).
3. oldIdToCodename from flatDefaultTiles where t.dbTilesetId === oldTs.id (1885-1889); oldIds = those integers.
4. If any codename is missing in the new tileset → opens TilesetCompatModal with fallbacks (global objective tile via src substring 1898-1911, else WARN_TILE_ID) (1914-1942; modal 5567-5732, apply 5614-5644).
5. Otherwise remap each cell: `if (!oldIds.has(id)) keep; if (id >= GLOBAL_ID_START) keep; cn = oldIdToCodename[id]; new = futureCodenameToId[cn] ?? WARN` (1945-1954).
6. Push a history snapshot, setActiveTileset, applyBgPreset (BG from DB → OPHELIA_BG → cache → default) (1956-1973).
7. Clear all per-tile overrides whose key < 200 (1975-1992) and drop stale starred/recent ids of the old tileset (1994-1999).

Where mixing can occur

- Remap is keyed on integers belonging to the old tileset. A cell that holds an integer coincidentally equal to an old-tileset integer but was actually a tile from a third tileset (possible after a multi-tileset restore, 2105-2142) is remapped as if it were the old tileset's tile; conversely third-tileset cells whose integer doesn't match are left in place and then render as whichever cached tileset sorts first (getTile), i.e. possibly as a new-tileset tile.
- After a switch the old tileset stays in dbTilesByTsId, so its tiles remain in tiles and can shadow the new tileset's tiles that share an integer (first-match in getTile, though allTilesByIdRef prefers active — the inconsistency in 4.3).
- Undo: restoreSnap calls setActiveTileset(snap.tileset) (2416) but nothing reloads/validates which tileset's tiles the integers meant.
- Compat modal remap table is keyed by codename and picks a replacement integer from newTilesForDropdown/globals (5611-5612,5698-5710).
- ConvertModal (5408-5529) remaps old→new by codename for all cells whose integer is in fromAll, but fromAll is a set of integers from flatDefaultTiles (same ambiguity).

Root cause to name: runtime tile identity is a non-unique 1–199 hash, per tileset, combined with a single flat tiles/flag namespace; tilesets, flags and settings are addressed by integer or by tileset name, never by an unambiguous (tileset, tile) reference.

## 5. STATE SHAPE

- Canvas: grid: (number|null)[gridH][gridW] (964), size in gridW/gridH (959-960, persisted oph_gridW/H). Rotation/flip/offset are sparse maps outside the grid, keyed "r,c": gridRotations 0–3 (1124), gridFlips 0–3 (1125), gridOffsets {ox,oy} (1126, written only by mirror-offset tiles, computeMirrorOffsetOverride 3238-3252). Persisted separately: oph_tile_rots, oph_grid_flips, oph_grid_off, and oph_grid (palette form). Refs gridRef/gridRotationsRef/gridFlipsRef shadow them for stale-closure handlers.
- Writes to rots/flips/offsets are done piecemeal in ≥10 places (paint 2682-2727, commit 2782-2835, pickup 3120-3139,3697-3716, drop 3530-3552,4018-4040, highlight move 3421-3461, duplicate 2505-2509, resize 4158-4181, rotate tool). Any switch of the grid representation must touch all of them.
- Undo snapshots (setGrid 2396-2411, pushHistorySnapshot 2536-2546, pushBgHistory 2361, switchTileset 1964, compat 5633, highlight/drag 2886,3481): {grid, w, h, tileset(name), bg1, bg2, highlight[], rots, flips, label, (primaryHighlight), (customCenter only in pushHistorySnapshot)}. Max 60 (133). Not captured: gridOffsets, per-tile settings, user tiles, customCenter in most snapshots. setGrid closes over histIdx state (2403,2411) while other writers use histIdxRef (2881, 3476) — mixed sources of truth. Some actions push only a pre-state snapshot then write with skipHistory=true (e.g. applyDuplicate 2511-2513, drag/drop 3420), so redo may not be able to restore their result (inference from reading; not run).
- Local uploads: userTiles = [{id:500–699, src: PNG data-URL ≤256 px, blobSrc}] (801-804, 2548-2583), persisted as base64 in localStorage oph_user_tiles (1319) (quota risk). Map reference: integer id (in-memory) / "u:<id>" (saved). nextId = max+1 at load (1152) → deleting the highest-numbered upload then reloading reuses its id, so a stale u:<id> in an old save would resolve to a new image (inference). Local uploads can't be shared (seed feature): data lives only in one browser.
- Global tiles: referenced in memory by sequential integer (200+), saved by src path (259).
- Maps: a single current map; not a list. Name oph_map_name. No server persistence (tables are only profiles/tilesets/tiles).
- Could a per-map palette replace the current approach? Yes — structurally it is already what storage does (GRID_FORMAT_VERSION 2, 251). The in-memory model would become: palette: Tag[] (index ↔ {kind:'db'|'global'|'user'|'special', tilesetKey/seed_id, tileRef}) and grid cells = small indexes into it; every id-keyed map in 4.5 would be re-keyed by palette index or by (tileset, tile) tag. Constraints seen in code: the GRID_FORMAT_VERSION migration path must keep reading d:/path/u: palettes; Replace/Convert/Switch/Mirror(swapSpawnId)/Explore/Eyedropper/Undo all need rewriting; shareable seeds need a tileset-stable, tile-stable small int — tilesets will have seed_id, tiles have no equivalent column (see questions).
- Files that would be touched: index.html (essentially every section: constants 125-143,183-211,252-282; tile build 1748-1841,1262-1316; state 987-1130; switch/convert/compat 1846-2000,5408-5732; undo 2396-2546; paint/drag/touch 2663-4067; replace/OTG/info modals 4355-5236; panels 6359-7420; render 7544-7712), plus optionally Resources/manifest.json (global ordering → stable global tags). worker.js, map_image_import.js unaffected (the latter is being deleted). New DB columns (tiles.symbol, sensor_*, tilesets.seed_id) require widening tile-object construction (two copies: 1291-1315 and 1763-1787).

## 6. UPLOADS AND GITHUB

### 6.1 Path

- User picks file in AddTileModal (345-402; doAddTile 5898-5967), Create Tileset (doCreateTs 5737-5812, first tile) or Replace Image in the tile modal (4444-4481).
- Client reads file → base64 (FileReader 5913-5918, 5747-5752, 4453-4458) without resizing or format validation beyond file.type.startsWith('image/') and ≤10 MB (Replace only, 4860-4868; Add/Create have no client size check).
- POST ${WORKER_URL}/github/upload with Authorization: Bearer <Firebase ID token>, JSON {filePath, contentBase64, commitMessage} (5920-5924).
- Worker handleGithubUpload (worker.js:232-303): verifies Firebase JWT signature/iss/aud/exp (560-595), looks up role through Supabase with the user's token (212-230, 243); requires role admin or creator (244-246); parses JSON; requires filePath and contentBase64; rejects decoded size > 10 MB (255-257); decodeURIComponent(filePath) (260); extension whitelist .png .jpg .jpeg .gif .webp (262-264); must start with Resources/ (265); collapses ./.. and requires the normalised path to equal the input (266-273).
- GET https://api.github.com/repos/bicipikay/ophelia/contents/<path> with GITHUB_BOT_TOKEN; 200 → take sha; 404 → create; other → error (275-290). Then PUT same URL with {message, content, sha?}; no branch param (default branch) (292-299). Response of GitHub is passed through unchanged (301-302).
- On success client builds image_url = https://raw.githubusercontent.com/bicipikay/ophelia/main/<filePath>?v=<Date.now()> (4465, 5768, 5930) — hard-codes main; the upload itself targets the repo default branch (mismatch if they differ (unverified)).
- DB write: Replace → PATCH tiles?id=eq.<dbId> {image_url} (4466-4470); Add → POST tiles with the full row (5932-5946); Create → POST tilesets then POST tiles (5771-5801).

### 6.2 File name and duplicates

- File name = the user's local filename, unsanitised: Resources/${folder_path}/${addTileFile.name} (5912, 5755); Replace reuses the existing name parsed from image_url (4450-4452). folder_path is the tileset's GitHub folder (e.g. Snowtel_Gifts).
- Duplicates are silently overwritten: worker GETs the existing sha and PUTs with it (282-293). No error, no suffix, no check that another DB tile already points at that path. The DB uniqueness that exists is on codename (error handler maps 23505 → "codename already exists in this tileset", 5953), not filename. Two tiles can end up sharing one file; deleting one deletes the file for both (4947-4961).
- Date.now() cache-buster is client-clock based, changes on every upload, and is stored inside image_url (so every re-upload rewrites the row). UI warns "may take ~5 minutes to appear due to CDN caching" (369, 5863).
- Name hazards: names with #, ?, %, spaces break the raw URL (not URL-encoded when interpolated, 5930); a name containing % or a valid %XX sequence is altered/rejected by the worker's decodeURIComponent (260) while the client keeps the original in image_url → URL ≠ stored path. Case/unicode not normalised. Non-image content is not inspected (only extension).
- Auth/ownership: role only (admin or creator). The worker never checks that the caller owns the tileset/folder → any creator can overwrite any file under Resources/ (other creators' tilesets, Resources/Global/…, the legacy theme folders) (265). Ownership is enforced, if at all, by Supabase RLS on the later DB write, which can't be seen here.
- Delete: DB row first (4939), then best-effort /github/delete whose errors are swallowed (4947-4961); worker GETs sha then DELETEs (worker.js:305-364).

### 6.3 Worker-side GitHub token & endpoint capability

- Secret GITHUB_BOT_TOKEN, documented as "fine-grained PAT, Contents r/w on bicipikay/ophelia" (worker.js:15). Endpoints present: /github/upload (single-file Contents PUT) and /github/delete (single-file Contents DELETE). No rename/move endpoint, no tree/commit/ref calls anywhere.
- Docs check (partial, via search snippets only because docs hosts are blocked): the Contents API "create or update file contents" and "delete a file" endpoints must be called serially; parallel calls conflict and error; classic tokens need repo scope. The Git-trees docs say a tree is built from base_tree plus your entries (your entries replace same-path items); with no base_tree every other file is treated as deleted; the tree must then be wrapped by Create a commit and a branch moved with Update a reference. I could not confirm from the docs: the exact error/status when sha is missing/stale on update, the sha: null deletion semantics in tree entries, whether a fine-grained PAT's "Contents: write" is sufficient for the Git Data endpoints, or file-size limits. Treat those as unverified.
- Feasibility of a single-commit rename (old path → new path): with only the Contents API it is two commits (PUT new, then DELETE old), non-atomic and must be serialised; a failure between leaves both or neither inconsistent with the DB. A single commit needs the Git Data flow (get ref → get commit/tree → create tree with {path:old, sha:null} + {path:new, sha:<existing blob sha>} → create commit → update ref), which the worker does not implement; whether the existing token suffices is the unverified point above (my recollection is that "Contents: write" covers it — not confirmed here). After rename the client must PATCH tiles.image_url with a fresh ?v= and handle collision with an existing target path (currently overwrite-by-default would clobber it).

## 7. AUTH BOOT AND SESSION

### 7.1 Initialisation

Firebase compat SDK 10.0.0 loaded via `<script>` (39-40), firebase.initializeApp(...) inline (41-50; same config duplicated in auth/callback.html:10-17). Login flow: PKCE → Discord authorise (2250-2265; no state param) → auth/callback.html → POST /discord-token (worker exchanges code, mints a Firebase custom token for uid = Discord id with claims.role='authenticated', worker.js:607-636) → firebase.auth().signInWithCustomToken → getIdToken() → writes localStorage.oph_user = {id, username, avatar, firebaseToken, firebaseTokenExpiry (+1h), accessToken, refreshToken, tokenExpiry} (callback.html:129-140) → upserts profile (143-155) → location.href='../index.html' (164).

The Firebase SDK session is not what the app trusts. currentUser is initialised synchronously from localStorage.oph_user (811). firebase.auth().onAuthStateChanged is used only once, as a readiness gate (949-955).

### 7.2 What renders before auth resolves; the login flash

Sequence on page load:

1. Document loads unpinned React dev builds + Babel standalone from unpkg (26-28) and the 530 KB inline text/babel script is transpiled in the browser (121) before anything mounts → blank page painted with the dark html/body background set by the inline script (94-116). (Not a login flash, but a long blank.)
2. App first render: showLogin = useState(!isAuthenticated) (923), where isAuthenticated demands firebaseTokenExpiry - 90 s > now and tokenExpiry - 90 s > now (911-915). authChecked=false → loading splash (5973-5986) shown for at least 1000 ms (950) and until onAuthStateChanged fires.
3. Then, if isAuthenticated was false at first render, the login card is shown (5989-6031) — this is the flash: any user whose stored Firebase ID token is older than ~1 h (they last used the app > 1 h ago) is "unauthenticated" on boot even though a valid Discord refresh token exists.
4. In parallel the profile effect (2180-2198) runs whenever currentUser?.firebaseToken exists (not gated on isAuthenticated) and calls getValidToken() (853-905), which refreshes Discord (/discord-refresh) then Firebase (/firebase-refresh) and setCurrentUser(updated). When that lands (typically after the splash) isAuthenticated flips true and the effect at 925-946 hides the login card → login card visible for the duration of the refresh round-trips (flash). If the refresh fails the user stays on the login card.
5. The tilesets/tiles fetch effect (2028-2151) runs only if (isAuthenticated) at the time it executes (2034); deps [currentUser?.id, tsFetchTrigger, userProfile?.role] do not include the token, so it re-runs only because userProfile.role changes after the profile fetch. (inference) If the profile fetch returns the same/absent role it would not re-run.
6. The 50 ms debounce (925-946) exists for "transient null on tab refocus": an authenticated→unauthenticated flip is only applied after 50 ms and only if still unauthenticated.

### 7.3 Supabase "client" and token timing

- No supabase-js. Each call is fetch(WORKER_URL/rest/v1/...) with Authorization: Bearer <currentUser.firebaseToken or refreshed> (e.g. 2055-2058). Worker forwards to Supabase REST, adding the anon apikey (worker.js:416-417); Supabase accepts the Firebase JWT via third-party auth. GETs are allowed anonymously through the worker (374-377); writes require a bearer whose payload decodes (decodeJwtPayload, no signature check in the worker proxy, 383-388) — signature validity is left to Supabase. The GitHub routes do verify the signature (239).
- Client-created timing: n/a (per-request tokens). Reads of tilesets/tiles take the token from getValidToken() if currentUser.firebaseToken is set, else go anonymous (2055-2058, 1272).

### 7.4 Token refresh and failure behaviour

- getValidToken (853-905): Discord refresh if within 60 s of tokenExpiry; Firebase re-mint (via /firebase-refresh using the Discord access token + signInWithCustomToken) if within 5 min of firebaseTokenExpiry; both failures are swallowed (871-873, 892-894) and the function returns the old, possibly expired token (904).
- It closes over the render's currentUser (stale closure). Several effects call it at the same time on boot (profile 2183, tilesets 2055, theme save 1377) → parallel /discord-refresh calls with the same refresh token. Discord rotates refresh tokens, so the loser's call will probably fail (unverified assumption about Discord); the worker also rate-limits /discord-refresh and /firebase-refresh at 5/min/IP (wrangler.toml:34-35, worker.js:55-58).
- 401 / expired JWT: there is no central fetch wrapper. Callers only test r.ok: tilesets → logs and shows an empty app (2061-2072); tiles → [] (1280); profile → setUserProfile(null) (2196); writes → alert('Failed…'). No retry-after-refresh, no "session expired" UI, no redirect to login.
- Long idle: the 1-hour Firebase expiry is evaluated only at render time (no timer). An idle tab stays "logged in" until any re-render, then isAuthenticated flips false → login card after 50 ms (925-946), with the map still in React state. Reopening after > ~7 days (Discord token expiry) gives a permanent login screen.
- No visibilitychange, focus, pageshow or online handlers exist (grep over index.html/callback.html); session health is never re-checked when a tab is re-focused.

### 7.5 Deep links / URL fragments

- The app reads no location.hash or location.search (grep). There is no router.
- Login does window.location.href = discord… (2264): the page (and any fragment) is abandoned; Discord only returns what is in redirect_uri/state; the code sends no state and the redirect URI is fixed; callback.html ends with a hard location.href='../index.html' (164,78,85,94,171) which drops query and fragment. Only sessionStorage.pkce_verifier crosses the hop (2252, callback.html:89-97). So a deep link/fragment would not survive a login redirect today. To carry it, the value would have to be stashed (sessionStorage/localStorage) before 2264 or sent as OAuth state, then read in callback.html and appended to the final redirect; the Discord app's registered redirect URI must remain exactly …/auth/callback.html.

## 8. TILE MODAL AND UI

### 8.1 Tile info modal (InfoModal, 4355-5003; mounted at 6047)

Top→bottom: header "Tile info" 4539-4542 → image area 4543-4559 (checkerboard tile-img-checker, 120/128 px, prev/next arrows when navTiles.length>1; nav = same tileset (and same folder) sorted by sortIndex, 4515-4534) → codename 4562-4581 (DB tiles read-only unless canEditDb; non-DB tiles write to tileNames) → folder_key 4584-4597 → sort_index 4599-4612 → size multiplier 4615-4631 → offsets 4633-4663 → flag grid 4670-4786 → Starred shortcut checkbox 4788-4794 → Save to Database 4797-4850 → Replace Image 4852-4913 → Delete 4915-4999. canEditDb = currentUser && t.isDb && t.dbId && (admin || t.tilesetOwnerId === currentUser.id) (4364). Surprising points:

- InfoModal (and ReplaceModal, OTGSettingsModal, ConvertModal, TilesetCompatModal, …) are components defined inside App and used as `<InfoModal />` (6047-6056). Their identity changes on every App render, so React unmounts/remounts them and resets their local state (inputs, delete-confirm, flag tooltip) on any App re-render while open. AddTileModal/TilesetGearModal were hoisted out for exactly this reason (comment 342-344, 404-406). Hooks are also called after early return null (4356-4365, 5104), which works only because of the remount. Adding an editable-filename field here inherits this.
- show_tile_count checkbox (4765-4782): its handler does `setInfoTile(prev => prev ? { ...prev, dbShowTileCount: checked } : prev)` (4777) but infoTile is a number everywhere else (6421,6695), so this turns it into an object; getTile(infoTile) then fails and the modal closes (inference from reading; not run). It also only mutates local rows, not the DB, until Save is pressed.
- Flags edited in the modal are local state keyed by integer (see §4.4) and only reach the DB via Save (4804-4821, explicit column list); last_updated_* are overwritten by the worker (worker.js:510-517).

### 8.2 Tile folder cards

renderFolderCard 6705-6739: 64 px card (56 mobile, 6642); preview = first 4 tiles (fTiles.slice(0,4), 6709) in a 2×2 CSS grid (6721-6730), padding with empty cells; the "play button" is a ▼ glyph (22 px) centred over the grid and rotated −90° when closed (looks like ▶) / 0° when open (6733-6735), pointer-events:none. Border colours: gold when it contains the selected tile (6708,6716), accent when open.

Click → toggleFolder(key, e) (1717-1727) stores openFolderKey and the anchor from getBoundingClientRect(); floating panel 6359-6434 (fixed position, 4 or 5 columns of 72/56 px cards, outside-click close 1729-1742, zIndex 2000). Flat cards: renderFlatCard 6656-6703. Starred folder shortcut in the left strip uses 📁 (7327-7346).

### 8.3 Essentials toolbar (6745-7074, collapsible via panelCollapsed.essentials)

Order: Erase 6754 (becomes "Deselect" when cells highlighted), Warn 6787, Hand 6808, Explore 6828, Pick/eyedropper 6852, Space 6872, Rotate 6897, Magnet 6928 (with 1×1/2×2/2×1/1×2 size dropdown), Highlight 6994, Duplicate 7026. Each is a card with an ⓘ → setInfoTool(key) → ToolInfoModal 5297-5362 (which also holds the star-to-shortcut checkbox). The right "Tools" panel 8137-8213 has selection modes, mirroring, Guides, Block Overwrite, Offset Centers, OTG Check, Replace, Convert, Hotkeys; its ⚙ opens Tools Settings 8107-8136 (Mirror Spawns, Mirror Rotation, Memory…).

### 8.4 Tile properties — what each does in code

| Property | Source (DB col / fallback) | Behaviour |
|---|---|---|
| rotatable | row.rotatable → isDefaultRotatable 1527, override rotatableMap | Card shows 🐬; click on selected card adds 90° (6680); placement stores gridRotations[r,c] 0–3 (2666,2682); render rotate(deg) (7574); mirrored copies rotated via applyRotMirror if setting on. Default by src containing /Water/ (164). |
| flippable | row.flippable → isDefaultFlippable 1538, override allowFlipMap | Card shows 🦭 when flip-only; per-cell gridFlips 0–3 → scale(fx,fy) (§9). Tooltip says "flipped horizontally" (4485) but implementation has 4 states. |
| mirror_offset | row.mirror_offset → 1548, override mirrorOffsetTiles | When a tile is placed via a mirror copy that flips X/Y, per-cell gridOffsets gets the negated offset (3238-3252). |
| priority | row.priority / TILE_SETTINGS.priority | Render pass 2, zIndex 9999 (7620-7644); mutually exclusive with bottom in UI (4745,4753). |
| bottom_render | row.bottom_render / TILE_SETTINGS.bottomRender | Pass 0, zIndex 1 below normal tiles (7567-7591); skipped if also priority (7571). |
| auto_shadow | row.auto_shadow | Extra black copy, brightness(0), 20 % opacity, shifted +30 % cell (7583-7589 etc.); default false for non-DB. |
| otg_passable | row.otg_passable → isDefaultOTGWall = !otg_passable 1559, override otgWallOverrides | Treated as non-wall by the One-Tile-Gap detector (1570-1638); overlay 7798-7818. Default substrings 166. |
| show_tile_count | row.show_tile_count | "×N" badge via CountBadge (1660-1669) — DB only; the older per-user tileCountMap/showTileCount state is saved but unused. |
| size_multiplier, offset_x/y | row, else getDefaultMultiplier/Offset | Draw width CELL*mult, offset in % of a cell (7572-7581, export 4287-4303). |
| sort_index, folder_key, codename | row | Order, grouping into folders (1788-1795), switching key. |

## 9. FLIPPING

- State: per cell: gridFlips["r,c"] = 0|1|2|3 (1125; persisted oph_grid_flips 1344; in undo snapshots flips). Per tile card (session only, not persisted): cardFlipSteps[id] 0–3 (1122) and cardFlipModes[id] (1120).
- Meaning (code comment 1121): 0 = none, 1 = flip X, 2 = flip X + Y, 3 = flip Y. Render: fx = (step===1||2) ? -1 : 1, fy = (step===2||3) ? -1 : 1, applied as rotate(rotDeg) scale(fx, fy) (7576,7581, 7603,7608, 7629,7634); export 4297-4301.
- Why it cycles through upside-down states: every advance is (cur + 1) % 4 — card click 6678,6401,7274,7363,7401, R hotkey 4099, [/] 4133, Rotate tool on a placed cell 3876-3878, 7497-7499. Steps 2 (X+Y = 180° mirror/point-flip) and 3 (Y only = upside-down) are part of the cycle, so a "flip" reaches vertically inverted states; there is no 2-state (H-only) mode. Only the flippable tooltip text (4485) implies horizontal-only.
- Placement: paintCells 2690-2702 and commitMultipleCells 2790-2801 write flipStep = cardFlipSteps[tileId] only when effective mode is 'flip'; mirrored copies get the same flipStep (no mirroring of flips, unlike rotation which uses applyRotMirror). Drag pick-up preserves flip (3119, 4025-4031).
- Mode logic: mode = !canFlip ? 'spin' : (!canSpin ? 'flip' : cardFlipModes[id] ?? 'spin') (e.g. 4097, 6667). setCardFlipModes is never called with 'flip' anywhere (only deletions/pruning: 1983,4704,4716), so a tile that is both rotatable and flippable can never enter flip mode; flip is reachable only for flip-only tiles (default: /Fence/, /Rope/, Jumppads/, 164).
- Rotation (for contrast): gridRotations["r,c"] 0–3 = ×90° clockwise (2633-2638).

## 10. MIRRORING AND MAP SIZES

### 10.1 Mirroring

- Flags mirrorV (UI label "Horizontal", left↔right), mirrorH ("Vertical", top↔bottom), mirrorD ("Diagonal", 180° point reflection) (990-992, UI 8162-8164, doc 5308-5310). Names are inverted relative to the axis.
- getMirrorMeta(r,c) 2616-2631 returns [{pos,fV,fH,fD}] using the effective centre getEffectiveCenter 2596-2608: V → [r, round(2cC−c)]; H → [round(2cR−r), c]; D → [round(cR−oR), round(cC−oC)] = [2cR−r, 2cC−c]. Out-of-grid entries and duplicates are dropped (2626-2630). The V+D, H+D and V+H+D entries (2623-2625) compute the same coordinates as D and are always de-duplicated → dead code; also V+H alone yields 3 cells, the 4th corner needs D enabled.
- Consumers: paintCells 2663, commitMultipleCells 2739, drag-drop 3509-3553, highlight/duplicate 2465, 3388-3403, guides 7735, highlight overlay 7846. Spawn/goal team swap when fH||fD (2673, swapSpawnId 1514), rotation mirroring by mirrorRotation, offsets by mirror_offset. Mirroring UI is locked while cells are highlighted (8159-8172). Mirror positions use positions only — tile identity is not involved.
- Magnet / centre offset: customCenter {r,c}|null (1029-1034, persisted oph_custom_center), customCenterSize 1=1×1, 2=2×2, 3=2×1 (wide), 4=1×2 (tall) (1035-1038; comment 2600). Default: customCenter = null → true geometric centre ((H−1)/2, (W−1)/2) (2593, 2607), so even dimensions give a half-cell axis between two rows/cols. With a custom centre the effective centre is cc + sz/2 clamped (2599-2606). The size dropdown labels a parity-based "★ default" (6945-6948) (even/even→2×2 …) but the state default is 1 (1036), so a freshly placed magnet on an even grid is 1×1 while the dropdown marks 2×2 as default. Magnet placement: 2997-3006, touch 3682-3689.

### 10.2 Map sizes

Constants GRID_W=21, GRID_H=33 (125) = 3v3 21×33 — confirmed. Dropdown 8401-8420: options 3v3 (21×33), Showdown (60×60) (SD = 60×60 — confirmed), a transient Custom (W×H) option when current size matches neither (8402,8416), and Custom Map Size… (8417) → modal 6293-6321 (free W×H, clamped 1–99, 4149, 6303,6308). These are the only presets. Changing size goes through a confirmation (6324-6356) and applyGridSize 4148-4183 (crops/pads grid, prunes rots/flips/offsets; does not touch customCenter or history semantics).
Persisted: oph_gridW/H (1415-1416).

## 11. DATA ACCESS

Always through the worker (WORKER_URL = https://oph.opheliapp.workers.dev, 147); the SUPABASE_URL constant (146) is unused. Worker proxy worker.js:366-440: any /rest/v1/* or /storage/v1/* path is forwarded (no table/column allow-list); writes need a bearer; DELETE on profiles|tilesets|tiles is admin-only (25-29, 390-396); POST/PATCH/PUT bodies are sanitised: non-admins can't set owner_id ≠ self or role; last_updated_at/by are server-forced (485-520). If the body fails to parse/sanitise the worker forwards the original body (408-410).

UI/worker mismatch: the tile Delete button (4916) and tileset Delete (564-590, canManage = admin || owner) are offered to owners/creators, but the worker returns 403 for non-admin DELETEs (390-396), so owners can't actually delete via the app (from code; RLS not visible).

Reads (all GET):

- tilesets?[or=(is_published.eq.true,owner_id.eq.<uid>)|is_published=eq.true]&type=in.(…)&order=name&select=*,profiles(username) (2044-2054) — select=* plus an FK embed. New columns (seed_id) arrive automatically; type filter must go.
- tiles?tileset_id=eq.<id>&order=sort_index — no select → * at 1273-1275, 1857-1859, 2092-2094, 2129-2132, 2161-2163, 5582-5584. New columns (sensor_code, sensor_roll, symbol) arrive automatically but are dropped when rows are mapped to tile objects — the mapping is hand-written twice: 1291-1315 and 1763-1787. No pagination/limit: a tileset > PostgREST's max-rows (default 1000, unverified for this project) would truncate silently.
- tiles?id=eq.<uuid>&select=tileset_id (2118), tiles?tileset_id=eq.<id>&select=id (568).
- profiles?id=eq.<uid>&select=id,username,avatar_hash,role,theme (2184); profiles?select=id,username[,avatar_hash,role]&order=username (456, 2206).

Writes

- tilesets INSERT {name, folder_path, type, owner_id, is_published} 5771-5775 (must drop type; seed_id is trigger-assigned so keep out of body); PATCH {name} 496, {is_published} 516, {is_wip} 531, {bg_color_light,bg_color_dark} 549, {owner_id} 697; DELETE 577.
- tiles INSERT 5787 (create) and 5932 (add): explicit columns tileset_id, codename, image_url, folder_key, sort_index, rotatable, flippable, otg_passable, mirror_offset, bottom_render, priority, auto_shadow, show_tile_count, size_multiplier, offset_x, offset_y — new columns (sensor_*, symbol) need adding here and to the PATCH list; PATCH {image_url} 4466; PATCH full flag set 4804-4830 (codename, folder_key, sort_index, … last_updated_*); DELETE 4939.
- profiles upsert (auth/callback.html:143-155, Prefer: resolution=merge-duplicates), PATCH {theme} 1378, PATCH {role} 2218.
- GitHub: /github/upload 4459,5756,5920; /github/delete 4953.
- Admin sees all tilesets; others published or own (2043-2051). Snowtel Gifts with owner_id null is visible to non-admins only if is_published.

## 12. DEAD OR RISKY CODE

Dead / unused

- SK.tiles (131), ATLAS_ID_MAX (140), WIP_TILESETS (159), SUPABASE_URL (146), tilesetBgColors state (setter never called, reads at 1939,1961; key oph_ts_bg never written), tileCountMap/showTileCount (persisted, never used for rendering), isAtlas branches (257,267,4363,5612), V+D/H+D/V+H+D mirror entries (2623-2625), map_image_import.js:815-833.
- Resources/{Airport,Cafe,Halloween,Mausoleum,Pharmacy,Sewer}/* and Resources/manifest.json:tilesets[] (never read). Resources/*/zzz.txt placeholders; favicon/about.txt.
- Worker legacy X-Discord-Token admin path (worker.js:453-468) — no frontend caller; BLOCKED_IPS empty (23).
- Hotkeys modal advertises "Arrow keys – Pan the map" (5542) — no arrow-key handler in the keydown effect (4070-4145).

Risky / surprising

- Everything in §4 (non-unique runtime IDs, first-match vs last-match vs active-wins).
- Hooks after early returns in nested components (4356-4365, 5104); components defined inside App (remount on each render).
- show_tile_count handler turning infoTile into an object (4777).
- doCreateTs uploads to GitHub before creating the DB rows (5756 vs 5771): failure leaves orphan files; doAddTile same ordering.
- Upload overwrites silently (§6); worker has no tileset-ownership check.
- Owner/creator delete vs admin-only worker DELETE (§11).
- getValidToken stale closure + parallel refresh + swallowed errors (§7).
- 8434-line single file transpiled in the browser on every load, unpinned react@18 from unpkg (26-28).
- History semantics mixed (state histIdx vs histIdxRef; pre- vs post-state pushes) — see §5.
- gridOffsets is not in undo snapshots, so undoing a mirror-offset placement leaves overrides behind (from code).
- deriveCodename stem map applied to DB tiles (§2).
- Local data: user uploads stored as base64 in localStorage (1319).
- Static: CORS fixed to bicipikay.github.io (worker.js:18) while this repo is homeland-bloc/theme-tester — if the app is served from another origin the worker rejects it.
- Tests that will break: none exist (no test files, no runner, no CI config in the repo).

## DEPENDENCY-ORDERED FILE LIST PER PLANNED FEATURE

Order matters: 0 → 1 → … ; later items assume earlier ones.

0. Hotfix for type drop (prerequisite for anything testable): index.html:2052,2081,5774 (+ 5411-5413,6582-6583,8267-8268 so the lists render).
1. Remove atlas / tileset type concept: index.html (§1, §2 lists; 139-140,5091,5211; 1457-1458,1486-1487; 248-269; 1130), map_image_import.js (deleted in 3). Decide fate of Resources/<Theme>/* and Resources/manifest.json:tilesets[].
2. Creator in admin dashboard: index.html:6187-6198 (data already present via 2054); optionally 684.
3. Remove Import Map from Image: index.html:120,1167,1418-1435,8261; delete map_image_import.js.
4. Remove Rotate + Explore (+ mirror-rotation setting): index.html §3b–3d sites; worker.js untouched. Decide post-removal rotation UX first (§3b caveat).
5. Unique tile IDs + tagged per-map palette (fixes mixing, stray flags, multi-select): index.html broadly (§5 list), then re-test 1, 4 (those features depend on identity). Resources/manifest.json if globals get stable tags.
6. Editable tile image filename (rename on GitHub): worker.js (new route, token capability check), index.html InfoModal 4562-4581, save path 4797-4850, URL builder (3 call sites 4465,5768,5930); depends on 5 only for stable references (palette stores d:uuid, so rename itself is independent of 5). Also needs the duplicate/overwrite policy in §6.2.
7. Auth boot & deep-link survival: index.html:811-955,5973-6031, 2250-2276, auth/callback.html, worker.js (OAuth state is client-only; refresh endpoints rate limits wrangler.toml). Must precede map seeds/links (share links need to survive login).
8. Sensor folders (neighbour-based variants): DB columns + index.html tile mapping (1291-1315, 1763-1787), InfoModal, add/create/patch bodies (4804-4830, 5787, 5932), new neighbour logic in paint/commit/mirror/drag paths (2663-2835, 3509-3553, 4018-4040), render. Depends on 5 (palette tags to compare neighbours) and on mirror semantics.
9. Map seeds (shareable string + link): depends on 5 (compact palette) and 7 (deep link); tilesets.seed_id read via the existing select=* (2054); index.html new encode/decode beside encodeGridForStorage 270-282; local uploads (u:) cannot be encoded.

## QUESTIONS THE CODE COULD NOT ANSWER

1. Where is the app actually deployed and which repo holds tile images — bicipikay/ophelia (hard-coded) or this repo? Is CORS/ALLOWED_ORIGIN expected to change?
2. RLS policies on profiles/tilesets/tiles: can owners/creators PATCH/DELETE their own rows? (Worker blocks non-admin DELETE.) Is there a unique constraint on (tileset_id, codename)? On image_url?
3. Does tilesets.sort_index still exist? Is the FK tilesets.owner_id → profiles.id what enables profiles(username)?
4. Does the GitHub bot token (fine-grained, Contents r/w) work for the Git Data API (trees/commits/refs)? Is the repo's default branch main? (docs unreachable here)
5. What is the exact bit order/meaning of sensor_code (8 neighbours; which is bit 0; what do sensor_roll and symbol choose between) and does the pattern relate to Resources/Global/Water/00001011.png-style names?
6. Tiles have no stable small integer; for shareable seeds should tiles get one (new column), or should the palette reference (seed_id, sort_index) / codename (editable, so unstable)?
7. After removing the Rotate tool, how should a placed tile's rotation/flip be changed? After removing "mirror rotation", should mirrored copies of rotatable tiles always rotate, never rotate, or copy source rotation?
8. Should flip be 2-state (H only) or keep 4 states? Should mirrored copies mirror flips?
9. Intended behaviour for a map that mixes tilesets (the "tagged palette"): may a map contain tiles from several tilesets at once, and should switching tileset convert only the active tileset's tiles?
10. What should happen to old saved maps/localStorage (d: palettes of deleted atlas tiles, numeric starred/recent ids)? Migration or reset?
11. Max tiles per tileset expected (PostgREST max-rows) and whether Snowtel_Gifts already contains files whose names would collide on rename.
12. Is Discord's refresh-token rotation (parallel refresh failures) a real problem in production logs? (wrangler.toml has observability enabled; not accessible here.)

## TOP 5 HIGHEST-RISK AREAS FOR THE PLANNED CHANGES

1. Tile identity rework (§4/§5): the integer ID leaks into ~25 state maps, history snapshots, persistence, mirroring, drag/drop, replace/convert/switch, and render passes. Half-migrated states will make the same "wrong tile" bugs appear in new ways; saved-map and starred/recent migration must be designed first.
2. Tileset switching + multi-tileset maps (§4.6): remap-by-codename over a non-unique key; the new tagged palette must define exactly which tiles a switch converts, and history/undo restoring activeTileset (name-keyed) needs the same treatment (rename of a tileset currently desyncs name-keyed state).
3. GitHub rename/upload path (§6): no Git Data support, silent overwrite, unsanitised filenames, URL-encoding mismatch, no ownership check, DB-vs-GitHub ordering. A rename that updates image_url while GitHub/DB diverge produces broken tiles for everyone (shared tiles), and docs for the single-commit flow couldn't be verified here.
4. Auth boot/session (§7): cutting the login flash safely means changing how isAuthenticated, showLogin, getValidToken and the tilesets effect interact; the stale-closure/parallel-refresh/swallowed-error behaviour and the 5/min auth limiter can lock users out. Deep links/seeds depend on this.
5. Removal of Rotate/Explore/Import/mirror-rotation entangled with shared handlers: the Rotate path shares the canvas onMouseDown with Hand (7434-7516), touch handlers (3841), ~55 setRotateMode/setExploreMode call sites, and flatDefaultTilesRef/ensureTilesetLoaded are shared with other features; removing the only post-placement rotate/flip UI and the mirror-rotation rule changes map behaviour for existing saved maps.
