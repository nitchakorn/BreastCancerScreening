/*
  Breast screening follow-up agent: the rules and a day-by-day simulation.

  Everything in this file is plain code. Rules read each report (readReport): the
  BI-RADS category, the exam date, which breast and the recommendation. Rules pick
  the pathway, set the due date, decide each outreach step, and hand a case to a
  person only when a rule says so.

  Claude does the two jobs that need judgment (scripts/read.js saves those reads
  in reads/): it reads her text replies, and when a biopsy result comes back it
  compares the pathology report with the imaging report and flags anything that
  may not match. Code checks every quote Claude gives. A radiologist decides.

  The simulated world (when a patient replies, books, or what a navigator does)
  comes from data/patients.json. The agent never sees that script. It only sees
  what arrives: reports, replies, bookings and notes from people.

  The same engine (createEngine) also runs the local workspace in server/, where
  the reports, replies, bookings and people are real clicks instead of a script.

  Works in Node (require) and in the browser (window.BreastAgent).
*/
(function (root) {
  "use strict";

  // The deadlines and outreach timings below are placeholders for clinical review.
  // A health system's clinicians would set the real ones.
  var RULES = {
    start: "2026-09-01",
    days: 90,
    link: "riverside.example/book",
    rideLink: "riverside.example/ride",
    phone: "555-0142",
    // BI-RADS 0, 4 and 5: outreach starts as soon as the report is read.
    urgent: {
      attempts: [{ after: 0, channel: "text" }, { after: 2, channel: "portal" }, { after: 4, channel: "call" }],
      noAnswerHandoffAfter: 5,
      nudgeEvery: 3
    },
    diagnostic: { step: "Diagnostic mammogram or ultrasound", dueDays: 14, personIfNotBookedByDay: 30 },
    biopsy: { step: "Biopsy", dueDays: 14, personIfNotBookedByDay: 7, headsUpCategory: "5" },
    // BI-RADS 3: there is time, so reminders keep going until one month after the due date.
    shortInterval: {
      step: "6-month follow-up imaging", dueMonths: 6, outreachMonthsBefore: 1, personMonthsAfterDue: 1, nudgeEvery: 7,
      attempts: [
        { fromStart: 0, channel: "text" }, { fromStart: 7, channel: "portal" }, { fromStart: 14, channel: "call" },
        { fromDue: -7, channel: "text" }, { fromDue: 0, channel: "text" }, { fromDue: 14, channel: "portal" }
      ]
    },
    pathology: { step: "Pathology result", dueDaysAfterBiopsy: 10 },
    // Workspace only: in the simulation the imaging report arrives the day of the appointment.
    imagingReport: { step: "Imaging report", dueDaysAfterAppointment: 3 },
    measureWindowDays: 60
  };

  // Reply labels that send the case to a person right away.
  var EXCEPTIONS = {
    scared_or_worried: "She said she is scared or worried",
    medical_question: "She asked a medical question",
    declines_care: "She turned down care",
    other_barrier: "She raised a barrier the agent can't solve",
    wrong_number: "The text reached the wrong person"
  };

  /* ---------- dates ---------- */
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  function addDays(iso, n) { var d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function addMonths(iso, n) {
    var p = iso.split("-").map(Number), y = p[0], m = p[1] - 1 + n;
    y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
    var last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return new Date(Date.UTC(y, m, Math.min(p[2], last), 12)).toISOString().slice(0, 10);
  }
  function dayOf(iso) { return Math.round((Date.parse(iso + "T12:00:00Z") - Date.parse(RULES.start + "T12:00:00Z")) / 864e5); }
  function dateOf(day) { return addDays(RULES.start, day); }
  function fmt(iso) { if (!iso) return ""; var p = iso.split("-"); return MONTHS[Number(p[1]) - 1] + " " + Number(p[2]) + ", " + p[0]; }
  function fmtShort(iso) { if (!iso) return ""; var p = iso.split("-"); return MONTHS[Number(p[1]) - 1] + " " + Number(p[2]); }
  function weekday(iso) { return WEEKDAYS[new Date(iso + "T12:00:00Z").getUTCDay()]; }

  /* ---------- reading checks (step 3) ---------- */
  function normBirads(b) {
    if (b === null || b === undefined) return null;
    var m = String(b).trim().toUpperCase().match(/^([0-6])[ABC]?$/);
    return m ? m[1] : null;
  }
  function pathwayFor(b) {
    if (b === "1" || b === "2") return "routine";
    if (b === "0") return "diagnostic";
    if (b === "3") return "shortInterval";
    if (b === "4" || b === "5") return "biopsy";
    return null;
  }
  function catOf(b) { return b === "1" || b === "2" ? "1-2" : b === "0" ? "0" : b === "3" ? "3" : b === "4" || b === "5" ? "4-5" : "unclear"; }

  /* ---------- reading a report by rule (step 2) ---------- */
  /*
    Reports follow a fixed layout: EXAM, DATE, FINDINGS, IMPRESSION, RECOMMENDATION, or for
    pathology SPECIMEN, PROCEDURE DATE, DIAGNOSIS. These rules read that layout the same way
    every time and never guess. When a report doesn't fit them, the read says why in "unclear"
    and the case goes to a radiologist. Every value comes with the exact words it was read from.
  */
  var LABEL = /^([A-Z][A-Z ]*[A-Z]):\s*(.*)$/;
  var GROWS = ["FINDINGS", "IMPRESSION", "CORRECTED IMPRESSION", "RECOMMENDATION", "DIAGNOSIS", "COMMENT", "INDICATION", "HISTORY"];
  var CATEGORY = /BI-RADS\s*(?:category\s*)?:?\s*([0-6][ABC]?)\b/gi;
  var FINDING = /\b(mass(?:es)?|asymmetr(?:y|ies)|calcifications?|distortion|lesions?|nodules?)\b/gi;
  var NEGATED = /\b(no|not|without|negative for)\b/i;

  // The report's labeled sections. A line without a label belongs to the section above it.
  function sectionsOf(text) {
    var out = {}, last = null;
    String(text || "").replace(/\r\n?/g, "\n").split("\n").forEach(function (raw, i) {
      var line = raw.trim(), m = line.match(LABEL);
      if (!line) return;
      if (i === 0 && /^ADDENDUM\b/.test(line)) { last = "ADDENDUM"; out.ADDENDUM = { line: line, value: line, lines: [] }; return; }
      if (!m && /^[A-Z][A-Z ]+$/.test(line)) { last = "HEADER"; out.HEADER = { line: line, value: line, lines: [] }; return; }
      if (m && !out[m[1]]) { last = m[1]; out[last] = { line: line, value: m[2], lines: m[2] ? [m[2]] : [] }; return; }
      if (last && GROWS.indexOf(last) >= 0) { out[last].lines.push(line); return; }
      (out.NOTE = out.NOTE || { line: line, value: "", lines: [] }).lines.push(line);
    });
    return out;
  }
  // Sentences, split at a period followed by a space, so "1.3 cm" stays whole.
  function sentencesOf(s) { return (String(s || "").match(/(?:[^.]|\.(?=\S))+\.?/g) || []).map(function (x) { return x.trim(); }).filter(Boolean); }
  function sideIn(s) {
    var right = /\bright\b/i.test(s || ""), left = /\bleft\b/i.test(s || "");
    return right !== left ? (right ? "right" : "left") : null;
  }
  function isoFrom(s) {
    var m = String(s || "").match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);
    if (!m) return null;
    var iso = m[3] + "-" + m[1] + "-" + m[2], d = new Date(iso + "T12:00:00Z");
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
  }
  function categoriesIn(s) {
    var out = [], m, re = new RegExp(CATEGORY.source, "gi");
    while ((m = re.exec(s))) out.push(m[1].toUpperCase());
    return out;
  }
  function urgencyOf(b) { var p = pathwayFor(normBirads(b)); return p in URGENCY ? URGENCY[p] : -1; }
  function noPeriod(s) { return s ? s.replace(/\.$/, "") : s; }

  function readReport(text) {
    var sec = sectionsOf(text), unclear = [];
    var r = { doc_type: null, exam_date: null, side: null, birads: null, next_step: null, findings_match_impression: null, mismatch_quote: null,
      pathology_result: null, diagnosis: null, breasts: [], quotes: { exam_date: null, birads: null, next_step: null, pathology_result: null }, unclear: unclear, reader: "rules" };
    var exam = sec.EXAM ? sec.EXAM.value : "";
    r.doc_type = (sec.HEADER && /PATHOLOGY/.test(sec.HEADER.line)) || (sec.DIAGNOSIS && sec.SPECIMEN) ? "pathology"
      : sec.ADDENDUM || sec["CORRECTED IMPRESSION"] ? "addendum"
      : /screening/i.test(exam) ? "screening" : /diagnostic/i.test(exam) ? "diagnostic" : /ultrasound/i.test(exam) ? "ultrasound" : null;
    if (!r.doc_type) { unclear.push("The rules don't recognize this kind of report."); return r; }

    // The exam date. An addendum counts from the exam it corrects.
    var dateLine = r.doc_type === "pathology" ? sec["PROCEDURE DATE"] : r.doc_type === "addendum" ? (isoFrom(sec.ADDENDUM && sec.ADDENDUM.line) ? sec.ADDENDUM : sec["DATE OF ADDENDUM"]) : sec.DATE;
    r.exam_date = dateLine ? isoFrom(dateLine.line) : null;
    if (r.exam_date) r.quotes.exam_date = dateLine.line; else unclear.push("No valid exam date.");

    if (r.doc_type === "pathology") {
      r.side = sec.SPECIMEN ? sideIn(sec.SPECIMEN.value) : null;
      var dx = sec.DIAGNOSIS;
      if (!dx || !dx.value) { unclear.push("No diagnosis."); return r; }
      // Phrases that rule something out ("Negative for atypia and malignancy") don't count as findings.
      var kept = dx.lines.join(" ").replace(/\b(negative for|no evidence of|without|no)\b[^.;]*/gi, " ");
      var highRisk = /lobular carcinoma in situ|\bLCIS\b|atypi/i.test(kept);
      kept = kept.replace(/lobular carcinoma in situ/gi, " ");
      r.pathology_result = /carcinoma|malignan|sarcoma|lymphoma|\bDCIS\b/i.test(kept) ? "malignant" : highRisk ? "atypia"
        : /non-?diagnostic|insufficient|inadequate/i.test(kept) ? "nondiagnostic"
        : /benign|fibroadenoma|fibrocystic|fat necrosis|stromal fibrosis|\bcysts?\b/i.test(kept) ? "benign" : null;
      if (!r.pathology_result) unclear.push("The diagnosis isn't one the rules know.");
      r.quotes.pathology_result = dx.value;
      r.diagnosis = sentencesOf(dx.lines.join(" ")).map(function (s, i) { s = noPeriod(s); return i ? s.charAt(0).toLowerCase() + s.slice(1) : s; }).join(", ");
      return r;
    }

    // The BI-RADS category, from the impression. Numbered impression lines can assess each breast on its own.
    var imp = sec["CORRECTED IMPRESSION"] || sec.IMPRESSION, overall = sec["OVERALL ASSESSMENT"];
    var items = imp ? (imp.lines.length > 1 ? imp.lines : [imp.lines.join(" ")]).map(function (l) { return l.replace(/^\d+\.\s*/, ""); }) : [];
    var found = [];
    items.forEach(function (item) {
      categoriesIn(item).forEach(function (cat) {
        var said = sentencesOf(item).filter(function (s) { return categoriesIn(s).length; })[0];
        found.push({ cat: cat, side: sideIn(item), item: item, sentence: said });
      });
    });
    var overallCat = overall ? categoriesIn(overall.value)[0] || null : null;
    var cats = found.map(function (f) { return f.cat; }).filter(function (c, i, a) { return a.indexOf(c) === i; });
    var rec = sec.RECOMMENDATION ? sentencesOf(sec.RECOMMENDATION.value) : [];
    if (!found.length && !overallCat) unclear.push("No BI-RADS category in the impression.");
    else if (cats.length > 1 || (found.length > 1 && found.every(function (f) { return f.side; }) && found[0].side !== found[1].side)) {
      // More than one category: fine only when each one names its own breast.
      if (!found.every(function (f) { return f.side; })) unclear.push("The impression gives more than one BI-RADS category without saying which breast each is for.");
      else {
        var bySide = {};
        found.forEach(function (f) {
          if (bySide[f.side] && bySide[f.side].birads !== f.cat) unclear.push("The " + f.side + " breast has two different BI-RADS categories.");
          var step = rec.filter(function (s) { return sideIn(s) === f.side; })[0] || null;
          bySide[f.side] = bySide[f.side] || { side: f.side, birads: f.cat, next_step: noPeriod(step), quotes: { birads: f.item, next_step: step } };
        });
        r.breasts = ["right", "left"].filter(function (s) { return bySide[s]; }).map(function (s) { return bySide[s]; });
        var worst = r.breasts.slice().sort(function (a, b) { return urgencyOf(a.birads) - urgencyOf(b.birads); })[0];
        if (overallCat && urgencyOf(overallCat) > urgencyOf(worst.birads)) unclear.push("The overall assessment is less urgent than the " + worst.side + " breast's category.");
        r.birads = overallCat || worst.birads;
        r.quotes.birads = overallCat ? overall.line : worst.quotes.birads;
        if (r.breasts.length < 2) r.breasts = [];
      }
    } else {
      r.birads = cats[0] || overallCat;
      if (overallCat && cats[0] && overallCat !== cats[0]) unclear.push("The overall assessment and the impression give different categories.");
      r.quotes.birads = found.length ? found[0].sentence : overall.line;
    }

    // Which breast: the exam names it, or for an addendum, the recommendation does.
    r.side = /bilateral/i.test(exam) ? "both" : sideIn(exam) || sideIn(rec[0]) || (imp ? sideIn(imp.lines.join(" ")) : null);
    r.next_step = noPeriod(rec[0]) || null;
    r.quotes.next_step = rec[0] || null;

    // A negative report (BI-RADS 1) whose findings describe something that isn't ruled out doesn't add up.
    r.findings_match_impression = true;
    if (normBirads(r.birads) === "1" && sec.FINDINGS) {
      sentencesOf(sec.FINDINGS.lines.join(" ")).forEach(function (s) {
        var m, re = new RegExp(FINDING.source, "gi");
        while ((m = re.exec(s))) {
          if (!NEGATED.test(s.slice(0, m.index)) && r.findings_match_impression) { r.findings_match_impression = false; r.mismatch_quote = s; }
        }
      });
    }
    return r;
  }

  /* ---------- checking Claude's radiology-pathology comparison ---------- */
  // Every quote must be in the report it came from, word for word. A comparison that fails is not used.
  function checkComparison(x, imaging, pathology) {
    var problems = [];
    if (!x || typeof x !== "object") return ["No comparison came back."];
    var has = function (text, q) { return typeof q === "string" && q.trim() !== "" && String(text).indexOf(q) >= 0; };
    if (["concordant", "possible_mismatch", "unclear"].indexOf(x.match) < 0) problems.push("The comparison doesn't say whether the reports match.");
    var iq = (x.imaging && x.imaging.quotes) || {};
    Object.keys(iq).forEach(function (k) { if (iq[k] !== null && iq[k] !== undefined && !has(imaging, iq[k])) problems.push("The imaging " + k + " quote isn't in the imaging report word for word."); });
    if (!x.pathology || !has(pathology, x.pathology.quote)) problems.push("The diagnosis quote isn't in the pathology report word for word.");
    var flags = Array.isArray(x.flags) ? x.flags : [];
    if (!Array.isArray(x.flags)) problems.push("The list of concerns is missing.");
    flags.forEach(function (f, i) {
      if (!f || typeof f.concern !== "string" || !f.concern.trim()) return problems.push("Concern " + (i + 1) + " is empty.");
      if (!has(imaging, f.imaging_quote)) problems.push("Concern " + (i + 1) + " quotes the imaging report inexactly.");
      if (!has(pathology, f.pathology_quote)) problems.push("Concern " + (i + 1) + " quotes the pathology report inexactly.");
    });
    if (x.match === "possible_mismatch" && !flags.length) problems.push("A possible mismatch needs at least one concern with quotes.");
    if (typeof x.summary !== "string" || !x.summary.trim()) problems.push("The summary is missing.");
    return problems;
  }

  function checkRead(doc, r) {
    var problems = [];
    if (!r) return ["The report could not be read."];
    (Array.isArray(r.unclear) ? r.unclear : []).forEach(function (p) { problems.push(p); });
    var q = r.quotes || {};
    Object.keys(q).forEach(function (k) {
      if (q[k] && doc.text.indexOf(q[k]) < 0) problems.push("The quote for " + k.replace("_", " ") + " is not in the report word for word.");
    });
    if (r.mismatch_quote && doc.text.indexOf(r.mismatch_quote) < 0) problems.push("The quote for the conflicting finding is not in the report word for word.");
    var seen = {};
    (Array.isArray(r.breasts) ? r.breasts : []).forEach(function (b) {
      if (!b || (b.side !== "left" && b.side !== "right")) { problems.push("A per-breast assessment doesn't say which breast."); return; }
      if (seen[b.side]) problems.push("The " + b.side + " breast has two assessments.");
      seen[b.side] = true;
      var bq = b.quotes || {};
      if (!bq.birads || doc.text.indexOf(bq.birads) < 0) problems.push("The quote for the " + b.side + " breast's BI-RADS is not in the report word for word.");
      if (bq.next_step && doc.text.indexOf(bq.next_step) < 0) problems.push("The quote for the " + b.side + " breast's next step is not in the report word for word.");
      if (!normBirads(b.birads)) problems.push("No BI-RADS category for the " + b.side + " breast.");
    });
    if (doc.kind === "pathology") {
      if (!r.pathology_result) problems.push("No pathology result is stated.");
      return problems;
    }
    if (!normBirads(r.birads)) problems.push("No BI-RADS category in the impression.");
    if (r.findings_match_impression === false) problems.push("The impression says negative, but the findings describe something" + (r.mismatch_quote ? ": \"" + r.mismatch_quote + "\"" : "") + ".");
    return problems.filter(function (p, i) { return problems.indexOf(p) === i; });
  }

  function summarizeRead(doc, r) {
    if (!r) return "no answer";
    if (doc.kind === "pathology") return (r.pathology_result || "no result") + (r.diagnosis ? " (" + r.diagnosis + ")" : "");
    var s = "BI-RADS " + (r.birads == null ? "missing" : r.birads);
    if (r.side && r.side !== "null") s += ", " + r.side + (r.side === "both" ? " breasts" : " breast");
    if (r.next_step) s += ". Next step: " + r.next_step;
    return s;
  }

  /* ---------- which breast ---------- */
  // The breast the next step is for, in the report's own quoted words when they name one side.
  function followSide(r) {
    var q = (r.quotes && r.quotes.next_step) || r.next_step || "";
    var right = /\bright\b/i.test(q), left = /\bleft\b/i.test(q);
    if (right !== left) return right ? "right" : "left";
    return r.side === "left" || r.side === "right" || r.side === "both" ? r.side : null;
  }
  var URGENCY = { biopsy: 0, diagnostic: 1, shortInterval: 2, routine: 3 };
  // When a report gives each breast its own assessment: one entry per breast, most urgent first.
  function perBreast(r) {
    var list = (r && Array.isArray(r.breasts) ? r.breasts : []).filter(function (b) { return b && (b.side === "left" || b.side === "right"); });
    if (list.length < 2 || list[0].side === list[1].side) return [];
    var rank = function (b) { var p = pathwayFor(normBirads(b.birads)); return p in URGENCY ? URGENCY[p] : -1; };
    return list.slice().sort(function (a, b) { return rank(a) - rank(b); });
  }
  // What Claude read about one breast, in the same shape as a whole read.
  function sideRead(r, b) {
    var out = {}, q = {};
    Object.keys(r).forEach(function (k) { out[k] = r[k]; });
    Object.keys(r.quotes || {}).forEach(function (k) { q[k] = r.quotes[k]; });
    q.birads = (b.quotes && b.quotes.birads) || null;
    q.next_step = (b.quotes && b.quotes.next_step) || null;
    out.side = b.side; out.birads = b.birads; out.next_step = b.next_step || null; out.quotes = q; out.breasts = [];
    return out;
  }

  /* ---------- messages (wording approved once, before launch) ---------- */
  function message(kind, c, extra) {
    var f = c.patient.first;
    extra = extra || {};
    // When each breast has its own track, every message says which breast it is about.
    var side = c.sideSource === "assessment" && (c.side === "left" || c.side === "right") ? c.side : null;
    var forSide = side ? " for your " + side + " breast" : "";
    switch (kind) {
      case "book_imaging": return "Hi " + f + ", this is Riverside Breast Center. Your care team would like you to come back for more imaging" + (side ? " of your " + side + " breast" : "") + ". You can book here: " + RULES.link + ". Reply to this text if you have questions or need help getting here.";
      case "book_biopsy": return "Hi " + f + ", this is Riverside Breast Center. Your care team asked us to help you schedule the appointment they discussed with you" + forSide + ". You can book here: " + RULES.link + ". We can help with a ride, directions and what to expect. Reply anytime.";
      case "book_6mo": return "Hi " + f + ", this is Riverside Breast Center. Your 6-month follow-up imaging" + forSide + " is due " + fmt(extra.due) + ". You can book here: " + RULES.link + ". Reply if you need help.";
      case "portal": return "Patient portal message: Please schedule your follow-up appointment" + forSide + " at Riverside Breast Center. Book online at " + RULES.link + " or call " + RULES.phone + ".";
      case "call": return "Automated call asking her to book her follow-up appointment" + (side ? " for her " + side + " breast" : "") + ", with an option to press 1 to reach the scheduling team.";
      case "nudge": return "Hi " + f + ", checking in. You can still book your follow-up" + forSide + " here: " + RULES.link + ". Reply if something is getting in the way.";
      case "transport": return "We can set up a free ride to and from your appointment. Book it here: " + RULES.rideLink + ", or reply RIDE and we'll arrange it.";
      case "slots": return "Here are other open times: Mon 9:00, Wed 1:30, Fri 10:15. Reply with the one that works.";
      case "appt_reminder": return "Reminder: your appointment" + forSide + " at Riverside Breast Center is tomorrow, " + weekday(extra.appt) + " " + fmtShort(extra.appt) + ". Reply if you need a ride or a different time.";
    }
    return "";
  }
  var TEMPLATES = ["book_imaging", "book_biopsy", "book_6mo", "portal", "call", "nudge", "transport", "slots", "appt_reminder"];

  /* ---------- the engine: one patient's follow-up loop ---------- */
  /*
    The same engine runs the simulation below and the local workspace in server/.
    A case is plain data (see newCase), so the workspace can save it between steps.
      hooks.log(event, c)               records what happened
      hooks.world(c, when, day, ctx)    lets the simulated world react (the workspace has no script)
      hooks.check(doc, read)            returns problems with the report's read (default: checkRead)
      hooks.side(c, side, read, doc, day)   a report gave another breast its own assessment: follow it on its own track
      hooks.openTracks(c)               the patient's other tracks that are still open
    A case follows one patient, or one breast of a patient when a report assesses each breast separately.
  */
  function newCase(patient) {
    return { patient: patient, started: false, closed: null, person: null, booked: null, step: null, openCat: null, openDate: null,
      resolvedDay: null, neededPerson: false, used: {}, lastAgent: null, birads: null, bi3: null, side: null, sideSource: null, multi: false,
      imagingDoc: null, pathDoc: null };
  }

  function createEngine(hooks) {
    hooks = hooks || {};
    var check = hooks.check || checkRead;
    var world = hooks.world || function () {};

    function log(c, day, actor, kind, text, extra) {
      var e = { day: day, date: dateOf(day), patient: c.patient.id, actor: actor, kind: kind, text: text };
      if (extra) Object.keys(extra).forEach(function (k) { e[k] = extra[k]; });
      if (c.side) e.side = c.side;
      if (c.track) e.track = c.track;
      if (hooks.log) hooks.log(e, c);
      if (actor === "agent" && e.short) c.lastAgent = e.short;
      return e;
    }

    function send(c, day, channel, template, extra, short) {
      return log(c, day, "agent", channel, message(template, c, extra), { short: short, channel: channel, template: template });
    }

    function handoff(c, day, who, reason, short, kind) {
      c.person = { who: who, reason: reason, kind: kind, since: day };
      if (kind === "exception" || kind === "hold") c.neededPerson = true;
      log(c, day, "agent", "handoff", "Handed to the " + who.toLowerCase() + ". " + reason, { short: short, handoffKind: kind, who: who });
      if (kind === "exception") world(c, "handoff", day, {});
      if (kind === "hold") world(c, "hold", day, {});
      if (kind === "concordance") world(c, "concordance", day, {});
    }

    function close(c, day, outcome, short) {
      c.closed = { day: day, outcome: outcome };
      if (c.person && c.person.kind !== "surgery") c.person = null;
      if ((c.openCat === "0" || c.openCat === "4-5" || c.openCat === "unclear") && c.resolvedDay === null) c.resolvedDay = day;
      log(c, day, "agent", "close", "Case closed" + (c.multi ? " for the " + c.side + " breast" : "") + ". " + outcome, { short: short });
      stillOpen(c, day);
    }
    // When one breast's case closes, say which other breast is still being followed. Nothing closes for her while it is.
    function stillOpen(c, day) {
      (hooks.openTracks ? hooks.openTracks(c) : []).forEach(function (t) {
        var s = t.step;
        log(c, day, "agent", "note", "The " + t.side + " breast is still open: " + (s ? s.name.toLowerCase() + (s.due ? ", due " + fmt(s.due) : "") : "follow-up") + ". The agent keeps following it.", { short: "The " + t.side + " breast is still open" });
      });
    }

    function openUrgentStep(c, day, kind, exam, docId, name) {
      var cfg = RULES[kind];
      c.step = {
        kind: kind, name: name || cfg.step, due: addDays(exam, cfg.dueDays), personDay: dayOf(exam) + cfg.personIfNotBookedByDay,
        doc: docId, attempts: 0, replied: false, lastContact: null, noAnswerDay: day + RULES.urgent.noAnswerHandoffAfter,
        plan: RULES.urgent.attempts.map(function (a) { return { day: day + a.after, channel: a.channel, done: false }; }),
        overdueLogged: false
      };
      c.booked = null;
      log(c, day, "agent", "pathway", "Pathway: " + c.step.name.toLowerCase() + ", due " + fmt(c.step.due) + ". Outreach starts now.", { short: "Due date set: " + fmtShort(c.step.due) });
      // A report read after the hand-off day goes straight to a person instead of starting outreach.
      if (day >= c.step.personDay) handoff(c, day, "Nurse navigator", "This report is already beyond the unbooked handoff threshold (day " + cfg.personIfNotBookedByDay + " after the exam), so a person takes it now.", "Report came in late, sent to the navigator", "exception");
    }

    function attempt(c, day, channel) {
      var s = c.step;
      s.attempts++;
      s.lastContact = day;
      var tpl = channel === "text" ? (s.kind === "biopsy" ? "book_biopsy" : s.kind === "shortInterval" ? "book_6mo" : "book_imaging") : channel;
      var short = channel === "text" ? (s.attempts === 1 ? "Texted a booking link" : "Texted the booking link again") : channel === "portal" ? "Sent a portal message" : "Made an automated call";
      send(c, day, channel, tpl, { due: s.due }, short);
      if (s.attempts === 1) world(c, "outreach", day, { doc: s.doc });
    }

    function onDoc(c, doc, r, day, opts) {
      opts = opts || {};
      var first = !c.started, others = [];
      c.started = true;
      if (opts.split) {
        // Another case's report gave this breast its own assessment. The checks already ran on the whole report.
        c.multi = true; c.sideSource = "assessment"; c.side = r.side; c.imagingDoc = doc.id;
        log(c, day, "agent", "split", "Following the " + r.side + " breast on its own: " + summarizeRead(doc, r) + ".", { doc: doc.id, short: "Started a separate case for the " + r.side + " breast" });
      } else {
        log(c, day, "system", "doc", (opts.source ? opts.source + ". " : "") + doc.title + " arrived.", { doc: doc.id });
        log(c, day, "agent", "read", "The rules read the " + doc.title.toLowerCase() + ": " + summarizeRead(doc, r) + ".", { doc: doc.id, short: "Read the " + doc.title.toLowerCase() });
        var problems = check(doc, r);
        if (problems.length) {
          log(c, day, "agent", "check", "Check failed. " + problems.join(" "), { doc: doc.id, ok: false });
          if (first) { c.openCat = "unclear"; c.openDate = (r && r.exam_date) || doc.date; }
          c.step = { kind: "review", name: "Radiologist review", due: null };
          handoff(c, day, "Radiologist", "The report is unclear, so the case stops here until a radiologist looks at it.", "Held for a radiologist: report unclear", "hold");
          return;
        }
        log(c, day, "agent", "check", "Checks passed. " + (doc.kind === "pathology" ? "The diagnosis is one the rules know." : "One clear BI-RADS category, a valid exam date, and findings that fit the impression."), { doc: doc.id, ok: true });
        if (c.person && c.person.kind === "hold") {
          c.person = null;
          log(c, day, "agent", "note", "The radiologist's correction passed the checks. The agent picks the case back up.", { short: "Picked the case back up" });
        }
        if (doc.kind === "pathology") return onPathology(c, doc, r, day, opts.comparison);
        c.imagingDoc = doc.id;
        // A report that gives each breast its own assessment: this case follows one breast, and each other breast gets a case of its own.
        var sides = perBreast(r);
        if (sides.length) {
          var mine = (c.sideSource === "assessment" && sides.filter(function (s) { return s.side === c.side; })[0]) || sides[0];
          c.multi = true; c.sideSource = "assessment"; c.side = mine.side;
          log(c, day, "agent", "split", "This report gives each breast its own assessment, so each breast gets its own case. This one follows the " + mine.side + " breast (BI-RADS " + mine.birads + ").", { doc: doc.id, short: "Split the report by breast" });
          others = sides.filter(function (s) { return s !== mine; }).map(function (s) { return sideRead(r, s); });
          r = sideRead(r, mine);
        } else if (c.sideSource !== "assessment") c.side = followSide(r);
      }
      followUp(c, doc, r, day, first);
      others.forEach(function (sr) {
        if (pathwayFor(normBirads(sr.birads)) === "routine") log(c, day, "agent", "note", "The " + sr.side + " breast is BI-RADS " + sr.birads + ", so that side needs no follow-up.", { short: "No follow-up needed on the " + sr.side });
        else if (hooks.side) hooks.side(c, sr.side, sr, doc, day);
      });
    }

    // The pathway, the due date and the first step for what this case follows.
    function followUp(c, doc, r, day, first) {
      var b = normBirads(r.birads), pw = pathwayFor(b), exam = r.exam_date || doc.date;
      c.birads = r.birads;
      if (first) { c.openCat = catOf(b); c.openDate = exam; }

      if (pw === "routine") {
        if (c.openCat === "1-2") c.step = { kind: "routine", name: "Routine screening", due: addMonths(exam, 12) };
        if (c.openCat === "1-2") close(c, day, "Routine screening. Next screen due " + fmt(addMonths(exam, 12)) + ". No outreach needed.", "None needed. Routine screening");
        else close(c, day, "Resolved as BI-RADS " + r.birads + ". Back to routine screening.", "Resolved: back to routine screening");
        return;
      }
      if (pw === "diagnostic") { openUrgentStep(c, day, "diagnostic", exam, doc.id); return; }
      if (pw === "biopsy") {
        openUrgentStep(c, day, "biopsy", exam, doc.id);
        if (b === RULES.biopsy.headsUpCategory) log(c, day, "agent", "headsup", "Heads-up to the nurse navigator: a BI-RADS 5 was read today. The agent is handling outreach, and the case doesn't wait on her.", { short: "Heads-up to the navigator" });
        log(c, day, "agent", "pcp", "Note to the ordering PCP: BI-RADS " + r.birads + ", biopsy recommended. The agent is helping her schedule it.", { short: "Told the ordering PCP" });
        return;
      }
      if (pw === "shortInterval") {
        if (c.step && c.step.kind === "shortInterval") {
          var onTime = day <= dayOf(c.step.due);
          c.bi3 = { due: c.step.due, doneDay: day, onTime: onTime };
          close(c, day, "Stable at 6 months. Next imaging due " + fmt(addMonths(exam, 6)) + ", so she stays on the six-month track.", "Done on time. Next due " + fmtShort(addMonths(exam, 6)));
          return;
        }
        var due = addMonths(exam, RULES.shortInterval.dueMonths);
        c.booked = null;
        c.step = {
          kind: "shortInterval", name: RULES.shortInterval.step, due: due,
          outreachStart: addMonths(due, -RULES.shortInterval.outreachMonthsBefore),
          personDate: addMonths(due, RULES.shortInterval.personMonthsAfterDue),
          doc: doc.id, attempts: 0, replied: false, lastContact: null, sent: {}, overdueLogged: false
        };
        log(c, day, "agent", "pathway", "Pathway: 6-month follow-up imaging, due " + fmt(due) + ". Reminders start " + fmt(c.step.outreachStart) + ".", { short: "Watching: due " + fmtShort(due) });
        // Same rule as above: already a month past due means a person takes it now.
        if (day >= dayOf(c.step.personDate)) handoff(c, day, "Nurse navigator", "This report is already beyond the unbooked handoff threshold (one month after the due date), so a person takes it now.", "Report came in late, sent to the navigator", "exception");
        return;
      }
      c.step = { kind: "review", name: "Review", due: null };
      handoff(c, day, "Radiologist", "BI-RADS " + r.birads + " has no pathway in these rules.", "No pathway, sent to a person", "hold");
    }

    // Claude's side-by-side summary of the imaging and pathology reports, and any concerns it flags.
    // A rule adds one concern of its own: BI-RADS 5 imaging with a benign result never matches.
    function compare(c, doc, r, day, cmp) {
      var concerns = [];
      if (!cmp) log(c, day, "agent", "compare", "There is no imaging report on this case to compare the pathology with.", { doc: doc.id });
      else if (cmp.error) log(c, day, "agent", "compare", "Claude's comparison of the two reports isn't available. " + cmp.error, { doc: doc.id });
      else if (cmp.problems && cmp.problems.length) log(c, day, "agent", "compare", "Claude's comparison failed the quote check, so it isn't used. " + cmp.problems[0], { doc: doc.id, ok: false });
      else {
        var x = cmp.read;
        log(c, day, "agent", "compare", "Claude compared the imaging and pathology reports. " + x.summary, { doc: doc.id, short: "Compared the imaging and pathology reports", comparison: x, match: x.match });
        x.flags.forEach(function (f) {
          concerns.push(f.concern);
          log(c, day, "agent", "flag", "Possible mismatch: " + f.concern + " Imaging: \u201c" + f.imaging_quote + "\u201d Pathology: \u201c" + f.pathology_quote + "\u201d", { doc: doc.id, short: "Flagged a possible mismatch" });
        });
      }
      if (r.pathology_result === "benign" && normBirads(c.birads) === "5") {
        concerns.push("BI-RADS 5 imaging with a benign result never counts as a match.");
        log(c, day, "agent", "flag", "Rule: BI-RADS 5 imaging with a benign result never counts as a match, so it goes back to the radiologist as a possible mismatch.", { doc: doc.id, short: "Flagged a possible mismatch", rule: true });
      }
      return concerns;
    }

    function onPathology(c, doc, r, day, cmp) {
      var res = r.pathology_result, dx = r.diagnosis ? r.diagnosis.charAt(0).toLowerCase() + r.diagnosis.slice(1) : "no diagnosis given";
      c.pathDoc = doc.id;
      var concerns = compare(c, doc, r, day, cmp);
      if (res === "malignant") {
        log(c, day, "agent", "pcp", "Note to the ordering PCP: pathology shows " + dx + ". Breast surgery is taking over.", { short: "Told the ordering PCP" });
        handoff(c, day, "Breast surgery team", "Cancer diagnosis: " + r.diagnosis + ". Her care moves to the surgery team.", "Pathology received, handed to breast surgery", "surgery");
        close(c, day, "Cancer diagnosed and handed to breast surgery. The agent's loop is done.", "Handed to breast surgery");
      } else if (res === "benign" && concerns.length) {
        handoff(c, day, "Radiologist", "Benign result: " + dx + ". It may not match the imaging. " + concerns[0] + " The radiologist decides whether it matches before the case closes.", "Possible mismatch sent to the radiologist", "concordance");
      } else if (res === "benign") {
        handoff(c, day, "Radiologist", "Benign result: " + dx + ". A person confirms it matches the imaging before the case closes.", "Benign result sent for a match check", "concordance");
      } else {
        handoff(c, day, "Radiologist", "Pathology is " + res + ". A person decides the next step.", "Pathology needs a person", "hold");
      }
    }

    function onReply(c, reply, r, day) {
      log(c, day, "patient", "reply", reply.text, { reply: reply.id });
      var labels = (r && r.labels && r.labels.length) ? r.labels : ["other"];
      var quoteOk = !!(r && r.quote && reply.text.indexOf(r.quote) >= 0);
      log(c, day, "agent", "readreply", "Claude read her reply: " + (r ? r.summary : "no answer") + " Labels: " + labels.join(", ") + ".", { reply: reply.id, short: "Read her reply", labels: labels });
      if (c.step) { c.step.replied = true; c.step.lastContact = day; }
      // While a person has the case, the agent doesn't answer her. The person sees the reply.
      if (c.person && c.person.kind !== "surgery") { log(c, day, "agent", "note", "The " + c.person.who.toLowerCase() + " has this case, so the agent doesn't answer. Her reply is there for them.", { short: "Left her reply for the person" }); return; }
      if (!quoteOk) return handoff(c, day, "Nurse navigator", "Claude's quote didn't match her message, so a person reads it.", "Reply needs a person", "exception");
      var exc = labels.filter(function (l) { return EXCEPTIONS[l]; });
      if (exc.length) return handoff(c, day, "Nurse navigator", EXCEPTIONS[exc[0]] + ". A person takes it from here.", EXCEPTIONS[exc[0]] + ", sent to navigator", "exception");
      if (labels.indexOf("transport_barrier") >= 0) { send(c, day, "text", "transport", {}, "Sent a free ride option after she said she had no ride"); world(c, "transport", day, {}); return; }
      if (labels.indexOf("wants_new_time") >= 0) { send(c, day, "text", "slots", {}, "Sent other open times"); world(c, "slots", day, {}); return; }
      if (labels.indexOf("booked") >= 0) { log(c, day, "agent", "note", "She says she booked. The agent checks the schedule to confirm.", { short: "Checking the schedule" }); return; }
      handoff(c, day, "Nurse navigator", "A reply the agent couldn't sort.", "Reply needs a person", "exception");
    }

    function onBook(c, book, day, byPerson) {
      c.booked = { appt: book.appt, kind: book.kind || "imaging", result: book.result, resultAfter: book.resultAfter || 0, reminded: false, arrived: false };
      if (c.person && c.person.kind === "exception") c.person = null;
      log(c, day, "agent", "booked", "Checked the schedule: " + (c.booked.kind === "biopsy" ? "biopsy" : "imaging") + " booked for " + weekday(book.appt) + " " + fmt(book.appt) + (byPerson ? ", booked with the navigator" : "") + ".", { short: "Saw a booking for " + fmtShort(book.appt) });
    }

    function onAppt(c, day) {
      var b = c.booked;
      if (b.kind === "biopsy") {
        log(c, day, "system", "appt", "Biopsy done.", {});
        c.step = { kind: "pathology", name: RULES.pathology.step, due: addDays(dateOf(day), RULES.pathology.dueDaysAfterBiopsy), personDay: day + RULES.pathology.dueDaysAfterBiopsy };
        log(c, day, "agent", "pathway", "Watching for the pathology result, due " + fmt(c.step.due) + ". The agent never gives results to the patient.", { short: "Watching for pathology" });
        c.booked = null;
      } else {
        log(c, day, "system", "appt", "Appointment done.", {});
        // In the simulation the report arrives the same day. In the workspace the agent watches for it.
        if (c.step) c.step.awaitingResult = { since: day, personDay: day + RULES.imagingReport.dueDaysAfterAppointment };
        c.booked = null;
      }
      world(c, "appt", day, { booking: b });
    }

    // People in the loop. The simulation scripts them; in the workspace they are buttons.
    function personNote(c, day, who, note) { log(c, day, "person", "person", note, { who: who }); }
    function concordant(c, day) { c.person = null; close(c, day, "Benign and concordant. Back to annual screening.", "Resolved: benign and concordant"); }
    // The radiologist found the benign result doesn't explain the imaging: the agent follows her to a repeat biopsy.
    function discordant(c, day) {
      c.person = null;
      log(c, day, "agent", "pcp", "Note to the ordering PCP: the radiologist found that the benign biopsy result doesn't match the imaging and recommends a repeat biopsy. The agent is helping her schedule it.", { short: "Told the ordering PCP" });
      openUrgentStep(c, day, "biopsy", dateOf(day), c.pathDoc, "Repeat biopsy");
    }
    function resume(c, day) {
      c.person = null;
      if (c.step) { c.step.replied = true; c.step.lastContact = day; }
      log(c, day, "agent", "note", "The navigator handed the case back. The agent keeps following up.", { short: "Picked the case back up" });
    }
    function closeByPerson(c, day, who, outcome) {
      c.person = null;
      c.closed = { day: day, outcome: outcome, by: who };
      log(c, day, "person", "close", "Case closed by the " + who.toLowerCase() + ". " + outcome, { who: who });
      stillOpen(c, day);
    }

    function tick(c, day) {
      if (!c.started || c.closed || !c.step) return;
      var s = c.step;
      if (c.booked) {
        var ad = dayOf(c.booked.appt);
        if (day === ad - 1 && !c.booked.reminded) { c.booked.reminded = true; send(c, day, "text", "appt_reminder", { appt: c.booked.appt }, "Sent an appointment reminder"); }
        if (day === ad && !c.booked.arrived) { c.booked.arrived = true; onAppt(c, day); }
        return;
      }
      if (s.awaitingResult) {
        if (day >= s.awaitingResult.personDay && !c.person) handoff(c, day, "Nurse navigator", "No report " + RULES.imagingReport.dueDaysAfterAppointment + " days after the appointment.", "No report after the appointment, sent to a person", "exception");
        return;
      }
      if (s.due && day === dayOf(s.due) + 1 && !s.overdueLogged) {
        s.overdueLogged = true;
        log(c, day, "agent", "overdue", "Past due. " + s.name + " was due " + fmt(s.due) + ".", { short: "Marked overdue" });
      }
      if (s.kind === "pathology") {
        if (day >= s.personDay && !c.person) handoff(c, day, "Nurse navigator", "No pathology result 10 days after the biopsy.", "No pathology result, sent to a person", "exception");
        return;
      }
      if (c.person || s.kind === "review") return;
      if (s.kind === "shortInterval") {
        var startDay = dayOf(s.outreachStart), dueDay = dayOf(s.due);
        RULES.shortInterval.attempts.forEach(function (a, i) {
          var d = a.fromStart !== undefined ? startDay + a.fromStart : dueDay + a.fromDue;
          if (d === day && !s.sent[i] && !s.replied) { s.sent[i] = true; attempt(c, day, a.channel); }
        });
        if (s.replied && s.lastContact !== null && day - s.lastContact >= RULES.shortInterval.nudgeEvery) { s.lastContact = day; send(c, day, "text", "nudge", {}, "Sent a check-in text"); }
        if (day >= dayOf(s.personDate) && !c.person) handoff(c, day, "Nurse navigator", "Not done one month after the due date.", "One month past due, sent to the navigator", "exception");
        return;
      }
      s.plan.forEach(function (a) { if (!a.done && a.day === day && !s.replied) { a.done = true; attempt(c, day, a.channel); } });
      if (!s.replied && s.attempts >= 3 && day >= s.noAnswerDay) return handoff(c, day, "Nurse navigator", "No answer after three tries: a text, a portal message and an automated call.", "No answer after three tries, sent to the navigator", "exception");
      if (s.replied && s.lastContact !== null && day - s.lastContact >= RULES.urgent.nudgeEvery) { s.lastContact = day; send(c, day, "text", "nudge", {}, "Sent a check-in text"); }
      if (day >= s.personDay) handoff(c, day, "Nurse navigator", "Not booked within " + (s.kind === "biopsy" ? RULES.biopsy.personIfNotBookedByDay : RULES.diagnostic.personIfNotBookedByDay) + " days of the report.", "Not booked in time, sent to the navigator", "exception");
    }

    function status(c, day) {
      if (!c.started) return "waiting";
      if (c.closed) return "done";
      if (c.step && c.step.due && !c.step.awaitingResult && day > dayOf(c.step.due)) return "overdue";
      if (c.person) return "person";
      if (c.booked) return "booked";
      return "agent";
    }

    function snapshot(c, day) {
      var s = c.step;
      return {
        status: status(c, day), cat: c.openCat, birads: c.birads,
        step: s ? s.name : null, due: s ? s.due : null,
        overdueDays: s && s.due && !c.closed && !s.awaitingResult ? Math.max(0, day - dayOf(s.due)) : 0,
        person: c.person ? c.person.who : null, personKind: c.person ? c.person.kind : null,
        booked: c.booked ? c.booked.appt : null,
        lastAgent: c.lastAgent, outcome: c.closed ? c.closed.outcome : null,
        resolvedDays: c.resolvedDay !== null ? c.resolvedDay - dayOf(c.openDate) : null,
        neededPerson: c.neededPerson, bi3: c.bi3 ? { onTime: c.bi3.onTime } : null, side: c.side
      };
    }

    return { onDoc: onDoc, onReply: onReply, onBook: onBook, tick: tick, status: status, snapshot: snapshot,
      personNote: personNote, concordant: concordant, discordant: discordant, resume: resume, closeByPerson: closeByPerson };
  }

  /* ---------- the simulation ---------- */
  function simulate(input) {
    var docsById = {}, repliesById = {};
    input.documents.forEach(function (d) { docsById[d.id] = d; });
    input.replies.forEach(function (r) { repliesById[r.id] = r; });
    var reads = input.reads, ruleReads = {};
    var events = [], agenda = {}, cases = {}, snapshots = [];
    function readOf(doc) { return ruleReads[doc.id] || (ruleReads[doc.id] = readReport(doc.text)); }
    // Claude's recorded comparison for this biopsy, checked against both reports. Only used for the pair it was made for.
    function comparisonFor(c, doc) {
      if (doc.kind !== "pathology") return null;
      if (!c.imagingDoc) return null;
      var saved = reads.comparisons && reads.comparisons[doc.id];
      if (!saved || saved.imaging !== c.imagingDoc) return { error: "No recorded comparison for these two reports." };
      return { read: saved.comparison, problems: checkComparison(saved.comparison, docsById[saved.imaging].text, doc.text) };
    }
    // Each patient has one case, plus one more per breast when a report assesses each breast separately.
    var tracksOf = {}, trackByKey = {}, lastAgentOf = {};
    var RANK = { overdue: 0, person: 1, agent: 2, booked: 3, done: 4, waiting: 5 };

    function schedule(day, item) { (agenda[day] = agenda[day] || []).push(item); }

    // The simulated world reacts to what the agent did. The agent never reads this.
    function trigger(c, when, day, ctx) {
      (c.patient.reactions || []).forEach(function (r, i) {
        if (c.used[i] || r.when !== when) return;
        if (r.side && r.side !== c.side) return;
        if (r.doc && when === "outreach" && (!ctx || ctx.doc !== r.doc)) return;
        c.used[i] = true;
        var d = day + (r.after || 0);
        if (r.person) { schedule(d, { type: "person", patient: c.patient.id, track: c.track, react: r }); return; }
        if (r.reply) schedule(d, { type: "reply", patient: c.patient.id, track: c.track, reply: r.reply });
        if (r.book) schedule(d, { type: "book", patient: c.patient.id, track: c.track, book: r.book });
      });
    }

    var engine = createEngine({
      log: function (e) { events.push(e); if (e.actor === "agent" && e.short) lastAgentOf[e.patient] = e.short; },
      world: function (c, when, day, ctx) {
        // After an appointment the result report arrives: the same day for imaging, later for pathology.
        if (when === "appt") { var b = ctx.booking; schedule(day + (b.kind === "biopsy" ? b.resultAfter : 0), { type: "doc", patient: c.patient.id, track: c.track, doc: b.result }); return; }
        trigger(c, when, day, ctx);
      },
      side: function (c, side, read, doc, day) {
        var list = tracksOf[c.patient.id];
        var t = list.filter(function (x) { return x !== c && x.side === side && !x.closed; })[0];
        if (!t) { t = newCase(c.patient); t.track = c.patient.id + ":" + side; list.push(t); trackByKey[t.track] = t; }
        engine.onDoc(t, doc, read, day, { split: true });
      },
      openTracks: function (c) { return tracksOf[c.patient.id].filter(function (x) { return x !== c && x.started && !x.closed; }); }
    });

    input.patients.forEach(function (p) {
      var c = cases[p.id] = newCase(p);
      c.track = p.id;
      tracksOf[p.id] = [c];
      trackByKey[p.id] = c;
      schedule(Math.max(0, dayOf(p.arrives)), { type: "doc", patient: p.id, doc: p.first_doc, first: true });
    });

    // One row per patient. She is only done when every breast is done, and her row shows the most urgent open breast.
    function patientSnapshot(p, day) {
      var list = tracksOf[p.id], s = engine.snapshot(list[0], day);
      s.lastAgent = lastAgentOf[p.id] || null;
      var started = list.filter(function (t) { return t.started; });
      if (started.length > 1) {
        s.tracks = started.map(function (t) { return engine.snapshot(t, day); });
        var live = s.tracks.filter(function (t) { return t.status !== "done"; }).sort(function (a, b) { return RANK[a.status] - RANK[b.status]; });
        if (live.length) {
          ["status", "step", "due", "overdueDays", "person", "personKind", "booked"].forEach(function (k) { s[k] = live[0][k]; });
          s.outcome = null;
        }
        s.neededPerson = list.some(function (t) { return t.neededPerson; });
      }
      return s;
    }

    function onPerson(c, item, day) {
      var r = item.react;
      engine.personNote(c, day, r.person, r.note);
      if (r.when === "concordance") { if (r.decision === "discordant") engine.discordant(c, day); else engine.concordant(c, day); return; }
      if (r.doc) schedule(day, { type: "doc", patient: c.patient.id, doc: r.doc });
      if (r.book) engine.onBook(c, r.book, day, true);
    }

    for (var day = 0; day <= RULES.days; day++) {
      var guard = 0;
      do {
        while (agenda[day] && agenda[day].length) {
          var it = agenda[day].shift(), c = (it.track && trackByKey[it.track]) || cases[it.patient];
          if (it.type === "doc") { var d = docsById[it.doc]; engine.onDoc(c, d, readOf(d), day, { source: it.first ? c.patient.source : null, comparison: comparisonFor(c, d) }); }
          else if (it.type === "reply") engine.onReply(c, repliesById[it.reply], reads.replies[it.reply], day);
          else if (it.type === "book") engine.onBook(c, it.book, day, false);
          else if (it.type === "person") onPerson(c, it, day);
        }
        input.patients.forEach(function (p) { tracksOf[p.id].forEach(function (t) { engine.tick(t, day); }); });
        guard++;
      } while (agenda[day] && agenda[day].length && guard < 20);

      var snap = {};
      input.patients.forEach(function (p) { snap[p.id] = patientSnapshot(p, day); });
      snapshots.push(snap);
    }
    return { events: events, snapshots: snapshots };
  }

  var api = { RULES: RULES, EXCEPTIONS: EXCEPTIONS, TEMPLATES: TEMPLATES, simulate: simulate, createEngine: createEngine, newCase: newCase,
    readReport: readReport, checkComparison: checkComparison, checkRead: checkRead, summarizeRead: summarizeRead, normBirads: normBirads, pathwayFor: pathwayFor, catOf: catOf,
    followSide: followSide, perBreast: perBreast, sideRead: sideRead,
    addDays: addDays, addMonths: addMonths, dayOf: dayOf, dateOf: dateOf, fmt: fmt, fmtShort: fmtShort, weekday: weekday, message: message };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.BreastAgent = api;
})(this);
