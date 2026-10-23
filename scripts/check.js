#!/usr/bin/env node
/*
  Runs the simulation in Node and prints every patient's timeline and the
  60-day summary. Usage: node scripts/check.js [patient id]
*/
const path = require("path");
const A = require("../agent/agent.js");
const root = path.join(__dirname, "..");
const load = (p) => require(path.join(root, p));
const input = {
  patients: load("data/patients.json"),
  documents: load("data/documents.json"),
  replies: load("data/replies.json"),
  reads: { replies: load("reads/replies.json"), comparisons: load("reads/comparisons.json") },
};
const { events, snapshots } = A.simulate(input);
const only = process.argv[2];

for (const p of input.patients) {
  if (only && p.id !== only) continue;
  console.log("\n" + p.id + " " + p.name + " (" + p.path + ")");
  for (const e of events.filter((x) => x.patient === p.id)) {
    console.log("  day " + String(e.day).padStart(2) + " " + A.weekday(e.date) + " " + A.fmtShort(e.date).padEnd(6) + " " + e.actor.padEnd(7) + " " + e.kind.padEnd(9) + " " + e.text.slice(0, 150));
  }
}

const last = snapshots[snapshots.length - 1];
const abnormal = input.patients.filter((p) => ["0", "4-5", "unclear"].includes(last[p.id].cat));
const resolved = abnormal.filter((p) => last[p.id].resolvedDays !== null);
const within = resolved.filter((p) => last[p.id].resolvedDays <= A.RULES.measureWindowDays);
const days = resolved.map((p) => last[p.id].resolvedDays).sort((a, b) => a - b);
const median = days.length ? (days.length % 2 ? days[(days.length - 1) / 2] : (days[days.length / 2 - 1] + days[days.length / 2]) / 2) : null;
console.log("\nEnd of simulation (" + A.fmt(A.dateOf(A.RULES.days)) + ")");
console.log("  statuses:", input.patients.map((p) => p.id + "=" + last[p.id].status).join(" "));
console.log("  abnormal results resolved within 60 days:", within.length, "of", abnormal.length, "| days:", days.join(", "), "| median:", median);
console.log("  needed a person:", input.patients.filter((p) => last[p.id].neededPerson).map((p) => p.id).join(", "));
console.log("  agent texts/portal/calls:", ["text", "portal", "call"].map((k) => events.filter((e) => e.actor === "agent" && e.kind === k).length).join("/"), "| replies read:", events.filter((e) => e.kind === "readreply").length);
