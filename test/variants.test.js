const { test } = require('node:test');
const assert = require('node:assert/strict');
const A = require('../agent/agent.js');
const { decide, checkReport } = require('../server/policy.js');

// The evaluation corpus (eval/) found three report variants the rules held for a radiologist although they were readable.
// These tests keep them readable, and keep the edges of the widened rules where they are.
const today = '2026-10-24';
const report = (impression, date = '09/22/2026') =>
  `EXAM: Diagnostic mammogram, right breast. Targeted right breast ultrasound.\nDATE: ${date}\nINDICATION: Palpable right breast lump.\nFINDINGS: At right breast 2 o'clock there is a 1.3 cm irregular hypoechoic mass with indistinct margins.\nIMPRESSION: Suspicious right breast mass. ${impression}\nRECOMMENDATION: Ultrasound-guided core needle biopsy of the right breast mass.`;

for (const [name, impression, birads] of [
  ['no hyphen', 'BIRADS 4B: Moderate suspicion for malignancy.', '4B'],
  ['a space instead of a hyphen', 'BI RADS 4B: Moderate suspicion for malignancy.', '4B'],
  ['the registered mark and the word Category', 'ACR BI-RADS® Category 4B: Moderate suspicion for malignancy.', '4B'],
  ['the word category with a colon', 'BI-RADS category: 4B, moderate suspicion.', '4B'],
  ['the usual form', 'BI-RADS 4B: Moderate suspicion for malignancy.', '4B']
]) test(`the rules read the category written with ${name}, and the checker accepts the quote`, () => {
  const text = report(impression);
  const read = A.readReport(text);
  assert.equal(read.birads, birads);
  assert.deepEqual(read.unclear, []);
  assert.deepEqual(checkReport(text, read, today), []);
  assert.equal(decide(text, read, today).pathway, 'biopsy');
});

test('the rules read a date without leading zeros, and the checker accepts its quote', () => {
  const text = report('BI-RADS 4B: Moderate suspicion for malignancy.', '9/8/2026');
  const read = A.readReport(text);
  assert.equal(read.exam_date, '2026-09-08');
  assert.deepEqual(checkReport(text, read, today), []);
});

test('a two-digit year is still not a date the rules will read', () => {
  const text = report('BI-RADS 4B: Moderate suspicion for malignancy.', '9/8/26');
  const read = A.readReport(text);
  assert.equal(read.exam_date, null);
  assert.equal(decide(text, read, today).pathway, 'review');
});

test('an impression with no recognizable category is still held', () => {
  const text = report('Highly suspicious right breast mass, biopsy advised.');
  const read = A.readReport(text);
  assert.equal(read.birads, null);
  assert.equal(decide(text, read, today).pathway, 'review');
});

test('the reader and the checker share one category pattern', () => {
  assert.equal(typeof A.CATEGORY_PATTERN, 'string');
  const re = new RegExp(A.CATEGORY_PATTERN, 'i');
  for (const q of ['BI-RADS 4B', 'BIRADS 4B', 'BI RADS 4B', 'BI-RADS® Category 4B', 'BI-RADS category: 4B']) assert.equal(q.match(re)[1], '4B', q);
  assert.equal('BI-RADS 4'.match(re)[1], '4');
  assert.equal('BIRAD 4'.match(re), null);
});
