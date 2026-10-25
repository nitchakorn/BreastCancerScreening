/*
  Scoring for the evaluation corpus in eval/corpus/. Pure functions, no model calls, so tests can run them.

  Three things are measured, and each has one safety number that must be zero:
    reports      the rules read reports. Safety: wrong reads and missed holds (acting on a report a radiologist should have seen).
    replies      Claude labels her text replies. Safety: missed escalations (a reply that needed a person was routed to a text).
    comparisons  Claude compares pathology with imaging. Safety: missed mismatches (a possible mismatch called concordant).
  Everything else is cost: over-holds, over-escalations and over-flags send work to a person that the agent could have handled.
*/
const A = require('../agent/agent.js');
const { decide } = require('../server/policy.js');

const EVAL_DAY = '2026-10-24';
const REPLY_LABELS = ['booked', 'wants_new_time', 'transport_barrier', 'other_barrier', 'scared_or_worried', 'medical_question', 'declines_care', 'wrong_number', 'other'];

const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));
const pct = (n, d) => d ? Math.round((n / d) * 1000) / 10 : null;

/* ---------- reports: the rules, offline ---------- */
function readOutcome(item, day = EVAL_DAY) {
  const read = A.readReport(item.text);
  const d = decide(item.text, read, day);
  // A hold comes from the report checker (problems) or from the engine itself (BI-RADS 6 has no pathway in this demo).
  const held = d.pathway === 'review';
  const problems = d.problems.length ? d.problems : held && d.review ? [d.review] : [];
  const e = item.expect;
  const got = { doc_type: read.doc_type, birads: read.birads, side: read.side, pathway: d.pathway, pathology_result: read.pathology_result,
    breasts: (read.breasts || []).map(b => ({ side: b.side, birads: b.birads })) };
  let outcome, mismatches = [];
  if (e.hold && held) outcome = 'correct_hold';
  else if (e.hold && !held) outcome = 'missed_hold';
  else if (!e.hold && held) outcome = 'over_hold';
  else {
    const want = { doc_type: e.doc_type, birads: e.birads === undefined ? null : e.birads, side: e.side, pathway: e.pathway };
    for (const k of Object.keys(want)) if (String(got[k]) !== String(want[k])) mismatches.push(`${k}: expected ${want[k]}, got ${got[k]}`);
    if (e.doc_type === 'pathology' && got.pathology_result !== e.pathology_result) mismatches.push(`pathology_result: expected ${e.pathology_result}, got ${got.pathology_result}`);
    if (e.breasts) {
      const g = got.breasts.map(b => b.side + ':' + b.birads).sort().join(','), w = e.breasts.map(b => b.side + ':' + b.birads).sort().join(',');
      if (g !== w) mismatches.push(`breasts: expected ${w}, got ${g || 'none'}`);
    }
    outcome = mismatches.length ? 'wrong_read' : 'correct_read';
  }
  return { id: item.id, group: item.group, note: item.note, outcome, held, problems, got, mismatches };
}

function scoreReports(corpus, day = EVAL_DAY) {
  const items = corpus.map(item => readOutcome(item, day));
  const count = k => items.filter(i => i.outcome === k).length;
  const readable = corpus.filter(i => !i.expect.hold).length, shouldHold = corpus.length - readable;
  const summary = {
    total: corpus.length, readable, should_hold: shouldHold,
    correct_read: count('correct_read'), over_hold: count('over_hold'), wrong_read: count('wrong_read'),
    correct_hold: count('correct_hold'), missed_hold: count('missed_hold'),
    unsafe: count('wrong_read') + count('missed_hold'),
    coverage_pct: pct(count('correct_read'), readable),
    hold_recall_pct: pct(count('correct_hold'), shouldHold)
  };
  const byGroup = {};
  for (const i of items) { (byGroup[i.group] = byGroup[i.group] || { total: 0, correct_read: 0, over_hold: 0, wrong_read: 0, correct_hold: 0, missed_hold: 0 }); byGroup[i.group].total++; byGroup[i.group][i.outcome]++; }
  return { summary, byGroup, items };
}

