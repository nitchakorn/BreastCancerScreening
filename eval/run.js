#!/usr/bin/env node
/*
  Runs the evaluation corpus and writes a report.

    node eval/run.js                          reports only: the rules, no model calls
    node eval/run.js --mode claude-code       reports, plus replies and comparisons through your Claude Code sign-in
    node eval/run.js --mode live              the same through the Claude API (ANTHROPIC_API_KEY in .env)
    node eval/run.js --score eval/results/<file>.json   re-score a saved run, no model calls

  Options: --concurrency N (default 4), --out DIR (default eval/results), --only replies|comparisons
  Writes eval/results/<timestamp>.json (raw model answers included, so a run can be re-scored) and eval/REPORT.md.
*/
const fs = require('node:fs');
const path = require('node:path');
const S = require('./score.js');

const root = path.join(__dirname, '..');
const corpus = {
  reports: require('./corpus/reports.json'),
  replies: require('./corpus/replies.json'),
  comparisons: require('./corpus/comparisons.json')
};
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const mode = opt('--mode', process.env.READER_MODE && process.env.READER_MODE !== 'recorded' ? process.env.READER_MODE : null);
const scoreFile = opt('--score', null);
const concurrency = Math.max(1, Number(opt('--concurrency', 4)) || 4);
const outDir = path.resolve(root, opt('--out', 'eval/results'));
const only = opt('--only', null);

// The texts for each comparison pair: a report from the corpus by id, or inline text.
function pairTexts() {
  const byId = Object.fromEntries(corpus.reports.map(r => [r.id, r.text]));
  const out = {};
  for (const c of corpus.comparisons) out[c.id] = { imaging: c.imaging_text || byId[c.imaging], pathology: c.pathology_text || byId[c.pathology] };
  return out;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length); let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; results[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function readWithModel() {
  const env = { ...process.env, READER_MODE: mode };
  const { createReader } = require('../server/reader.js');
  const reader = createReader({ env });
  const status = reader.status();
  process.stderr.write(`Reading with ${status.mode} (${status.model})\n`);
  const raw = { replies: {}, comparisons: {} };
  let model = null, usage = { input: 0, output: 0, calls: 0 };
  const note = r => { if (r.model) model = r.model; if (r.usage) { usage.input += r.usage.input_tokens || 0; usage.output += r.usage.output_tokens || 0; } usage.calls++; };
  if (only !== 'comparisons') {
    let done = 0;
    await mapLimit(corpus.replies, concurrency, async item => {
      try { const r = await reader.readReply(item.text); note(r); raw.replies[item.id] = r.read; }
      catch (e) { raw.replies[item.id] = { error: e.message }; }
      process.stderr.write(`\r  replies ${++done}/${corpus.replies.length}`);
    });
    process.stderr.write('\n');
  }
  if (only !== 'replies') {
    const texts = pairTexts(); let done = 0;
    await mapLimit(corpus.comparisons, concurrency, async item => {
      try {
        const r = await reader.read(texts[item.id].pathology, { imaging: texts[item.id].imaging });
        if (r.comparison && r.comparison.read) { note({ model: r.comparison.model }); raw.comparisons[item.id] = r.comparison.read; }
        else raw.comparisons[item.id] = { error: (r.comparison && r.comparison.error) || 'No comparison came back.' };
      } catch (e) { raw.comparisons[item.id] = { error: e.message }; }
      process.stderr.write(`\r  comparisons ${++done}/${corpus.comparisons.length}`);
    });
    process.stderr.write('\n');
  }
  return { raw, model, usage };
}

function score(run) {
  const results = { ran: run.ran, day: S.EVAL_DAY, mode: run.mode || null, model: run.model || null, usage: run.usage || null };
  results.reports = S.scoreReports(corpus.reports, S.EVAL_DAY);
  if (run.raw && run.raw.replies && Object.keys(run.raw.replies).length) results.replies = S.scoreReplies(corpus.replies, run.raw.replies);
  if (run.raw && run.raw.comparisons && Object.keys(run.raw.comparisons).length) results.comparisons = S.scoreComparisons(corpus.comparisons, pairTexts(), run.raw.comparisons);
  return results;
}

async function main() {
  let run;
  if (scoreFile) {
    const saved = JSON.parse(fs.readFileSync(path.resolve(root, scoreFile), 'utf8'));
    run = { ran: saved.ran, mode: saved.mode, model: saved.model, usage: saved.usage, raw: saved.raw };
  } else {
    run = { ran: new Date().toISOString(), mode: mode || null, raw: null };
    if (mode) Object.assign(run, await readWithModel());
  }
  const results = score(run);
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = results.ran.replace(/[:.]/g, '-');
  const file = path.join(outDir, `${stamp}${run.mode ? '-' + run.mode : '-rules'}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...results, raw: run.raw }, null, 2));
  fs.writeFileSync(path.join(root, 'eval/REPORT.md'), S.renderReport(results));
  const r = results.reports.summary;
  console.log(`Reports: ${r.correct_read}/${r.readable} correct reads, ${r.over_hold} over-holds, ${r.wrong_read} wrong reads, ${r.correct_hold}/${r.should_hold} correct holds, ${r.missed_hold} missed holds.`);
  if (results.replies) { const p = results.replies.summary; console.log(`Replies: ${p.exact_pct}% exact labels, ${p.action_pct}% right action, ${p.quote_ok_pct}% quotes ok, ${p.missed_escalation} missed escalations, ${p.over_escalation} over-escalations.`); }
  if (results.comparisons) { const c = results.comparisons.summary; console.log(`Comparisons: ${c.accuracy_pct}% correct, ${c.mismatch_recall_pct}% mismatch recall, ${c.quotes_ok_pct}% quotes ok, ${c.missed_mismatch} missed mismatches.`); }
  if (run.usage) console.log(`Model calls: ${run.usage.calls}.`);
  console.log(`Saved ${path.relative(root, file)} and eval/REPORT.md`);
  const unsafe = r.unsafe + (results.replies ? results.replies.summary.unsafe : 0) + (results.comparisons ? results.comparisons.summary.unsafe : 0);
  process.exitCode = unsafe ? 1 : 0;
}

main().catch(e => { console.error(e); process.exitCode = 2; });
