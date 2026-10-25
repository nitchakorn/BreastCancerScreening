const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const A = require('../agent/agent.js');

// The CMO view is built from the same simulation as the main page. These tests keep its numbers honest.
const cmo = require('../scripts/cmo.js');
const page = fs.readFileSync(path.join(__dirname, '../docs/cmo.html'), 'utf8');

test('the measure counts only abnormal results, and each has either a resolution day or is open', () => {
  for (const t of cmo.measure) {
    assert(['0', '4-5', 'unclear'].includes(t.cat), `${t.key} is in the measure with category ${t.cat}`);
    assert(t.resolvedDays === null || t.resolvedDays >= 0);
  }
  assert.equal(cmo.within.length, cmo.measure.filter(t => t.resolvedDays !== null && t.resolvedDays <= A.RULES.measureWindowDays).length);
});

test('the scorecard agrees with the simulation summary the main page prints', () => {
  // The same numbers scripts/check.js prints: 8 of 8 abnormal results within 60 days, median 10.
  const summary = fs.readFileSync(path.join(__dirname, 'fixtures/simulation.txt'), 'utf8');
  const m = summary.match(/resolved within 60 days: (\d+) of (\d+) \| days: ([\d, ]+) \| median: (\d+)/);
  assert(m, 'the simulation fixture has the 60-day summary line');
  assert.equal(cmo.within.length, Number(m[1]));
  assert.equal(cmo.measure.length, Number(m[2]));
  assert.equal(cmo.median, Number(m[4]));
  assert.deepEqual(cmo.measure.filter(t => t.resolvedDays !== null).map(t => t.resolvedDays).sort((a, b) => a - b), m[3].split(', ').map(Number));
});

test('the phases of each resolved case add up to its days to resolution', () => {
  for (const t of cmo.measure.filter(t => t.resolvedDays !== null)) {
    assert(t.phases, `${t.key} has phases`);
    assert.equal(t.phases.book + t.phases.wait + t.phases.result, t.resolvedDays, t.key);
  }
});

test('the built page carries the headline numbers and no unfilled value', () => {
  assert.match(page, new RegExp(`${cmo.within.length} of ${cmo.measure.length}`));
  assert.match(page, /CDC indicator/);
  assert.doesNotMatch(page, /undefined|NaN|\{\{/);
  assert.match(page, /href="\.\/"/);
  assert.match(page, /href="workspace\.html"/);
});

test('the safety catches name the mismatch that found a cancer and the held report that was corrected', () => {
  assert(cmo.catches.some(c => /Repeat biopsy found cancer/.test(c.what)));
  assert(cmo.catches.some(c => /Corrected to a recall/.test(c.what)));
});
