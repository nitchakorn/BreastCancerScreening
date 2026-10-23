// The ten-patient simulation must not change by accident. If you change the rules on purpose,
// run `node scripts/check.js > test/fixtures/simulation.txt` and review the difference.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

test('the simulation prints the same timelines and summary as the saved run', () => {
  const now = execFileSync(process.execPath, [path.join(__dirname, '../scripts/check.js')], { encoding: 'utf8' });
  assert.equal(now, fs.readFileSync(path.join(__dirname, 'fixtures/simulation.txt'), 'utf8'));
  assert.match(now, /abnormal results resolved within 60 days: 7 of 7 \| days: 5, 7, 8, 9, 11, 11, 11 \| median: 9\n/);
});