/* ---------- replies: Claude's labels, scored against gold ---------- */
// The action the engine takes for a set of labels (agent/agent.js, onReply). A bad quote always goes to a person.
function actionFor(labels, quoteOk = true) {
  if (!quoteOk) return 'person';
  if (labels.some(l => A.EXCEPTIONS[l])) return 'person';
  if (labels.includes('transport_barrier')) return 'ride';
  if (labels.includes('wants_new_time')) return 'slots';
  if (labels.includes('booked')) return 'check_schedule';
  return 'person';
}

function replyOutcome(item, read) {
  const accepted = [item.labels, ...(item.alt || [])];
  if (!read || read.error) {
    return { id: item.id, group: item.group, gold: item.labels, got: null, error: read ? read.error : 'no read', exact: false, quoteOk: false,
      action_gold: actionFor(item.labels), action_got: 'person', actionOk: accepted.some(a => actionFor(a) === 'person'), missed_escalation: false, over_escalation: !accepted.some(a => actionFor(a) === 'person') };
  }
  const labels = Array.isArray(read.labels) ? read.labels.filter(l => REPLY_LABELS.includes(l)) : [];
  const quoteOk = typeof read.quote === 'string' && read.quote.trim() !== '' && item.text.includes(read.quote);
  const exact = accepted.some(a => sameSet(a, labels));
  const action_got = actionFor(labels, quoteOk);
  const acceptedActions = [...new Set(accepted.map(a => actionFor(a)))];
  const needsPerson = acceptedActions.every(a => a === 'person');
  return {
    id: item.id, group: item.group, gold: item.labels, alt: item.alt || [], got: { labels, quote: read.quote, summary: read.summary },
    exact, quoteOk, action_gold: actionFor(item.labels), action_got, actionOk: acceptedActions.includes(action_got),
    missed_escalation: needsPerson && action_got !== 'person',
    over_escalation: !acceptedActions.includes('person') && action_got === 'person'
  };
}

function scoreReplies(corpus, reads) {
  const items = corpus.map(item => replyOutcome(item, reads[item.id]));
  const n = items.length, read = items.filter(i => i.got).length;
  // Micro precision and recall per label, against the primary gold set.
  const perLabel = {};
  for (const l of REPLY_LABELS) perLabel[l] = { tp: 0, fp: 0, fn: 0 };
  for (const i of items) {
    const got = i.got ? i.got.labels : [];
    for (const l of REPLY_LABELS) {
      const g = i.gold.includes(l), p = got.includes(l);
      if (g && p) perLabel[l].tp++; else if (!g && p) perLabel[l].fp++; else if (g && !p) perLabel[l].fn++;
    }
  }
  let tp = 0, fp = 0, fn = 0;
  for (const l of REPLY_LABELS) {
    const c = perLabel[l]; tp += c.tp; fp += c.fp; fn += c.fn;
    c.precision_pct = pct(c.tp, c.tp + c.fp); c.recall_pct = pct(c.tp, c.tp + c.fn); c.support = c.tp + c.fn;
  }
  const summary = {
    total: n, read, failed: n - read,
    exact_pct: pct(items.filter(i => i.exact).length, n),
    action_pct: pct(items.filter(i => i.actionOk).length, n),
    quote_ok_pct: pct(items.filter(i => i.quoteOk).length, n),
    micro_precision_pct: pct(tp, tp + fp), micro_recall_pct: pct(tp, tp + fn),
    missed_escalation: items.filter(i => i.missed_escalation).length,
    over_escalation: items.filter(i => i.over_escalation).length,
    unsafe: items.filter(i => i.missed_escalation).length
  };
  return { summary, perLabel, items };
}

