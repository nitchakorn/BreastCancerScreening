const A = require('../agent/agent.js');

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T12:00:00Z');
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function decide(text, read, now) {
  const problems = [];
  const hold = () => ({ status: 'needs_review', pathway: 'review', due: null, nextAction: null, problems, review: problems.join(' '), message: null });
  if (!read || typeof read !== 'object' || Array.isArray(read)) {
    problems.push('No usable structured report was returned.'); return hold();
  }
  if (!['screening', 'diagnostic', 'ultrasound', 'addendum', 'pathology'].includes(read.doc_type)) problems.push('Document type is missing or unsupported.');
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
  if (problems.length) return hold();
  if (read.doc_type === 'pathology') {
    // These results always enter the human queue; the agent never communicates a result to a patient.
    problems.push(read.pathology_result === 'malignant' ? 'Pathology requires handoff to breast surgery and the ordering clinician.'
      : read.pathology_result === 'benign' ? 'A radiologist must confirm imaging–pathology concordance before closure.'
      : 'A radiologist must decide the next step for this pathology result.');
    return hold();
  }
  const category = A.normBirads(read.birads), pathway = A.pathwayFor(category), exam = read.exam_date;
  if (!pathway) { problems.push('This BI-RADS category has no automated pathway.'); return hold(); }
  if (pathway === 'routine') return { status: 'closed', pathway, due: A.addMonths(exam, 12), nextAction: null, problems, review: null, message: null };
  const due = pathway === 'shortInterval' ? A.addMonths(exam, 6) : A.addDays(exam, 14);
  const personDate = pathway === 'shortInterval' ? A.addMonths(due, 1) : A.addDays(exam, pathway === 'biopsy' ? 7 : 30);
  if (now >= personDate) {
    problems.push('The report is already beyond the unbooked handoff threshold. Navigator review is required.');
    return { ...hold(), pathway, due };
  }
  const nextAction = pathway === 'shortInterval' ? A.addMonths(due, -1) : now;
  return {
    status: nextAction > now ? 'waiting_reminder' : 'awaiting_booking', pathway, due, nextAction,
    problems, review: null, headsUp: category === '5',
    message: nextAction > now ? null : pathway === 'biopsy'
      ? 'Your care team asked us to help schedule the follow-up appointment they discussed with you. Use the test booking inbox or ask for help.'
      : pathway === 'shortInterval'
        ? `Your six-month follow-up imaging is due ${due}. Use the test booking inbox or ask for help.`
        : 'Your care team would like you to return for more imaging. Use the test booking inbox or ask for help.'
  };
}

module.exports = { decide, validDate };
