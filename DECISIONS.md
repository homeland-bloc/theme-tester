# Opheliapp update: decisions (frozen unless the owner changes them)

## Data model (already migrated live)
- tilesets: no `type` column. Creator = owner_id -> profiles.username, "-" if null. seed_id integer, unique, immutable, trigger-assigned, never reused. Snowtel Gifts = 0 (default tileset). folder_path = GitHub folder name.
- tiles: sensor_code (nullable text, 8 chars 0/1), sensor_roll (int >= 0, default 1, 0 = never auto-picked), symbol (nullable single char). folder_key = in-app tile folder.
- Tables are only profiles, tilesets, tiles. Maps, starred, local uploads are local-only.
- Codenames are unique per tileset. Same codename across tilesets = resolvable on tileset switch.
- Atlas is removed. Only the generic code path exists. The global tileset (Resources/manifest.json) is a fallback layer, never selectable.

## Rules
- One tileset per map. Switching converts plain tiles by codename and sensor folders by folder key; unmatched cells become empty after a confirmation.
- Cells reference tiles by tagged palette entries (kinds: tileset tile, sensor folder, global tile, local upload). Never by a non-unique number. Flags belong to the tile (or sensor group), never to a palette index.
- Local uploads are separate from tilesets and never resolved on switch.

## Sensor folders (later phase)
- Bit order, left to right: NW N NE W E SW S SE (centre skipped). Spin: clockwise 90 degrees moves each neighbour one step around the ring. Flip is horizontal only (W<->E, NW<->NE, SW<->SE), boolean.
- A sensor folder = tiles sharing (tileset, folder_key) where sensor_code is not null. Plain folders have sensor_code null. null and 00000000 are different.
- Resolution: exact explicit match, then spin/flip of an explicit tile if the folder allows, then quadrant composition if spin is on, then best score (most matched neighbours, then fewest dangling connections), then 00000000. Ties go to 00000000 if present, else weighted random.
- Same-code variants form a random pool weighted by sensor_roll. Rolls come from a position hash (fixed salt, x, y, folder). Mirrored cells roll independently.
- Neighbours count only within the same folder. Map edge is air. The map stores the logical tile, never the variant.
- Group settings (flags, symbol, rotatable, flippable) are shared across the folder; a warning button lists divergence (flags, size, offsets, symbol only).
- UI: sparkle emoji centre, yellow outline, play button as small corner info-style button; unfolded folder shows real variants, then derived ones (no info buttons on derived), plus a "Sensor folder simulation" button (3x3 grid, shows chosen variant and roll percentages).

## Seeds (later phase)
- Format: size/magnet/mirror/tileset/palette/code. size: 3v3 (21x33), SD (60x60), or WxH. magnet: x for default, else col,row. mirror: d (180-degree central), h, v, a, 4. tileset: decimal seed_id. palette: symbols by frequency, ties by code-point order. code: packed cell indexes, compact. No version, no checksum, no map name. Cell count must equal W*H.
- Unknown seed_id falls back to 0 with a notice. Tiles without symbol or local uploads export blank with a warning.
- Symbols: official table (M Wall1, X Wall2, Y Crate, C Barrel, F Bush, T Cactus, B Skull, N Fence, W Water, a Rope, 8 objectives, c d e f teleporters blue/green/red/yellow, w fast, z slow, plus spawns and springpads). Tileset-exclusive tiles get one free character, suggested not invented. No two-character symbols.
- Share links carry the seed in the URL fragment; login is required, so the seed must survive login via sessionStorage.

## Other rulings
- Filenames: default = codename; sensor tiles = <FolderName>_<sensorcode>[_n].png; editable in the tile modal; never overwrite; bulk rename copy-first then delete old. Owner deletes need a type-the-name confirmation modal. Worker must check tileset ownership.
- mirror_offset stays. Colour filters are local only with a rainbow badge. Import Map from Image is removed.
- Old saved maps and numeric per-tile overrides are not migrated.
- Testing is done live after the full update.
- Tileset export (zip, phase 12): sensor tiles are <code>.png inside the folder named after the sensor folder (_2, _3 only for duplicate codes); plain tiles keep their codename. "Include tiles.json" defaults to off. Composed variants use the shared top-edge quadrant geometry (seam y = min(H, topEdge + W/2)).
