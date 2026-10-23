#!/usr/bin/env node
/*
  The reading step. Sends every report and every patient reply to Claude,
  one call each, and saves what Claude says to reads/.

  Needs Claude Code installed and signed in (the `claude` command).
  Usage: node scripts/read.js              reports and replies used by the simulation
         node scripts/read.js --samples    extra sample replies for the workspace only
         node scripts/read.js --only P10-dx,P10-r1 --note "what was added"
                                           reads only those items and adds them to the saved run
*/
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const docs = JSON.parse(read("data/documents.json"));
const replies = JSON.parse(read("data/replies.json"));
const samplesOnly = process.argv.includes("--samples");
const sampleReplies = JSON.parse(read("data/sample-replies.json"));
const docPrompt = read("prompts/read_document.txt");
const replyPrompt = read("prompts/read_reply.txt");
const rawDir = path.join(root, "reads/raw");
fs.mkdirSync(rawDir, { recursive: true });

const replyJob = (r) => ({ id: r.id, kind: "reply", input: replyPrompt + "\n\nHer reply:\n" + r.text });
const onlyArg = process.argv.indexOf("--only");
const only = onlyArg > 0 ? process.argv[onlyArg + 1].split(",") : null;
const noteArg = process.argv.indexOf("--note");
const allJobs = samplesOnly ? sampleReplies.map(replyJob) : [
  ...docs.map((d) => ({ id: d.id, kind: "document", input: docPrompt + "\n\nDocument:\n" + d.text })),
  ...replies.map(replyJob),
];
const jobs = only ? allJobs.filter((j) => only.includes(j.id)) : allJobs;

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
  if (only) {
    // Add these reads to the saved run without touching the others.
    const merge = (file, add) => {
      const all = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
      Object.assign(all, add);
      fs.writeFileSync(path.join(root, file), JSON.stringify(all, null, 2) + "\n");
    };
    if (Object.keys(outDocs).length) merge("reads/documents.json", outDocs);
    if (Object.keys(outReplies).length) merge(samplesOnly ? "reads/sample-replies.json" : "reads/replies.json", outReplies);
    if (!samplesOnly) {
      const saved = JSON.parse(fs.readFileSync(path.join(root, "reads/run.json"), "utf8"));
      saved.added = (saved.added || []).concat([{ date: run.date, ids: jobs.map((j) => j.id), calls: run.calls, total_cost_usd: run.total_cost_usd,
        model: run.model, note: noteArg > 0 ? process.argv[noteArg + 1] : "" }]);
      fs.writeFileSync(path.join(root, "reads/run.json"), JSON.stringify(saved, null, 2) + "\n");
    }
  } else if (samplesOnly) {
    // Workspace samples are kept apart, so the simulation's recorded run stays exactly as it was.
    fs.writeFileSync(path.join(root, "reads/sample-replies.json"), JSON.stringify(outReplies, null, 2) + "\n");
    fs.writeFileSync(path.join(root, "reads/sample-run.json"), JSON.stringify(run, null, 2) + "\n");
  } else {
    fs.writeFileSync(path.join(root, "reads/documents.json"), JSON.stringify(outDocs, null, 2) + "\n");
    fs.writeFileSync(path.join(root, "reads/replies.json"), JSON.stringify(outReplies, null, 2) + "\n");
    fs.writeFileSync(path.join(root, "reads/run.json"), JSON.stringify(run, null, 2) + "\n");
  }
  console.log(run);
}

if (process.argv.includes("--collect-only")) collect(); else main();
