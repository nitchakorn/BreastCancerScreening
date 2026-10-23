const A = require('../agent/agent.js');
const R = A.RULES;

const DOC_TYPES = ['screening', 'diagnostic', 'ultrasound', 'addendum', 'pathology'];
const TITLES = { screening: 'Screening mammogram', diagnostic: 'Diagnostic imaging report', ultrasound: 'Ultrasound report', addendum: 'Report addendum', pathology: 'Pathology report' };
const OUTREACH_STEPS = ['diagnostic', 'biopsy', 'shortInterval'];

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T12:00:00Z');
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

// Code checks every structured read before the agent acts on it. Any problem holds the case for a radiologist.
function checkReport(text, read, now) {
  const problems = [];
  if (!read || typeof read !== 'object' || Array.isArray(read)) return ['No usable structured report was returned.'];
  // The rules say when a report doesn't fit them. Each reason sends the case to a radiologist.
  if (Array.isArray(read.unclear)) for (const reason of read.unclear) problems.push(reason);
  if (read.unclear && read.unclear.length) return [...new Set(problems)];
  if (!DOC_TYPES.includes(read.doc_type)) problems.push('Document type is missing or unsupported.');
  if (!validDate(read.exam_date)) problems.push('A valid exam or procedure date is required.');
  else if (read.exam_date > now) problems.push('The exam date is in the future and requires review.');
  const quotes = read.quotes;
  if (!quotes || typeof quotes !== 'object' || Array.isArray(quotes)) problems.push('Supporting quotes are missing.');
  else {
    for (const [key, quote] of Object.entries(quotes)) {
      if (quote !== null && (typeof quote !== 'string' || !quote.trim() || !text.includes(quote))) problems.push(`The ${key} quote does not match the report word for word.`);
    }
    for (const key of ['exam_date', read.doc_type === 'pathology' ? 'pathology_result' : 'birads']) {
      if (typeof quotes[key] !== 'string' || !quotes[key].trim()) problems.push(`A supporting ${key} quote is required.`);
    }
    if (read.next_step && !quotes.next_step) problems.push('The recommendation needs a supporting quote.');
    // A copied quote must support the extracted value, not just occur somewhere in the document.
    if (validDate(read.exam_date) && typeof quotes.exam_date === 'string') {
      const [y, m, d] = read.exam_date.split('-');
      const quoted = quotes.exam_date;
      const dates = [read.exam_date, `${m}/${d}/${y}`, `${Number(m)}/${Number(d)}/${y}`];
      if (!dates.some(date => quoted.includes(date))) problems.push('The quoted date does not support the extracted exam date.');
    }
    if (read.doc_type !== 'pathology' && typeof quotes.birads === 'string') {
      const match = quotes.birads.match(/BI[\s-]*RADS\s*(?:category\s*)?[:\-]?\s*([0-6](?:[ABC])?)\b/i);
      if (!match || match[1].toUpperCase() !== String(read.birads).toUpperCase()) problems.push('The BI-RADS quote does not support the extracted category.');
    }
  }
  if (read.mismatch_quote !== null && read.mismatch_quote !== undefined && (typeof read.mismatch_quote !== 'string' || !text.includes(read.mismatch_quote))) problems.push('The conflicting-finding quote does not match the report.');
  if (read.mismatch_quote && read.findings_match_impression === true) problems.push('A conflicting finding was quoted despite a matching-impression flag. Radiologist review is required.');
  if (read.doc_type !== 'pathology') {
    if (!/^(?:[0-6]|4[ABC])$/.test(String(read.birads))) problems.push('A supported BI-RADS value is required.');
    if (read.findings_match_impression !== true) problems.push('The findings and impression require radiologist review.');
  }
  if (read.doc_type === 'pathology' && !['malignant', 'benign', 'atypia', 'nondiagnostic'].includes(read.pathology_result)) problems.push('A supported pathology result is required.');
  // A separate assessment for each breast gets the same checks as the whole report.
  if (read.breasts !== undefined && read.breasts !== null) {
    if (!Array.isArray(read.breasts)) problems.push('The per-breast assessments must be a list.');
    else {
      const seen = new Set();
      for (const b of read.breasts) {
        if (!b || typeof b !== 'object' || !['left', 'right'].includes(b.side)) { problems.push('A per-breast assessment does not say which breast.'); continue; }
        if (seen.has(b.side)) problems.push(`The ${b.side} breast has two assessments.`);
        seen.add(b.side);
        const q = b.quotes && typeof b.quotes === 'object' ? b.quotes : {};
        if (!/^(?:[0-6]|4[ABC])$/.test(String(b.birads))) problems.push(`A supported BI-RADS value is required for the ${b.side} breast.`);
        if (typeof q.birads !== 'string' || !q.birads.trim() || !text.includes(q.birads)) problems.push(`The ${b.side} breast's BI-RADS quote does not match the report word for word.`);
        else {
          const match = q.birads.match(/BI[\s-]*RADS\s*(?:category\s*)?[:\-]?\s*([0-6](?:[ABC])?)\b/i);
          if (!match || match[1].toUpperCase() !== String(b.birads).toUpperCase()) problems.push(`The ${b.side} breast's BI-RADS quote does not support its category.`);
        }
        if (b.next_step && (typeof q.next_step !== 'string' || !q.next_step.trim() || !text.includes(q.next_step))) problems.push(`The ${b.side} breast's recommendation needs a quote that matches the report.`);
      }
    }
  }
  return [...new Set(problems)];
}

