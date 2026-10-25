#!/usr/bin/env node
/*
  The CMO view: one page a chief medical officer would read, built from the 90-day simulation.
  It answers the questions an executive asks about a follow-up program: are we inside the CDC
  60-day window, where does the time go, how much human time did it take, what is open, and
  what did the safety checks catch. Writes docs/cmo.html. Run by scripts/build.js, or on its own:
    node scripts/cmo.js
  With real data, the same page would read from the case store instead of the simulation.
*/
const fs = require("fs");
const path = require("path");
const A = require("../agent/agent.js");
const root = path.join(__dirname, "..");
const load = (p) => require(path.join(root, p));
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const input = {
  patients: load("data/patients.json"), documents: load("data/documents.json"), replies: load("data/replies.json"),
  reads: { replies: load("reads/replies.json"), comparisons: load("reads/comparisons.json") }
};
const { events, snapshots } = A.simulate(input);
const last = snapshots[snapshots.length - 1];
const WINDOW = A.RULES.measureWindowDays;
const periodStart = A.RULES.start, periodEnd = A.dateOf(A.RULES.days);

// The category the case started with, from the rules' read of the first report. A per-breast track takes its own breast's category.
function firstCategory(p, side, index) {
  const doc = input.documents.find((d) => d.id === p.first_doc);
  if (!doc) return null;
  const read = A.readReport(doc.text);
  const own = (read.breasts || []).find((b) => b.side === side);
  if (own) return own.birads;
  return index === 0 ? read.birads : null;
}

/* ---------- tracks: one row per breast that had its own case ---------- */
const tracks = [];
for (const p of input.patients) {
  const snap = last[p.id];
  const list = snap.tracks && snap.tracks.length ? snap.tracks : [snap];
  list.forEach((t, i) => {
    const key = i === 0 ? p.id : p.id + ":" + t.side;
    const ev = events.filter((e) => (e.track || e.patient) === key || (i === 0 && e.patient === p.id && !e.track));
    const day = (kind) => { const e = ev.find((x) => x.kind === kind); return e ? e.day : null; };
    const d0 = day("doc") !== null ? day("doc") : day("split"), db = day("booked"), da = day("appt"), dc = day("close");
    tracks.push({
      key, patient: p.id, name: p.name, age: p.age, side: t.side, cat: t.cat, birads: t.birads, status: t.status, step: t.step, due: t.due,
      overdueDays: t.overdueDays, person: t.person, outcome: t.outcome, resolvedDays: t.resolvedDays, neededPerson: t.neededPerson,
      inMeasure: ["0", "4-5", "unclear"].includes(t.cat), surveillance: t.cat === "3",
      firstBirads: firstCategory(p, t.side, i),
      phases: d0 !== null && dc !== null ? {
        book: db !== null ? db - d0 : dc - d0, wait: db !== null && da !== null ? da - db : 0, result: da !== null ? dc - da : 0
      } : null,
      startDate: d0 !== null ? A.dateOf(d0) : null
    });
  });
}

/* ---------- the numbers ---------- */
const measure = tracks.filter((t) => t.inMeasure);
const resolved = measure.filter((t) => t.resolvedDays !== null);
const within = resolved.filter((t) => t.resolvedDays <= WINDOW);
const days = resolved.map((t) => t.resolvedDays).sort((a, b) => a - b);
const median = days.length ? (days.length % 2 ? days[(days.length - 1) / 2] : (days[days.length / 2 - 1] + days[days.length / 2]) / 2) : null;
const stillOpenInMeasure = measure.filter((t) => t.resolvedDays === null);
const surveillance = tracks.filter((t) => t.surveillance);
const routine = tracks.filter((t) => t.cat === "1-2");
const open = tracks.filter((t) => t.status !== "done");
const cancers = tracks.filter((t) => /cancer/i.test(t.outcome || "") || t.status === "done" && events.some((e) => (e.track || e.patient) === t.key && e.kind === "handoff" && e.handoffKind === "surgery"));