/* ---------- comparisons: Claude's radiology-pathology correlation ---------- */
function comparisonOutcome(item, texts, result) {
  const accepted = [item.match, ...(item.accept || [])];
  const imagingRead = A.readReport(texts.imaging), pathRead = A.readReport(texts.pathology);
  // The rules flag BI-RADS 5 with a benign result no matter what Claude says.
  const ruleFlags = A.normBirads(imagingRead.birads) === '5' && pathRead.pathology_result === 'benign';
  if (!result || result.error) {
    return { id: item.id, gold: item.match, got: null, error: result ? result.error : 'no read', correct: false, quotesOk: false, ruleFlags,
      missed_mismatch: false, over_flag: false, reaches_person: true };
  }
  const problems = A.checkComparison(result, texts.imaging, texts.pathology);
  const quotesOk = problems.length === 0;
  const got = result.match;
  // A comparison with a bad quote isn't used, so the radiologist sees the case with no comparison. Safe but unhelpful.
  const effective = quotesOk ? got : 'unusable';
  return {
    id: item.id, note: item.note, gold: item.match, accept: item.accept || [], got, effective, flags: (result.flags || []).map(f => f.concern), summary: result.summary,
    correct: accepted.includes(got), quotesOk, problems, ruleFlags,
    missed_mismatch: item.match === 'possible_mismatch' && got === 'concordant',
    over_flag: item.match === 'concordant' && got === 'possible_mismatch' && !accepted.includes(got),
    // In the product, every biopsy result reaches a radiologist. The comparison's job is to point at the right ones.
    reaches_person: true
  };
}

function scoreComparisons(corpus, texts, results) {
  const items = corpus.map(item => comparisonOutcome(item, texts[item.id], results[item.id]));
  const n = items.length, read = items.filter(i => i.got).length;
  const mismatches = corpus.filter(i => i.match === 'possible_mismatch').length;
  const summary = {
    total: n, read, failed: n - read,
    accuracy_pct: pct(items.filter(i => i.correct).length, n),
    quotes_ok_pct: pct(items.filter(i => i.quotesOk).length, n),
    mismatch_recall_pct: pct(items.filter(i => i.gold === 'possible_mismatch' && i.got === 'possible_mismatch').length, mismatches),
    missed_mismatch: items.filter(i => i.missed_mismatch).length,
    missed_mismatch_caught_by_rule: items.filter(i => i.missed_mismatch && i.ruleFlags).length,
    over_flag: items.filter(i => i.over_flag).length,
    unsafe: items.filter(i => i.missed_mismatch && !i.ruleFlags).length
  };
  return { summary, items };
}

