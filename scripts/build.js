#!/usr/bin/env node
/*
  Builds the demo page from site/template.html, the data, Claude's recorded
  reads and the agent code. Writes docs/index.html (served by GitHub Pages).
  Usage: node scripts/build.js [--artifact path/to/page-content.html]
*/
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const escHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const run = JSON.parse(read("reads/run.json"));
run.modelName = run.model
  .replace(/^claude-/, "Claude ")
  .replace(/-(\d+)-(\d+)$/, " $1.$2")
  .replace(/\b(sonnet|opus|haiku|fable)\b/i, (m) => m[0].toUpperCase() + m.slice(1));

const data = {
  patients: JSON.parse(read("data/patients.json")),
  documents: JSON.parse(read("data/documents.json")),
  replies: JSON.parse(read("data/replies.json")),
  reads: { documents: JSON.parse(read("reads/documents.json")), replies: JSON.parse(read("reads/replies.json")) },
  prompts: { document: read("prompts/read_document.txt"), reply: read("prompts/read_reply.txt") },
  run,
};

const agent = read("agent/agent.js");
if (/<\/script/i.test(agent)) throw new Error("agent.js must not contain a closing script tag");
const t = read("site/template.html");
const between = (a, b) => t.slice(t.indexOf(a) + a.length, t.indexOf(b));
const fill = (s) => s
  .replace("{{PROMPT_DOC}}", escHtml(data.prompts.document.trim()))
  .replace("{{PROMPT_REPLY}}", escHtml(data.prompts.reply.trim()))
  .replace(/\{\{WORKFLOW\}\}/g, "data:image/svg+xml;base64," + Buffer.from(read("site/workflow.svg")).toString("base64"))
  .replace("{{DATA}}", JSON.stringify(data).replace(/<\//g, "<\\/"))
  .replace("{{AGENT}}", agent);
const head = fill(between("<!-- HEAD -->", "<!-- /HEAD -->")).trim();
const body = fill(between("<!-- BODY -->", "<!-- /BODY -->")).trim();
if (/\{\{[A-Z_]+\}\}/.test(head + body)) throw new Error("unfilled placeholder");

const page = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' +
  head + "\n</head>\n<body>\n" + body + "\n</body>\n</html>\n";
fs.mkdirSync(path.join(root, "docs"), { recursive: true });
fs.writeFileSync(path.join(root, "docs/index.html"), page);
console.log("wrote docs/index.html (" + page.length + " bytes)");

const i = process.argv.indexOf("--artifact");
if (i > 0 && process.argv[i + 1]) {
  // The artifact copy lives outside GitHub Pages, so it links to the workspace page there.
  fs.writeFileSync(process.argv[i + 1], head + "\n" + body.replace('href="workspace.html"', 'href="https://nitchakorn.github.io/BreastCancerScreening/workspace.html" target="_blank" rel="noopener"') + "\n");
  console.log("wrote " + process.argv[i + 1]);
}

/*
  docs/workspace.html: the local workspace page, running in the browser.
  The server modules are bundled as they are, with a tiny module loader. Only node:sqlite,
  node:crypto and the prompt files are swapped (see site/browser-workspace.js).
*/
const SQLJS = "https://cdn.jsdelivr.net/npm/sql.js@1.14.2/dist/";
const MODULES = ["agent/agent.js", "server/policy.js", "server/loop.js", "server/samples.js", "server/store.js", "server/reader.js", "server/api.js",
  "data/documents.json", "data/replies.json", "data/sample-replies.json", "data/patients.json",
  "reads/documents.json", "reads/replies.json", "reads/sample-replies.json"];
const moduleSource = (id) => id.endsWith(".json") ? "module.exports = " + JSON.stringify(JSON.parse(read(id))) + ";" : read(id);
const loader = `window.WorkspaceModules = (function () {
  var prompts = ${JSON.stringify({ "read_document.txt": read("prompts/read_document.txt"), "read_reply.txt": read("prompts/read_reply.txt") })};
  var shims = {
    "node:sqlite": {}, "node:crypto": {},
    "node:fs": { readFileSync: function (p) { return prompts[String(p).split("/").pop()]; }, existsSync: function () { return false; } },
    "node:path": { join: function () { return [].slice.call(arguments).join("/"); }, dirname: function (p) { return String(p).split("/").slice(0, -1).join("/"); }, basename: function (p) { return String(p).split("/").pop(); } }
  };
  var defs = {
${MODULES.map((id) => "    " + JSON.stringify(id) + ": function (module, exports, require, __dirname) {\n" + moduleSource(id) + "\n    }").join(",\n")}
  };
  var cache = {};
  function resolve(dir, spec) {
    var parts = (dir ? dir.split("/") : []).concat(spec.split("/")), out = [];
    parts.forEach(function (p) { if (p === "..") out.pop(); else if (p && p !== ".") out.push(p); });
    return out.join("/");
  }
  function load(id) {
    if (cache[id]) return cache[id].exports;
    if (!defs[id]) throw new Error("Module not bundled: " + id);
    var module = cache[id] = { exports: {} }, dir = id.split("/").slice(0, -1).join("/");
    defs[id].call(module.exports, module, module.exports, function (spec) { return spec.indexOf("node:") === 0 ? shims[spec] : load(resolve(dir, spec)); }, dir);
    return module.exports;
  }
  return { load: load, shims: shims };
})();`;

const appPage = read("app/index.html");
const appScript = "window.startWorkspaceApp = function () {\n" + read("app/app.js") + "\n};";
const browserScripts = [loader, appScript, `window.SQLJS_BASE = ${JSON.stringify(SQLJS)};`, read("site/browser-workspace.js")]
  .map((s) => s.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--"));
const workspace = appPage
  .replace('<title>Agent workspace · Breast screening follow-up</title>', '<title>Try the agent · Breast screening follow-up</title>')
  .replace('<link rel="stylesheet" href="/app.css">', "<style>\n" + read("app/app.css") + "</style>")
  .replace('<script src="/app.js" defer></script>\n', "")
  .replace('href="/simulation#workflow">View simulation &amp; workflow</a>', 'href="./#workflow">View simulation &amp; workflow</a>')
  .replace("<footer>", '<footer><p>This page runs the local workspace in your browser: the same page, engine and server code, with SQLite compiled to WebAssembly (sql.js) and Claude’s recorded reads. Your cases stay in this browser. <a href="https://github.com/nitchakorn/BreastCancerScreening#local-agent-workspace">Run it with live Claude reads</a>.</p>')
  .replace("</body>", `<script src="${SQLJS}sql-wasm.js"></script>\n` + browserScripts.map((s) => "<script>\n" + s + "\n</script>").join("\n") + "\n</body>");
if (/href="\/|src="\//.test(workspace)) throw new Error("workspace.html still has a root-relative link");
fs.writeFileSync(path.join(root, "docs/workspace.html"), workspace);
console.log("wrote docs/workspace.html (" + workspace.length + " bytes)");
