#!/usr/bin/env node
/*
  The model step. Rules read the reports (agent/agent.js, readReport), so Claude only gets
  the two jobs that need judgment, one call each, and what it says is saved to reads/:
    - each patient text reply                         -> reads/replies.json
    - each pathology report next to the imaging report
      that led to the biopsy (radiology-pathology
      correlation)                                    -> reads/comparisons.json

  Needs Claude Code installed and signed in (the `claude` command).
  Usage: node scripts/read.js              every reply and every comparison used by the simulation
         node scripts/read.js --samples    extra sample replies for the workspace only
         node scripts/read.js --only P11-r1,P11-path --note "what was added"
                                           reads only those items and adds them to the saved run

  reads/documents.json holds Claude's reads of the reports from the first version, when Claude
  read the reports too. The tests use it to check that the rules read every report the same way.
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
const comparePrompt = read("prompts/compare_reports.txt");
const replyPrompt = read("prompts/read_reply.txt");
const rawDir = path.join(root, "reads/raw");
fs.mkdirSync(rawDir, { recursive: true });

const byId = Object.fromEntries(docs.map((d) => [d.id, d]));
const replyJob = (r) => ({ id: r.id, kind: "reply", input: replyPrompt + "\n\nHer reply:\n" + r.text });
const compareJob = (d) => ({ id: d.id, kind: "compare", imaging: d.imaging,
  input: comparePrompt + "\n\nIMAGING REPORT:\n" + byId[d.imaging].text + "\n\nPATHOLOGY REPORT:\n" + d.text });
const onlyArg = process.argv.indexOf("--only");
const only = onlyArg > 0 ? process.argv[onlyArg + 1].split(",") : null;
const noteArg = process.argv.indexOf("--note");
const allJobs = samplesOnly ? sampleReplies.map(replyJob) : [
  ...replies.map(replyJob),
  ...docs.filter((d) => d.kind === "pathology" && d.imaging).map(compareJob),
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
  const outReplies = {}, outCompare = {};
  let cost = 0;
  const ms = [], models = {};
  for (const job of jobs) {
    const raw = JSON.parse(fs.readFileSync(path.join(rawDir, job.id + ".json"), "utf8"));
    const text = raw.result || "";
    const m = text.match(/\{[\s\S]*\}/);
    let parsed = null;
    try { parsed = m ? JSON.parse(m[0]) : null; } catch (e) { parsed = null; }
    if (!parsed) console.warn("could not parse " + job.id);
    if (job.kind === "compare") outCompare[job.id] = { imaging: job.imaging, comparison: parsed };
    else outReplies[job.id] = parsed;
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
  const merge = (file, add) => {
    const full = path.join(root, file);
    const all = fs.existsSync(full) ? JSON.parse(fs.readFileSync(full, "utf8")) : {};
    Object.assign(all, add);
    fs.writeFileSync(full, JSON.stringify(all, null, 2) + "\n");
  };
  if (samplesOnly) {
    // Workspace samples are kept apart, so the simulation's recorded run stays exactly as it was.
    merge("reads/sample-replies.json", outReplies);
    fs.writeFileSync(path.join(root, "reads/sample-run.json"), JSON.stringify(run, null, 2) + "\n");
  } else {
    if (Object.keys(outReplies).length) merge("reads/replies.json", outReplies);
    if (Object.keys(outCompare).length) merge("reads/comparisons.json", outCompare);
    const saved = JSON.parse(fs.readFileSync(path.join(root, "reads/run.json"), "utf8"));
    saved.added = (saved.added || []).concat([{ date: run.date, ids: jobs.map((j) => j.id), calls: run.calls, total_cost_usd: run.total_cost_usd,
      model: run.model, median_seconds: run.median_seconds, note: noteArg > 0 ? process.argv[noteArg + 1] : "" }]);
    fs.writeFileSync(path.join(root, "reads/run.json"), JSON.stringify(saved, null, 2) + "\n");
  }
  console.log(run);
}

if (process.argv.includes("--collect-only")) collect(); else main();