const handoffs = events.filter((e) => e.kind === "handoff");
const byRole = {};
for (const h of handoffs) (byRole[h.who] = byRole[h.who] || []).push(h);
const navigatorReasons = {};
for (const h of handoffs.filter((h) => h.who === "Nurse navigator")) { const r = h.short.replace(/, sent to (the )?navigator$/, ""); navigatorReasons[r] = (navigatorReasons[r] || 0) + 1; }
// Women who needed a person for an exception or an unclear report. The radiologist's concordance look at every benign
// biopsy is a designed step, counted in the handoffs but not here.
const womenNeedingPerson = input.patients.filter((p) => last[p.id].neededPerson).length;
const concordanceLooks = handoffs.filter((h) => h.handoffKind === "concordance").length;

const agentWork = {
  text: events.filter((e) => e.actor === "agent" && e.kind === "text").length,
  portal: events.filter((e) => e.actor === "agent" && e.kind === "portal").length,
  call: events.filter((e) => e.actor === "agent" && e.kind === "call").length,
  replies: events.filter((e) => e.kind === "readreply").length,
  compares: events.filter((e) => e.kind === "compare").length,
  reports: events.filter((e) => e.kind === "read").length
};

// Safety catches: a possible mismatch the radiologist confirmed, and a report the rules held that a radiologist corrected.
const mismatchConfirmed = events.filter((e) => e.kind === "person" && /not concordant|mismatch/i.test(e.text) && !/concordant\.$/i.test(e.text));
const holdsCorrected = events.filter((e) => e.kind === "person" && /entered in error|addendum/i.test(e.text));
const catches = [
  ...mismatchConfirmed.map((e) => ({ day: e.day, patient: e.patient, what: "Benign biopsy did not explain the imaging. Repeat biopsy found cancer.", by: "Claude flagged, radiologist confirmed" })),
  ...holdsCorrected.map((e) => ({ day: e.day, patient: e.patient, what: "Negative impression over findings that described a mass. Corrected to a recall.", by: "Rules held, radiologist corrected" }))
];

/* ---------- charts, inline SVG ---------- */
const nameOf = (t) => t.name + (tracks.filter((x) => x.patient === t.patient).length > 1 ? " (" + t.side + ")" : "");
function daysChart(rows) {
  const W = 640, left = 150, right = 40, rowH = 26, top = 22, bottom = 28, max = 70;
  const H = top + rows.length * rowH + bottom, x = (d) => left + (d / max) * (W - left - right);
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Days from abnormal result to resolution, one bar per case, with the 60-day line">`;
  for (const tick of [0, 15, 30, 45, 60]) s += `<line x1="${x(tick)}" x2="${x(tick)}" y1="${top}" y2="${H - bottom + 4}" class="grid"/><text x="${x(tick)}" y="${H - 8}" class="tick" text-anchor="middle">${tick}</text>`;
  s += `<line x1="${x(WINDOW)}" x2="${x(WINDOW)}" y1="${top - 4}" y2="${H - bottom + 4}" class="limit"/><text x="${x(WINDOW) - 4}" y="${12}" class="limit-label" text-anchor="end">60-day window</text>`;
  if (median !== null) s += `<line x1="${x(median)}" x2="${x(median)}" y1="${top - 4}" y2="${H - bottom + 4}" class="median"/><text x="${x(median) + 4}" y="${12}" class="median-label">median ${median} days</text>`;
  rows.forEach((t, i) => {
    const y = top + i * rowH;
    s += `<text x="${left - 8}" y="${y + 17}" class="label" text-anchor="end">${esc(nameOf(t))}</text>`;
    s += `<rect x="${x(0)}" y="${y + 5}" width="${Math.max(2, x(t.resolvedDays) - x(0))}" height="16" rx="2" class="${t.neededPerson ? "bar person" : "bar"}"/>`;
    s += `<text x="${x(t.resolvedDays) + 6}" y="${y + 17}" class="value">${t.resolvedDays}d</text>`;
  });
  return s + "</svg>";
}
function phaseChart(rows) {
  const W = 640, left = 150, right = 40, rowH = 26, top = 8, bottom = 8, max = Math.max(20, ...rows.map((t) => t.resolvedDays));
  const H = top + rows.length * rowH + bottom, x = (d) => left + (d / max) * (W - left - right);
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Where the days went for each case: reaching her and booking, waiting for the appointment, waiting for the result and review">`;
  rows.forEach((t, i) => {
    const y = top + i * rowH, p = t.phases; let cur = 0;
    s += `<text x="${left - 8}" y="${y + 17}" class="label" text-anchor="end">${esc(nameOf(t))}</text>`;
    for (const [k, cls] of [["book", "ph-book"], ["wait", "ph-wait"], ["result", "ph-result"]]) {
      if (p[k] > 0) s += `<rect x="${x(cur)}" y="${y + 5}" width="${x(cur + p[k]) - x(cur)}" height="16" class="${cls}"/>`;
      cur += p[k];
    }
    s += `<text x="${x(cur) + 6}" y="${y + 17}" class="value">${t.resolvedDays}d</text>`;
  });
  return s + "</svg>";
}
const phaseTotals = resolved.reduce((a, t) => { a.book += t.phases.book; a.wait += t.phases.wait; a.result += t.phases.result; return a; }, { book: 0, wait: 0, result: 0 });
const phaseShare = (k) => Math.round((phaseTotals[k] / (phaseTotals.book + phaseTotals.wait + phaseTotals.result)) * 100);