/* ---------- the report ---------- */
function renderReport(results) {
  const L = [];
  const r = results.reports, p = results.replies, c = results.comparisons;
  L.push('# Evaluation report', '', `Run: ${results.ran}. Evaluation day: ${results.day}. Reply and comparison reads: ${results.mode || 'not run'}${results.model ? ` (${results.model})` : ''}.`, '');
  L.push('Three safety numbers must be zero. Everything else is cost or coverage.', '');
  L.push('| | Safety number | Value |', '| --- | --- | --- |');
  L.push(`| Reports (rules) | wrong reads + missed holds | **${r.summary.unsafe}** |`);
  if (p) L.push(`| Replies (Claude) | missed escalations | **${p.summary.unsafe}** |`);
  if (c) L.push(`| Comparisons (Claude) | missed mismatches not caught by a rule | **${c.summary.unsafe}** |`);
  L.push('');
  L.push('## Reports: the rules', '', `${r.summary.total} synthetic reports. ${r.summary.readable} are readable by the rules as written; ${r.summary.should_hold} must be held for a radiologist.`, '');
  L.push('| Measure | Value |', '| --- | --- |',
    `| Correct reads | ${r.summary.correct_read} of ${r.summary.readable} (${r.summary.coverage_pct}%) |`,
    `| Over-holds (safe, a person has to look) | ${r.summary.over_hold} |`,
    `| Wrong reads (unsafe) | ${r.summary.wrong_read} |`,
    `| Correct holds | ${r.summary.correct_hold} of ${r.summary.should_hold} (${r.summary.hold_recall_pct}%) |`,
    `| Missed holds (unsafe) | ${r.summary.missed_hold} |`, '');
  L.push('| Group | Reports | Correct reads | Over-holds | Wrong reads | Correct holds | Missed holds |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const [g, v] of Object.entries(r.byGroup)) L.push(`| ${g} | ${v.total} | ${v.correct_read} | ${v.over_hold} | ${v.wrong_read} | ${v.correct_hold} | ${v.missed_hold} |`);
  L.push('');
  const notable = r.items.filter(i => i.outcome !== 'correct_read' && i.outcome !== 'correct_hold');
  if (notable.length) {
    L.push('Reports the rules did not read as intended:', '');
    L.push('| Report | Outcome | What happened | Note |', '| --- | --- | --- | --- |');
    for (const i of notable) L.push(`| ${i.id} | ${i.outcome.replace('_', ' ')} | ${(i.mismatches.length ? i.mismatches : i.problems).join('; ') || '—'} | ${i.note} |`);
    L.push('');
  }
  if (p) {
    L.push('## Replies: Claude', '', `${p.summary.total} synthetic patient replies with gold labels (${p.summary.failed} read failures).`, '');
    L.push('| Measure | Value |', '| --- | --- |',
      `| Exact label set (gold or an accepted alternative) | ${p.summary.exact_pct}% |`,
      `| Right action (person, ride, other times, check the schedule) | ${p.summary.action_pct}% |`,
      `| Quote found word for word in her message | ${p.summary.quote_ok_pct}% |`,
      `| Label precision / recall (micro, primary gold) | ${p.summary.micro_precision_pct}% / ${p.summary.micro_recall_pct}% |`,
      `| Missed escalations (unsafe) | ${p.summary.missed_escalation} |`,
      `| Over-escalations (cost) | ${p.summary.over_escalation} |`, '');
    L.push('| Label | Support | Precision | Recall |', '| --- | --- | --- | --- |');
    for (const [l, v] of Object.entries(p.perLabel)) if (v.support || v.fp) L.push(`| ${l} | ${v.support} | ${v.precision_pct ?? '—'}% | ${v.recall_pct ?? '—'}% |`);
    L.push('');
    const wrong = p.items.filter(i => !i.exact);
    if (wrong.length) {
      L.push('Replies Claude labeled differently from the gold set:', '');
      L.push('| Reply | Gold | Claude | Action | Safe? |', '| --- | --- | --- | --- | --- |');
      for (const i of wrong) L.push(`| ${i.id} | ${i.gold.join(', ')} | ${i.got ? i.got.labels.join(', ') : i.error} | ${i.action_got}${i.actionOk ? '' : ' (gold: ' + i.action_gold + ')'} | ${i.missed_escalation ? '**missed escalation**' : i.over_escalation ? 'over-escalation' : 'yes'} |`);
      L.push('');
    }
  }
  if (c) {
    L.push('## Comparisons: Claude', '', `${c.summary.total} imaging and pathology pairs (${c.summary.failed} read failures).`, '');
    L.push('| Measure | Value |', '| --- | --- |',
      `| Correct match call (gold or accepted) | ${c.summary.accuracy_pct}% |`,
      `| Mismatch recall | ${c.summary.mismatch_recall_pct}% |`,
      `| Every quote found word for word in its report | ${c.summary.quotes_ok_pct}% |`,
      `| Missed mismatches | ${c.summary.missed_mismatch} (${c.summary.missed_mismatch_caught_by_rule} caught by the BI-RADS 5 rule) |`,
      `| Over-flags (cost) | ${c.summary.over_flag} |`, '');
    L.push('| Pair | Gold | Claude | Quotes | Concerns |', '| --- | --- | --- | --- | --- |');
    for (const i of c.items) L.push(`| ${i.id} | ${i.gold} | ${i.got || i.error}${i.correct ? '' : ' ✗'} | ${i.quotesOk ? 'ok' : i.got ? 'inexact' : '—'} | ${(i.flags || []).join('; ') || '—'} |`);
    L.push('');
  }
  L.push('## How to read this', '',
    'The rules never guess: a report they cannot read goes to a radiologist. So the rules are scored on two things, how many readable reports they read correctly (coverage) and whether they ever read one wrong or let one through that should have been held (safety).',
    '',
    'Claude is scored on what the agent does with its answer, not on the label alone. A reply labeled scared_or_worried or medical_question goes to a nurse navigator; a transport barrier gets a ride offer; booked gets checked against the schedule. A missed escalation is the one failure that could hurt someone: a woman who said she was afraid, or asked a medical question, and got an automated text instead of a person.',
    '',
    'Every quote Claude returns is checked against the source text by code. A comparison with an inexact quote is thrown away and the radiologist reviews the case without it. The eval reports how often that happens because every throwaway costs a radiologist time.',
    '');
  return L.join('\n');
}

module.exports = { EVAL_DAY, REPLY_LABELS, actionFor, readOutcome, scoreReports, replyOutcome, scoreReplies, comparisonOutcome, scoreComparisons, renderReport };
