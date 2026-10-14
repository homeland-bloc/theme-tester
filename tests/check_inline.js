// Run with: node tests/check_inline.js   Syntax-checks every inline <script> of index.html (the text/babel one as JSX) with TypeScript's parser.
// Needs the `typescript` package (global install is found automatically); prints SKIP and exits 0 when it is not available.
const fs = require("fs");
const path = require("path");
let ts;
try { ts = require("typescript"); } catch {
  try { ts = require(path.join(require("child_process").execSync("npm root -g").toString().trim(), "typescript")); } catch { console.log("SKIP typescript not installed"); process.exit(0); }
}
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
let m, n = 0, bad = 0;
while ((m = re.exec(html))) {
  if (/\bsrc=/.test(m[1])) continue;
  n++;
  const jsx = /text\/babel/.test(m[1]);
  const out = ts.transpileModule(m[2], { reportDiagnostics: true, fileName: jsx ? "inline.jsx" : "inline.js", compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ESNext, allowJs: true, noEmit: true } });
  for (const d of out.diagnostics || []) {
    bad++;
    const pos = d.file && d.start != null ? d.file.getLineAndCharacterOfPosition(d.start) : { line: 0, character: 0 };
    const line = html.slice(0, m.index + m[0].indexOf(">") + 1).split("\n").length + pos.line;
    console.error(`index.html:${line}:${pos.character + 1} ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
  }
}
console.log(bad ? `FAIL ${bad} syntax error(s)` : `ok   ${n} inline scripts parse`);
process.exitCode = bad ? 1 : 0;