/* ---------- the page ---------- */
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
const indicator = pct(within.length, measure.length);
const onTarget = measure.length > 0 && indicator >= 75;
const statusWord = (t) => t.status === "done" ? "Resolved" : t.status === "overdue" ? "Overdue" : t.person ? "With " + t.person.toLowerCase() : t.status === "agent" ? "Agent watching" : t.status;
const statusClass = (t) => t.status === "done" ? "ok" : t.status === "overdue" ? "bad" : "open";

const rowsHtml = tracks.filter((t) => t.cat !== "1-2").sort((a, b) => (a.startDate || "").localeCompare(b.startDate || "")).map((t) => `
      <tr>
        <td>${esc(nameOf(t))}<span class="sub">${t.age}</span></td>
        <td class="mono">${esc(t.firstBirads || t.birads || "")}</td>
        <td>${esc(t.startDate ? A.fmtShort(t.startDate) : "")}</td>
        <td class="num">${t.resolvedDays !== null ? t.resolvedDays : t.status === "overdue" ? `<span class="bad">${t.overdueDays} past due</span>` : t.status === "done" ? "—" : "open"}</td>
        <td>${t.neededPerson ? "Yes" : "No"}</td>
        <td><span class="pill ${statusClass(t)}">${esc(statusWord(t))}</span> <span class="sub">${esc(t.outcome || (t.step ? t.step + (t.due ? ", due " + A.fmtShort(t.due) : "") : ""))}</span></td>
      </tr>`).join("");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Follow-up Scorecard · Breast screening follow-up</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans+Condensed:wght@500;600;700&family=Public+Sans:wght@400;500;600;700&display=swap">
