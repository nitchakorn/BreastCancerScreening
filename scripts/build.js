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
  fs.writeFileSync(process.argv[i + 1], head + "\n" + body + "\n");
  console.log("wrote " + process.argv[i + 1]);
}
