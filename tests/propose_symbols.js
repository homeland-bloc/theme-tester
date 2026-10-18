// Report (never applies) which DB tiles have no symbol and the SQL that would set the standard ones.
//   node tests/propose_symbols.js export.json
// export.json: { "tilesets": [{ "id", "name" }], "tiles": [ { "id", "tileset_id", "codename", "folder_key", "sensor_code", "symbol", "sort_index" } ] }
// (a JSON export of the tilesets and tiles tables; this script never talks to any service).
const fs = require("fs");
const M = require("../map_seed.js");
const file = process.argv[2];
if (!file) { console.error("usage: node tests/propose_symbols.js export.json"); process.exit(2); }
const data = JSON.parse(fs.readFileSync(file, "utf8"));
const proposals = M.proposeSymbols(data.tiles, data.tilesets);
let last = null;
for (const p of proposals) {
  if (p.tileset !== last) { console.log("\n== " + p.tileset); last = p.tileset; }
  console.log(`  ${p.folder ? p.folder + "/" : ""}${p.codenames.join(", ")}  ->  ${p.symbol ?? "(none free)"}   [${p.rule}]`);
}
console.log("\n-- SQL (review, then run yourself)\n" + M.proposalSql(proposals));
