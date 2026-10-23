#!/usr/bin/env node
/*
  The reading step. Sends every report and every patient reply to Claude,
  one call each, and saves what Claude says to reads/.

  Needs Claude Code installed and signed in (the `claude` command).
  Usage: node scripts/read.js
*/
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const docs = JSON.parse(read("data/documents.json"));
const replies = JSON.parse(read("data/replies.json"));
const docPrompt = read("prompts/read_document.txt");
const replyPrompt = read("prompts/read_reply.txt");
const rawDir = path.join(root, "reads/raw");
fs.mkdirSync(rawDir, { recursive: true });

const jobs = [
  ...docs.map((d) => ({ id: d.id, kind: "document", input: docPrompt + "\n\nDocument:\n" + d.text })),
  ...replies.map((r) => ({ id: r.id, kind: "reply", input: replyPrompt + "\n\nHer reply:\n" + r.text })),
];

function runOne(job) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    // If this runs inside a Claude Code session, give each call its own session id
    // so the calls don't write into the parent session.
    if (env.CLAUDE_CODE_SESSION_ID) env.CLAUDE_CODE_SESSION_ID = randomUUID();
    const child = spawn("claude", ["-p", job.input, "--output-format", "json", "--tools", ""], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (b) => (out += b));
    child.on("close", () => {
      fs.writeFileSync(path.join(rawDir, job.id + ".json"), out);
      resolve();
    });
  });
}

async function main() {
  const queue = jobs.slice();
  const workers = Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const job = queue.shift();
      process.stdout.write("reading " + job.id + "\n");
      await runOne(job);
    }
  });
  await Promise.all(workers);
  collect();
}

function collect() {
  const outDocs = {}, outReplies = {};
  let cost = 0;
  const ms = [], models = {};
  for (const job of jobs) {
    const raw = JSON.parse(fs.readFileSync(path.join(rawDir, job.id + ".json"), "utf8"));
    const text = raw.result || "";
    const m = text.match(/\{[\s\S]*\}/);
    let parsed = null;
    try { parsed = m ? JSON.parse(m[0]) : null; } catch (e) { parsed = null; }
    if (!parsed) console.warn("could not parse " + job.id);
    (job.kind === "document" ? outDocs : outReplies)[job.id] = parsed;
    cost += raw.total_cost_usd || 0;
    if (raw.duration_ms) ms.push(raw.duration_ms);
    for (const [name, u] of Object.entries(raw.modelUsage || {})) models[name] = (models[name] || 0) + (u.outputTokens || 0);
  }
  ms.sort((a, b) => a - b);
  const model = Object.entries(models).sort((a, b) => b[1] - a[1])[0];
  const run = {
    date: new Date().toLocaleDateString("en-CA"),
    model: model ? model[0] : "unknown",
    calls: jobs.length,
    total_cost_usd: Math.round(cost * 1000) / 1000,
    median_seconds: ms.length ? Math.round(ms[Math.floor(ms.length / 2)] / 100) / 10 : null,
  };
  fs.writeFileSync(path.join(root, "reads/documents.json"), JSON.stringify(outDocs, null, 2) + "\n");
  fs.writeFileSync(path.join(root, "reads/replies.json"), JSON.stringify(outReplies, null, 2) + "\n");
  fs.writeFileSync(path.join(root, "reads/run.json"), JSON.stringify(run, null, 2) + "\n");
  console.log(run);
}

if (process.argv.includes("--collect-only")) collect(); else main();
