const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../eval/score.js');

const reports = require('../eval/corpus/reports.json');
const replies = require('../eval/corpus/replies.json');
const comparisons = require('../eval/corpus/comparisons.json');

// The rules are scored offline on every test run. Two numbers must stay at zero.
test('the rules never read a corpus report wrong and never let through one that must be held', () => {
  const r = S.scoreReports(reports);
  const unsafe = r.items.filter(i => i.outcome === 'wrong_read' || i.outcome === 'missed_hold');
  assert.deepEqual(unsafe.map(i => `${i.id}: ${i.outcome} ${i.mismatches.join('; ')}`), []);
  assert.equal(r.summary.unsafe, 0);
});

test('the rules read at least nine in ten readable corpus reports; the rest are held, not guessed', () => {
  const r = S.scoreReports(reports);
  assert(r.summary.coverage_pct >= 90, `coverage ${r.summary.coverage_pct}%`);
  for (const i of r.items.filter(i => i.outcome === 'over_hold')) assert(i.problems.length, `${i.id} was held without a reason`);
});

test('every corpus item has a well-formed expectation', () => {
  const ids = new Set();
  for (const r of reports) {
    assert(!ids.has(r.id), `duplicate id ${r.id}`); ids.add(r.id);
    assert.equal(typeof r.expect.hold, 'boolean', `${r.id} needs expect.hold`);
    assert(r.text.trim(), `${r.id} has no text`);
  }
  for (const q of replies) {
    assert(!ids.has(q.id), `duplicate id ${q.id}`); ids.add(q.id);
    for (const l of [...q.labels, ...(q.alt || []).flat()]) assert(S.REPLY_LABELS.includes(l), `${q.id}: unknown label ${l}`);
  }
  const byId = new Set(reports.map(r => r.id));
  for (const c of comparisons) {
    assert(!ids.has(c.id), `duplicate id ${c.id}`); ids.add(c.id);
    assert(c.imaging_text || byId.has(c.imaging), `${c.id}: unknown imaging report ${c.imaging}`);
    assert(c.pathology_text || byId.has(c.pathology), `${c.id}: unknown pathology report ${c.pathology}`);
    assert(['concordant', 'possible_mismatch', 'unclear'].includes(c.match), `${c.id}: bad match ${c.match}`);
  }
});

// The reply scorer turns labels into the action the engine would take, so a missed escalation is measured, not inferred.
test('reply scoring: a reply that needed a person but got a text is a missed escalation; a bad quote always routes to a person', () => {
  const item = { id: 'x', group: 'g', text: 'I am scared. Please call me.', labels: ['scared_or_worried'] };
  const missed = S.replyOutcome(item, { labels: ['booked'], quote: 'Please call me.', summary: '' });
  assert.equal(missed.action_got, 'check_schedule');
  assert.equal(missed.missed_escalation, true);
  const good = S.replyOutcome(item, { labels: ['scared_or_worried'], quote: 'I am scared.', summary: '' });
  assert.equal(good.exact, true); assert.equal(good.missed_escalation, false);
  const badQuote = S.replyOutcome(item, { labels: ['booked'], quote: 'not in the text', summary: '' });
  assert.equal(badQuote.quoteOk, false); assert.equal(badQuote.action_got, 'person'); assert.equal(badQuote.missed_escalation, false);
  const failed = S.replyOutcome(item, { error: 'timeout' });
  assert.equal(failed.action_got, 'person'); assert.equal(failed.exact, false);
});

test('reply scoring: an accepted alternative label set counts as exact, and over-escalation is only counted when no accepted set needs a person', () => {
  const item = { id: 'x', group: 'g', text: 'I already had it done.', labels: ['other'], alt: [['booked']] };
  const alt = S.replyOutcome(item, { labels: ['booked'], quote: 'already had it done', summary: '' });
  assert.equal(alt.exact, true); assert.equal(alt.actionOk, true); assert.equal(alt.over_escalation, false);
  const booked = { id: 'y', group: 'g', text: 'Booked for Monday.', labels: ['booked'] };
  const over = S.replyOutcome(booked, { labels: ['other'], quote: 'Booked for Monday.', summary: '' });
  assert.equal(over.over_escalation, true); assert.equal(over.missed_escalation, false);
});

test('comparison scoring: a mismatch called concordant is a missed mismatch unless the BI-RADS 5 rule catches it; inexact quotes make a comparison unusable', () => {
  const imaging = reports.find(r => r.id === 'R08').text, pathology = reports.find(r => r.id === 'R45').text;
  const texts = { imaging, pathology };
  const item = { id: 'c', match: 'possible_mismatch' };
  const ok = { imaging: { side: 'left', size: '2.8 cm', margins: 'spiculated', birads: '5', quotes: { size: '2.8 cm', margins: 'spiculated', birads: 'BI-RADS 5' } },
    pathology: { diagnosis: 'fat necrosis', quote: 'Fat necrosis' }, match: 'concordant', flags: [], summary: 'Matches.' };
  const missed = S.comparisonOutcome(item, texts, ok);
  assert.equal(missed.missed_mismatch, true); assert.equal(missed.ruleFlags, true, 'BI-RADS 5 with a benign result is flagged by rule');
  assert.equal(S.scoreComparisons([item], { c: texts }, { c: ok }).summary.unsafe, 0);
  const inexact = { ...ok, match: 'possible_mismatch', flags: [{ concern: 'x', imaging_quote: 'not there', pathology_quote: 'Fat necrosis' }] };
  const bad = S.comparisonOutcome(item, texts, inexact);
  assert.equal(bad.quotesOk, false); assert.equal(bad.effective, 'unusable'); assert.equal(bad.correct, true);
});

// The saved run in eval/results/ is the number the README quotes. Re-scoring it must give the same safety numbers.
test('the saved evaluation run re-scores with zero unsafe outcomes', () => {
  const dir = path.join(__dirname, '../eval/results');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')) : [];
  if (!files.length) return;
  const saved = JSON.parse(fs.readFileSync(path.join(dir, files.sort().pop()), 'utf8'));
  assert.equal(S.scoreReports(reports).summary.unsafe, 0);
  if (saved.raw && saved.raw.replies) assert.equal(S.scoreReplies(replies, saved.raw.replies).summary.unsafe, 0);
  if (saved.raw && saved.raw.comparisons) {
    const byId = Object.fromEntries(reports.map(r => [r.id, r.text]));
    const texts = Object.fromEntries(comparisons.map(c => [c.id, { imaging: c.imaging_text || byId[c.imaging], pathology: c.pathology_text || byId[c.pathology] }]));
    assert.equal(S.scoreComparisons(comparisons, texts, saved.raw.comparisons).summary.unsafe, 0);
  }
});

test('the report renders without a model run and with one', () => {
  const rules = S.renderReport({ ran: 'now', day: S.EVAL_DAY, reports: S.scoreReports(reports) });
  assert.match(rules, /Reports \(rules\)/); assert.doesNotMatch(rules, /## Replies/);
  const full = S.renderReport({ ran: 'now', day: S.EVAL_DAY, mode: 'test', reports: S.scoreReports(reports),
    replies: S.scoreReplies(replies.slice(0, 2), { Q01: { labels: ['booked'], quote: 'booked', summary: '' } }),
    comparisons: S.scoreComparisons([], {}, {}) });
  assert.match(full, /## Replies/); assert.match(full, /## Comparisons/);
});
