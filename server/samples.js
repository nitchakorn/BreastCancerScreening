const A = require('../agent/agent.js');
const documents = require('../data/documents.json');
const reads = require('../reads/documents.json');
// Replies from the simulation, plus extra workspace samples that cover every reply rule.
const replies = [...require('../data/replies.json'), ...require('../data/sample-replies.json')];
const replyReads = { ...require('../reads/replies.json'), ...require('../reads/sample-replies.json') };
const patients = require('../data/patients.json');

// Reports that start a case. The exam date moves to today.
const STARTERS = [
  ['P2-screen', 'Diagnostic imaging'], ['P1-screen', 'Routine screening'], ['P7-dx', 'Biopsy pathway'], ['P9-screen', 'Conflicting findings'],
  ['P5-apr', 'Six-month follow-up'], ['P8-dx', 'BI-RADS 5 heads-up'], ['P7-path', 'Benign pathology review'], ['P8-path', 'Malignant pathology handoff'],
  ['P10-dx', 'Both breasts: biopsy right, 6 months left']
];
// Reports that continue a case: results, a corrected report, pathology.
const NEXT = [
  ['P2-dx', 'Diagnostic result: benign (BI-RADS 2)'], ['P9-dx', 'Diagnostic result: negative (BI-RADS 1)'],
  ['P7-dx', 'Diagnostic result: suspicious, biopsy needed (BI-RADS 4B)'], ['P9-addendum', 'Radiologist addendum: corrected to BI-RADS 0'],
  ['P5-6mo', 'Six-month result: stable (BI-RADS 3)'], ['P7-path', 'Pathology: benign fibroadenoma'], ['P8-path', 'Pathology: invasive cancer'],
  ['P10-path', 'Pathology: benign fibroadenoma, right breast']
];
const REPLIES = [
  ['P3-r1', 'Has no ride'], ['P2-r1', 'Says she booked'], ['P7-r1', 'Scared, asks for a call'], ['S-time', 'Wants another day'],
  ['S-question', 'Asks a medical question'], ['S-decline', 'Turns down the test'], ['S-wrong', 'Wrong number'],
  ['S-childcare', 'No one to watch her kids'], ['S-work', 'Can’t come because of work'], ['S-unclear', 'Just says “ok”'],
  ['P3-r2', 'Ride works, booked'], ['P8-r1', 'Booked Monday morning']
];

const US = /\b(\d{2})\/(\d{2})\/(\d{4})\b/g;
const toUs = iso => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
const toIso = us => `${us.slice(6, 10)}-${us.slice(0, 2)}-${us.slice(3, 5)}`;
const shift = (us, days) => toUs(A.addDays(toIso(us), days));
const between = (from, to) => A.dayOf(to) - A.dayOf(from);
const clean = text => String(text).replace(/\r\n?/g, '\n').trim();
const doc = id => documents.find(d => d.id === id);
const firstExamOf = patientId => reads[patients.find(p => p.id === patientId).first_doc].exam_date;

function examples(today) {
  return STARTERS.map(([id, label]) => {
    const days = between(reads[id].exam_date, today);
    return { id, label, text: doc(id).text.replace(US, m => shift(m, days)) };
  });
}

// Follow-up reports dated for one case: its own date is today (pathology: the biopsy day),
// and any mention of the earlier exam points at this case's first exam.
function nextReports(today, anchors = {}) {
  return NEXT.map(([id, label]) => {
    const d = doc(id), pathology = d.kind === 'pathology';
    const own = pathology ? reads[id].exam_date : d.date, target = pathology ? (anchors.biopsy || today) : today;
    const days = between(own, target), earlier = toUs(firstExamOf(d.patient));
    const text = d.text.replace(US, m => m === toUs(own) ? toUs(target) : m === earlier && anchors.firstExam ? toUs(anchors.firstExam) : shift(m, days));
    return { id, label, text };
  });
}

function sampleReplies() {
  return REPLIES.map(([id, label]) => ({ id, label, text: replies.find(r => r.id === id).text }));
}

// Recorded mode: recognize a bundled report even after its dates moved, and move the dates in its recorded read the same way.
function recordedRead(text) {
  const given = clean(text), shape = t => clean(t).replace(US, '<date>');
  const d = documents.find(item => shape(item.text) === shape(given));
  if (!d) return null;
  const from = clean(d.text).match(US) || [], to = given.match(US) || [], map = new Map();
  for (let i = 0; i < from.length; i++) {
    if (map.has(from[i]) && map.get(from[i]) !== to[i]) return null;
    map.set(from[i], to[i]);
  }
  const move = s => typeof s === 'string' ? s.replace(US, m => map.get(m) || m) : s;
  const read = structuredClone(reads[d.id]);
  if (read.exam_date) read.exam_date = toIso(move(toUs(read.exam_date)));
  for (const key of Object.keys(read.quotes || {})) read.quotes[key] = move(read.quotes[key]);
  for (const b of read.breasts || []) for (const key of Object.keys(b.quotes || {})) b.quotes[key] = move(b.quotes[key]);
  read.mismatch_quote = move(read.mismatch_quote);
  return read;
}

function recordedReply(text) {
  const given = clean(text), r = replies.find(item => clean(item.text) === given);
  return r ? structuredClone(replyReads[r.id]) : null;
}

module.exports = { examples, nextReports, sampleReplies, recordedRead, recordedReply };