// What the engine needs to know about a report.
function docFor(report, read) {
  const type = read && DOC_TYPES.includes(read.doc_type) ? read.doc_type : null;
  return {
    id: report.id, kind: type === 'pathology' ? 'pathology' : type === 'addendum' ? 'addendum' : 'imaging',
    title: TITLES[type] || 'Report', text: report.text, date: read && validDate(read.exam_date) ? read.exam_date : null
  };
}

// Test messages greet her by first name when the label looks like one, otherwise "Hi there".
function firstName(label) {
  const word = String(label || '').trim().split(/\s+/)[0] || '';
  return /^[A-Z][a-z'’-]{1,30}$/.test(word) && !/^(demo|synthetic|test|patient|sample)$/i.test(word) ? word : 'there';
}

// The case state shown in the workspace, worked out from the engine's case.
function caseStatus(c, today) {
  if (!c || !c.started) return 'queued';
  if (c.closed) return 'closed';
  if (c.person && c.person.kind !== 'surgery') return 'needs_review';
  if (c.booked) return 'booked';
  const s = c.step;
  if (!s || s.kind === 'review') return 'needs_review';
  if (s.kind === 'pathology' || s.awaitingResult) return 'awaiting_result';
  if (s.kind === 'shortInterval' && today < s.outreachStart) return 'waiting_reminder';
  return 'awaiting_booking';
}

// The day an unbooked case goes to a navigator.
function handoffDate(c) {
  const s = c && c.step;
  if (!s) return null;
  if (s.kind === 'diagnostic' || s.kind === 'biopsy') return A.dateOf(s.personDay);
  if (s.kind === 'shortInterval') return s.personDate;
  return null;
}

// What the agent plans to do next, in date order. Shown in the workspace so a person can see the plan.
function comingUp(c, today) {
  const items = [], s = c && c.step, day = A.dayOf(today);
  if (!s || !c.started || c.closed) return items;
  const add = (d, what) => { if (d >= day) items.push({ date: A.dateOf(d), what }); };
  const label = { text: 'Text her the booking link', portal: 'Send a portal message', call: 'Make an automated call' };
  if (c.person) return [{ date: today, what: `With the ${c.person.who.toLowerCase()}. The agent waits for them.` }];
  if (c.booked) {
    const ad = A.dayOf(c.booked.appt);
    if (!c.booked.reminded) add(ad - 1, 'Text an appointment reminder');
    add(ad, c.booked.kind === 'biopsy' ? 'Biopsy appointment' : 'Imaging appointment');
    return items;
  }
  if (s.awaitingResult) { add(s.awaitingResult.personDay, 'Hand to a navigator if the report still is not in'); return items; }
  if (s.kind === 'pathology') { add(s.personDay, 'Hand to a navigator if pathology still is not in'); return items; }
  if (s.kind === 'shortInterval') {
    const start = A.dayOf(s.outreachStart), due = A.dayOf(s.due);
    if (!s.replied) R.shortInterval.attempts.forEach((a, i) => { if (!s.sent[i]) add(a.fromStart !== undefined ? start + a.fromStart : due + a.fromDue, label[a.channel]); });
    else add(s.lastContact + R.shortInterval.nudgeEvery, 'Send a check-in text');
    add(A.dayOf(s.personDate), 'Hand to a navigator if still not booked');
  } else if (s.plan) {
    if (!s.replied) {
      s.plan.forEach(a => { if (!a.done) add(a.day, label[a.channel]); });
      add(Math.max(s.noAnswerDay, day), 'Hand to a navigator if she has not answered any of the three');
    } else add(s.lastContact + R.urgent.nudgeEvery, 'Send a check-in text');
    add(s.personDay, 'Hand to a navigator if still not booked');
  }
  return items.sort((a, b) => a.date.localeCompare(b.date)).slice(0, 4);
}

// Why a booking can't be recorded right now, or null if it can.
function bookingProblem(c, date, today) {
  if (!validDate(date)) return 'Choose a valid appointment date.';
  if (date <= today) return 'Choose a date after today. The agent sends a reminder the day before.';
  if (date > A.addMonths(today, 12)) return 'Choose a date within the next year.';
  if (!c || !c.started) return 'The first report has not been read yet.';
  if (c.closed) return 'This case is closed.';
  if (c.booked) return `She already has an appointment on ${A.fmt(c.booked.appt)}.`;
  if (!c.step || !OUTREACH_STEPS.includes(c.step.kind)) return 'There is nothing to book for this case right now.';
  if (c.step.awaitingResult) return 'Her appointment is done. The agent is waiting for the report.';
  if (c.person && c.person.kind !== 'exception') return `The ${c.person.who.toLowerCase()} has this case. Booking waits for their decision.`;
  return null;
}

// What the agent would do with one report on one day, starting from nothing. Uses the same engine as the workspace.
function decide(text, read, now) {
  const events = [], problems = checkReport(text, read, now);
  const engine = A.createEngine({ log: e => events.push(e), check: () => problems });
  const c = A.newCase({ id: 'decide', name: 'Patient', first: 'there' });
  const day = A.dayOf(now), doc = docFor({ id: 'report', text }, read);
  engine.onDoc(c, doc, read, day);
  engine.tick(c, day);
  const status = caseStatus(c, now), handoff = events.filter(e => e.kind === 'handoff').pop();
  const message = events.find(e => e.actor === 'agent' && ['text', 'portal', 'call'].includes(e.kind));
  return {
    status, pathway: problems.length ? 'review' : c.step ? c.step.kind : doc.kind === 'pathology' ? 'pathology' : null,
    due: c.step ? c.step.due || null : null,
    nextAction: status === 'waiting_reminder' ? c.step.outreachStart : status === 'awaiting_booking' ? now : null,
    handoff: handoffDate(c), problems,
    review: c.person ? (problems.length ? problems.join(' ') + ' ' : '') + handoff.text : null,
    message: message ? message.text : null, headsUp: events.some(e => e.kind === 'headsup')
  };
}

module.exports = { decide, checkReport, docFor, firstName, caseStatus, handoffDate, comingUp, bookingProblem, validDate, OUTREACH_STEPS };