<style>
/* Layout: one 1080px column. The CDC indicator first, then where the time went, human time, what is open, what was caught, then every case. Same tokens as index.html. */
:root {
  --bg: #f5f4f6; --surface: #ffffff; --sunken: #f0eef2; --ink: #1d1a22; --muted: #645d6b; --line: #e0dce4; --line-strong: #c3bcc9;
  --accent: #a8285a; --accent-soft: #f8e7ee; --on-accent: #ffffff;
  --done: #2b7549; --done-soft: #e3f2e8; --booked: #2459b8; --booked-soft: #e5edfa; --agent: #6b46c1; --agent-soft: #efe9fb;
  --person: #9c5600; --person-soft: #fbeedb; --overdue: #b42318; --overdue-soft: #fbe9e7; --wait: #77707e; --wait-soft: #efedf1;
  --font-display: "IBM Plex Sans Condensed", "Arial Narrow", "Roboto Condensed", system-ui, sans-serif;
  --font-body: "Public Sans", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --radius: 6px;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #121015; --surface: #1b181f; --sunken: #16131a; --ink: #ece8f0; --muted: #a59dad; --line: #2c2732; --line-strong: #453e4d;
    --accent: #f07aa6; --accent-soft: #3a1a28; --on-accent: #121015;
    --done: #6fcf97; --done-soft: #15301f; --booked: #7fa7f0; --booked-soft: #15223a; --agent: #b79cf0; --agent-soft: #241a3a;
    --person: #f0b35a; --person-soft: #3a2a10; --overdue: #f28b82; --overdue-soft: #3a1512; --wait: #a59dad; --wait-soft: #221f27;
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --bg: #121015; --surface: #1b181f; --sunken: #16131a; --ink: #ece8f0; --muted: #a59dad; --line: #2c2732; --line-strong: #453e4d;
  --accent: #f07aa6; --accent-soft: #3a1a28; --on-accent: #121015;
  --done: #6fcf97; --done-soft: #15301f; --booked: #7fa7f0; --booked-soft: #15223a; --agent: #b79cf0; --agent-soft: #241a3a;
  --person: #f0b35a; --person-soft: #3a2a10; --overdue: #f28b82; --overdue-soft: #3a1512; --wait: #a59dad; --wait-soft: #221f27;
  color-scheme: dark;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font-family: var(--font-body); font-size: 15px; line-height: 1.5;
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); padding-block: 24px 56px; }
.wrap { max-width: 1080px; margin: 0 auto; display: grid; gap: 22px; }
h1, h2, h3 { font-family: var(--font-display); margin: 0; line-height: 1.15; text-wrap: balance; }
h1 { font-size: clamp(28px, 4vw, 40px); font-weight: 700; }
h2 { font-size: 20px; font-weight: 600; }
.eyebrow { font-family: var(--font-mono); font-size: 12px; letter-spacing: 0.07em; text-transform: uppercase; color: var(--muted); }
.mono { font-family: var(--font-mono); }
.num { font-variant-numeric: tabular-nums; }
header p { margin: 6px 0 0; color: var(--muted); max-width: 72ch; }
header nav { margin-top: 10px; font-size: 14px; }
header nav a { color: var(--accent); }
.tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
@media (max-width: 820px) { .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.tile { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px; min-width: 0; }
.tile .big { font-family: var(--font-display); font-size: 36px; font-weight: 700; line-height: 1; margin: 6px 0 4px; font-variant-numeric: tabular-nums; }
.tile .big small { font-size: 16px; font-weight: 500; color: var(--muted); margin-left: 4px; }
.tile .note { font-size: 13px; color: var(--muted); }
.tile.hero { border-left: 4px solid var(--${onTarget ? "done" : "overdue"}); }
.tile.hero .big { color: var(--${onTarget ? "done" : "overdue"}); }
.panel { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 18px 20px; min-width: 0; }
.panel h2 { margin-bottom: 4px; }
.panel .lead { margin: 0 0 12px; color: var(--muted); font-size: 14px; max-width: 78ch; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 22px; }
@media (max-width: 820px) { .two { grid-template-columns: 1fr; } }
.chartwrap { overflow-x: auto; }
.chart { width: 100%; min-width: 520px; height: auto; display: block; font-family: var(--font-body); }
.chart .grid { stroke: var(--line); stroke-width: 1; }
.chart .tick { font-size: 11px; fill: var(--muted); }
.chart .label { font-size: 12.5px; fill: var(--ink); }
.chart .value { font-size: 12px; fill: var(--muted); font-variant-numeric: tabular-nums; }
.chart .bar { fill: var(--agent); } .chart .bar.person { fill: var(--person); }
.chart .limit { stroke: var(--overdue); stroke-width: 1.5; stroke-dasharray: 4 3; } .chart .limit-label { font-size: 11px; fill: var(--overdue); }
.chart .median { stroke: var(--ink); stroke-width: 1; stroke-dasharray: 2 3; } .chart .median-label { font-size: 11px; fill: var(--ink); }
.chart .ph-book { fill: var(--accent); } .chart .ph-wait { fill: var(--wait); } .chart .ph-result { fill: var(--booked); }
.legend { display: flex; flex-wrap: wrap; gap: 14px; font-size: 13px; color: var(--muted); margin-top: 6px; }
.legend span::before { content: ""; display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; background: var(--sw); }
.roles { display: grid; gap: 10px; }
.role { display: grid; grid-template-columns: 170px 1fr; gap: 12px; align-items: baseline; }
@media (max-width: 480px) { .role { grid-template-columns: 1fr; gap: 2px; } }
.role b { font-family: var(--font-display); font-size: 18px; }
.role ul { margin: 0; padding-left: 18px; color: var(--muted); font-size: 14px; }
.catch { display: grid; grid-template-columns: 56px 1fr; gap: 12px; padding: 10px 0; border-top: 1px solid var(--line); }
.catch:first-of-type { border-top: 0; padding-top: 0; }
.catch .day { font-family: var(--font-mono); font-size: 13px; color: var(--muted); }
.catch .by { font-size: 13px; color: var(--muted); }
.tablewrap { overflow-x: auto; }
table { width: 100%; min-width: 680px; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; vertical-align: top; padding: 9px 10px; border-top: 1px solid var(--line); }
th { font-family: var(--font-mono); font-size: 11.5px; letter-spacing: 0.05em; text-transform: uppercase; color: var(--muted); border-top: 0; font-weight: 500; }
td .sub { display: block; font-size: 12.5px; color: var(--muted); }
td.num { text-align: right; }
.pill { display: inline-block; font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 999px; }
.pill.ok { background: var(--done-soft); color: var(--done); } .pill.bad { background: var(--overdue-soft); color: var(--overdue); } .pill.open { background: var(--agent-soft); color: var(--agent); }
.bad { color: var(--overdue); font-weight: 600; }
footer { color: var(--muted); font-size: 13.5px; max-width: 80ch; }
footer a { color: var(--accent); }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <p class="eyebrow">Riverside Breast Center · ${esc(A.fmtShort(periodStart))} to ${esc(A.fmt(periodEnd))} · synthetic data</p>
    <h1>Follow-up scorecard</h1>
    <p>What a chief medical officer would see from the follow-up agent: whether abnormal results reached a diagnosis inside the CDC 60-day window, where the days went, how much human time it took, what is still open, and what the safety checks caught. The eleven women are made up. With real data this page reads from the case store.</p>
    <nav><a href="./">Simulation and workflow</a> · <a href="workspace.html">Try the agent</a> · <a href="https://github.com/nitchakorn/BreastCancerScreening">Code</a></nav>
  </header>

  <section class="tiles" aria-label="Headline numbers">
    <div class="tile hero">
      <div class="eyebrow">CDC indicator · abnormal to diagnosis ≤ 60 days</div>
      <div class="big">${indicator}%<small>${within.length} of ${measure.length}</small></div>
      <div class="note">Target ≥ 75%. ${stillOpenInMeasure.length ? stillOpenInMeasure.length + " still open." : "Nothing in the measure is still open."}</div>
    </div>
    <div class="tile">
      <div class="eyebrow">Median days to resolution</div>
      <div class="big">${median !== null ? median : "—"}<small>range ${days[0]} to ${days[days.length - 1]}</small></div>
      <div class="note">From the abnormal report to a benign result, a stable follow-up or a surgery handoff.</div>
    </div>
    <div class="tile">
      <div class="eyebrow">Needed a person</div>
      <div class="big">${womenNeedingPerson}<small>of ${input.patients.length} women</small></div>
      <div class="note">For an exception or an unclear report. Every benign biopsy also got a radiologist's concordance look (${concordanceLooks}).</div>
    </div>
    <div class="tile">
      <div class="eyebrow">Cancers to surgery</div>
      <div class="big">${cancers.length}<small>${catches.filter((c) => /cancer/i.test(c.what)).length === 1 ? "one" : catches.filter((c) => /cancer/i.test(c.what)).length} caught by a flag</small></div>
      <div class="note">One would have closed as benign without the radiology-pathology check.</div>
    </div>
  </section>

  <div class="two">
    <section class="panel">
      <h2>Days to resolution, each abnormal result</h2>
      <p class="lead">Orange bars are cases where a person stepped in. Every bar is inside the 60-day window.</p>
      <div class="chartwrap">${daysChart(resolved.slice().sort((a, b) => a.resolvedDays - b.resolvedDays))}</div>
      <div class="legend"><span style="--sw: var(--agent)">Agent handled it</span><span style="--sw: var(--person)">A person stepped in</span></div>
    </section>
    <section class="panel">
      <h2>Where the days went</h2>
      <p class="lead">Reaching her and getting a booking took ${phaseShare("book")}% of the days. Waiting for the appointment slot took ${phaseShare("wait")}%. Waiting for the result, the review and any repeat took ${phaseShare("result")}%.</p>
      <div class="chartwrap">${phaseChart(resolved.slice().sort((a, b) => a.resolvedDays - b.resolvedDays))}</div>
      <div class="legend"><span style="--sw: var(--accent)">Reaching her, booking</span><span style="--sw: var(--wait)">Waiting for the appointment</span><span style="--sw: var(--booked)">Result, review, any repeat</span></div>
    </section>
  </div>

  <div class="two">
    <section class="panel">
      <h2>Human time</h2>
      <p class="lead">The agent sent ${agentWork.text} texts, ${agentWork.portal} portal messages and ${agentWork.call} automated calls, read ${agentWork.replies} replies and compared ${agentWork.compares} biopsy results with their imaging. People were asked in only when a rule said so.</p>
      <div class="roles">
        ${Object.entries(byRole).map(([who, list]) => `<div class="role"><div><b>${list.length}</b> ${esc(who.toLowerCase())}</div><ul>${
          who === "Nurse navigator" ? Object.entries(navigatorReasons).map(([r, n]) => `<li>${esc(r)}${n > 1 ? " (" + n + ")" : ""}</li>`).join("")
          : [...new Set(list.map((h) => h.short))].map((s) => `<li>${esc(s)}${list.filter((h) => h.short === s).length > 1 ? " (" + list.filter((h) => h.short === s).length + ")" : ""}</li>`).join("")
        }</ul></div>`).join("")}
      </div>
    </section>
    <section class="panel">
      <h2>What the safety checks caught</h2>
      <p class="lead">Two checks never go to the agent alone: a report the rules cannot read goes to a radiologist, and every biopsy result is compared with its imaging before the case closes.</p>
      ${catches.sort((a, b) => a.day - b.day).map((c) => `<div class="catch"><div class="day">Day ${c.day}</div><div>${esc(tracks.find((t) => t.patient === c.patient).name)}: ${esc(c.what)}<div class="by">${esc(c.by)}</div></div></div>`).join("") || "<p>Nothing was caught in this period.</p>"}
    </section>
  </div>

  <section class="panel">
    <h2>Open right now</h2>
    <p class="lead">${open.length ? open.length + " of " + tracks.length + " tracks are open at the end of the period." : "Every track is closed."}</p>
    <ul>
      ${open.map((t) => `<li><b>${esc(nameOf(t))}</b>, BI-RADS ${esc(t.birads)}: ${esc(t.step || "")}${t.due ? ", due " + esc(A.fmt(t.due)) : ""}. ${t.status === "overdue" ? `<span class="bad">${t.overdueDays} days past due.</span> ` : ""}${t.person ? "With the " + esc(t.person.toLowerCase()) + "." : "The agent is watching."}</li>`).join("")}
    </ul>
    <p class="lead" style="margin-top:10px">BI-RADS 3 surveillance (${surveillance.length} tracks) is outside the 60-day measure. ${surveillance.filter((t) => t.status === "overdue").length} of them is past its six-month due date and with a navigator.</p>
  </section>

  <section class="panel">
    <h2>Every case</h2>
    <p class="lead">${tracks.length} tracks for ${input.patients.length} women. One woman had findings in both breasts, so each breast is its own row. ${routine.length} routine result${routine.length === 1 ? "" : "s"} (BI-RADS 1 or 2) ${routine.length === 1 ? "is" : "are"} left out.</p>
    <div class="tablewrap">
    <table>
      <thead><tr><th>Woman</th><th>First read</th><th>Report</th><th class="num">Days</th><th>Person</th><th>Status</th></tr></thead>
      <tbody>${rowsHtml}
      </tbody>
    </table>
    </div>
  </section>

  <footer>
    <p>The 60-day indicator is the CDC National Breast and Cervical Cancer Early Detection Program's clinical performance standard: abnormal screening result to final diagnosis within 60 days, at least 75% of the time. Deadlines in the agent are placeholders for clinical review. This page is generated by <span class="mono">scripts/cmo.js</span> from the same simulation as the main page, so the numbers here and there always agree.</p>
  </footer>
</div>
</body>
</html>
`;

if (/\{\{|undefined|NaN/.test(html.replace(/[^\x00-\x7F]/g, ""))) throw new Error("the CMO page has an unfilled value");
fs.mkdirSync(path.join(root, "docs"), { recursive: true });
fs.writeFileSync(path.join(root, "docs/cmo.html"), html);
console.log("wrote docs/cmo.html (" + html.length + " bytes)");
module.exports = { tracks, measure, within, median, handoffs, catches, agentWork };
