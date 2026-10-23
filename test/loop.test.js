// The full follow-up loop in the workspace: outreach, replies, bookings, results and people.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const A = require('../agent/agent.js');
const { createApp } = require('../server/app.js');
const { createReader } = require('../server/reader.js');
const { sampleReplies } = require('../server/samples.js');

const START = '2026-10-23';
const reply = id => sampleReplies().find(r => r.id === id).text;

async function workspace(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'screening-loop-'));
  let base = START;
  const app = createApp({ dbPath: path.join(dir, 'cases.sqlite'), reader: createReader({ env: { READER_MODE: 'recorded' } }), clock: () => `${base}T16:00:00.000Z` });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const call = async (method, route, body) => {
    const response = await fetch(url + route, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const drain = async () => { for (let i = 0; i < 20 && (i === 0 || app.store.pending()); i++) await app.runOnce(); };
  const w = {
    app, call, drain,
    today: () => app.clock().today,
    async start(label, sampleId) {
      const sample = (await call('GET', '/api/examples')).body.find(s => s.id === sampleId);
      const saved = await call('POST', '/api/cases', { patient: label, report: sample.text });
      assert.equal(saved.status, 202);
      await drain();
      return saved.body.case.id;
    },
    get: async id => (await call('GET', `/api/cases/${id}`)).body.case,
    async next(id, sampleId) {
      const sample = (await call('GET', `/api/cases/${id}/examples`)).body.reports.find(s => s.id === sampleId);
      const saved = await call('POST', `/api/cases/${id}/reports`, { report: sample.text });
      assert.equal(saved.status, 202, JSON.stringify(saved.body));
      await drain();
      return w.get(id);
    },
    async reply(id, text) { assert.equal((await call('POST', `/api/cases/${id}/replies`, { text })).status, 202); await drain(); return w.get(id); },
    async book(id, days, by = 'patient') { return call('POST', `/api/cases/${id}/bookings`, { date: A.addDays(w.today(), days), by }); },
    async forward(days) { const r = await call('POST', '/api/clock', { days }); assert.equal(r.status, 200); await drain(); return r.body; },
    async act(id, kind, action, note) {
      const item = await w.get(id), review = item.reviews.find(r => r.kind === kind && r.status === 'open');
      assert(review, `an open ${kind} review`);
      return call('POST', `/api/cases/${id}/reviews/${review.id}`, { action, note });
    }
  };
  return w;
}
const channels = item => item.messages.map(m => [m.createdAt.slice(0, 10), m.channel]);

test('no answer: a text, a portal message on day 2, an automated call on day 4, then a navigator on day 5', async t => {
  const w = await workspace(t);
  const id = await w.start('Denise W.', 'P2-screen');
  let item = await w.get(id);
  assert.match(item.messages[0].body, /^Hi Denise, this is Riverside Breast Center/);
  assert.deepEqual(item.agent.coming.map(c => c.date), ['2026-10-25', '2026-10-27', '2026-10-28', '2026-11-22']);
  await w.forward(4);
  item = await w.get(id);
  assert.equal(item.status, 'awaiting_booking');
  assert.deepEqual(channels(item), [['2026-10-23', 'text'], ['2026-10-25', 'portal'], ['2026-10-27', 'call']]);
  await w.forward(1);
  item = await w.get(id);
  assert.equal(item.status, 'needs_review');
  assert.equal(item.reviews[0].kind, 'exception');
  assert.match(item.reviews[0].reason, /No answer after three tries/);
  await w.forward(7);
  assert.equal((await w.get(id)).messages.length, 3, 'the agent stops while a person has the case');
});

test('moving the clock a week at once runs each day in order', async t => {
  const w = await workspace(t);
  const id = await w.start('Denise W.', 'P2-screen');
  await w.forward(7);
  const item = await w.get(id);
  assert.deepEqual(channels(item), [['2026-10-23', 'text'], ['2026-10-25', 'portal'], ['2026-10-27', 'call']]);
  assert.equal(item.reviews[0].createdAt.slice(0, 10), '2026-10-28');
});

test('no ride gets the free ride option; a scared reply goes straight to a navigator', async t => {
  const w = await workspace(t);
  const ride = await w.start('Marisol V.', 'P2-screen');
  await w.forward(1);
  let item = await w.reply(ride, reply('P3-r1'));
  assert.match(item.messages.at(-1).body, /free ride/);
  assert.deepEqual(item.replies[0].read.labels, ['transport_barrier']);
  assert.equal(item.status, 'awaiting_booking');

  const scared = await w.start('Priya S.', 'P7-dx');
  item = await w.reply(scared, reply('P7-r1'));
  assert.equal(item.status, 'needs_review');
  assert.match(item.reviews.find(r => r.kind === 'exception').reason, /scared or worried/);
  const sent = item.messages.length;
  await w.forward(4);
  assert.equal((await w.get(scared)).messages.length, sent);
});

test('she says she booked but the schedule is empty: check-ins every 3 days, then a navigator on day 7', async t => {
  const w = await workspace(t);
  const id = await w.start('Helen M.', 'P7-dx');
  await w.forward(1);
  let item = await w.reply(id, reply('P8-r1'));
  assert(item.events.some(e => e.kind === 'note' && /checks the schedule/.test(e.detail)));
  assert.equal(item.status, 'awaiting_booking');
  await w.forward(6);
  item = await w.get(id);
  assert.deepEqual(channels(item), [['2026-10-23', 'text'], ['2026-10-27', 'text'], ['2026-10-30', 'text']]);
  assert.equal(item.status, 'needs_review');
  assert.match(item.reviews.find(r => r.status === 'open').reason, /Not booked within 7 days/);
});

test('booked imaging: a reminder the day before, the appointment, then the result closes the loop', async t => {
  const w = await workspace(t);
  const id = await w.start('Grace T.', 'P2-screen');
  await w.forward(1);
  const booked = await w.book(id, 3);
  assert.equal(booked.status, 200);
  assert.equal(booked.body.case.status, 'booked');
  assert.match(booked.body.case.events.at(-1).detail, /Checked the schedule: imaging booked for Tue Oct 27, 2026/);
  await w.forward(2);
  let item = await w.get(id);
  assert.match(item.messages.at(-1).body, /^Reminder: your appointment .* is tomorrow, Tue Oct 27/);
  assert.equal(item.messages.length, 2, 'no portal message or call once she is booked');
  await w.forward(1);
  item = await w.get(id);
  assert.equal(item.status, 'awaiting_result');
  item = await w.next(id, 'P2-dx');
  assert.equal(item.status, 'closed');
  assert.match(item.agent.outcome, /Resolved as BI-RADS 2/);
  assert.equal(item.agent.resolvedDays, 4);
  assert.equal(item.reports.length, 2);
  assert(item.reports[1].text.includes('Recall from screening 10/23/2026'));
});

test('no report 3 days after an imaging appointment: a navigator checks', async t => {
  const w = await workspace(t);
  const id = await w.start('Grace T.', 'P2-screen');
  await w.book(id, 2);
  await w.forward(2);
  assert.equal((await w.get(id)).status, 'awaiting_result');
  await w.forward(3);
  const item = await w.get(id);
  assert.equal(item.status, 'needs_review');
  assert.match(item.reviews[0].reason, /No report 3 days after the appointment/);
});

test('biopsy, then a benign result waits for a radiologist to confirm it matches the imaging', async t => {
  const w = await workspace(t);
  const id = await w.start('Priya S.', 'P7-dx');
  assert((await w.get(id)).events.some(e => e.kind === 'pcp'));
  await w.book(id, 3);
  await w.forward(3);
  let item = await w.get(id);
  assert.equal(item.status, 'awaiting_result');
  assert.equal(item.agent.due, '2026-11-05');
  await w.forward(2);
  item = await w.next(id, 'P7-path');
  assert(item.reports[1].text.includes('PROCEDURE DATE: 10/26/2026'), 'pathology is dated on the biopsy day');
  assert.equal(item.status, 'needs_review');
  assert.equal(item.reviews.find(r => r.status === 'open').kind, 'concordance');
  assert.equal((await w.act(id, 'concordance', 'resume')).status, 409);
  const done = await w.act(id, 'concordance', 'concordant');
  assert.equal(done.status, 200);
  item = done.body.case;
  assert.equal(item.status, 'closed');
  assert.match(item.agent.outcome, /Benign and concordant/);
  assert.equal(item.reviews.find(r => r.kind === 'concordance').resolution, 'Concordance confirmed');
  assert.equal(item.agent.resolvedDays, 5);
});

test('cancer on pathology: the PCP is told, breast surgery takes over, and the patient gets no result from the agent', async t => {
  const w = await workspace(t);
  const id = await w.start('Helen M.', 'P8-dx');
  let item = await w.get(id);
  assert.equal(item.reviews[0].kind, 'heads_up');
  await w.book(id, 2);
  await w.forward(2);
  item = await w.next(id, 'P8-path');
  assert.equal(item.status, 'closed');
  assert.match(item.agent.outcome, /handed to breast surgery/);
  assert.deepEqual(item.reviews.map(r => [r.kind, r.status]), [['heads_up', 'fyi'], ['surgery', 'fyi']]);
  assert(item.messages.every(m => !/carcinoma|cancer|malignan|patholog/i.test(m.body)));
  assert.equal(item.events.filter(e => e.kind === 'pcp').length, 2);
});

test('no pathology 10 days after the biopsy: a navigator investigates', async t => {
  const w = await workspace(t);
  const id = await w.start('Priya S.', 'P7-dx');
  await w.book(id, 1);
  await w.forward(10);
  assert.equal((await w.get(id)).status, 'awaiting_result');
  await w.forward(1);
  const item = await w.get(id);
  assert.equal(item.status, 'needs_review');
  assert.match(item.reviews[0].reason, /No pathology result 10 days after the biopsy/);
});

test('a held report picks back up when the radiologist addendum passes the checks', async t => {
  const w = await workspace(t);
  const id = await w.start('Rosa D.', 'P9-screen');
  let item = await w.get(id);
  assert.equal(item.status, 'needs_review');
  assert.equal(item.messages.length, 0);
  assert.equal((await w.book(id, 3)).status, 409, 'no booking while a radiologist holds it');
  await w.forward(1);
  item = await w.next(id, 'P9-addendum');
  assert(item.reports[1].text.includes('ADDENDUM to the screening mammogram of 10/23/2026'));
  assert.equal(item.status, 'awaiting_booking');
  assert.equal(item.agent.due, '2026-11-06', 'due 14 days after the original exam');
  assert(item.events.some(e => /correction passed the checks/.test(e.detail)));
  assert.equal(item.reviews[0].status, 'done');
  assert.equal(item.messages.length, 1);
});

test('a navigator can book for her, hand the case back, or close it with a note', async t => {
  const w = await workspace(t);
  const noAnswer = await w.start('Denise W.', 'P2-screen');
  await w.forward(5);
  assert.equal((await w.get(noAnswer)).status, 'needs_review');
  const booked = await w.book(noAnswer, 5, 'navigator');
  assert.equal(booked.status, 200);
  assert.equal(booked.body.case.status, 'booked');
  assert.equal(booked.body.case.reviews[0].resolution, 'The navigator booked her');
  assert(booked.body.case.events.some(e => e.actor === 'person' && /Booked her imaging/.test(e.detail)));

  const scared = await w.start('Priya S.', 'P7-dx');
  await w.reply(scared, reply('P7-r1'));
  const back = await w.act(scared, 'exception', 'resume', 'Called her. She feels better and will book.');
  assert.equal(back.status, 200);
  assert.equal(back.body.case.status, 'awaiting_booking');
  await w.forward(3);
  assert.match((await w.get(scared)).messages.at(-1).body, /checking in/);

  const declines = await w.start('Ana R.', 'P2-screen');
  await w.forward(5);
  assert.equal((await w.act(declines, 'exception', 'close', '')).status, 400);
  const closed = await w.act(declines, 'exception', 'close', 'She is getting care at another hospital.');
  assert.equal(closed.body.case.status, 'closed');
  assert.equal(closed.body.case.agent.closedBy, 'Nurse navigator');
  assert.equal(closed.body.case.agent.resolvedDays, null, 'a person closing the case is not counted as resolved');
});

test('closed cases refuse new input; bookings must be after today', async t => {
  const w = await workspace(t);
  const routine = await w.start('Ana R.', 'P1-screen');
  assert.equal((await w.get(routine)).status, 'closed');
  assert.equal((await w.call('POST', `/api/cases/${routine}/replies`, { text: 'Hello?' })).status, 409);
  assert.equal((await w.call('POST', `/api/cases/${routine}/reports`, { report: 'x'.repeat(40) })).status, 409);
  assert.equal((await w.book(routine, 3)).status, 409);
  const open = await w.start('Grace T.', 'P2-screen');
  assert.match((await w.book(open, 0)).body.error, /after today/);
  assert.match((await w.call('POST', `/api/cases/${open}/bookings`, { date: '2026-02-30' })).body.error, /valid/);
  assert.equal((await w.call('POST', `/api/cases/${open}/replies`, { text: '' })).status, 400);
});

test('recorded mode reads only bundled replies, and a reply it cannot read fails without guessing', async t => {
  const w = await workspace(t);
  const id = await w.start('Grace T.', 'P2-screen');
  await w.call('POST', `/api/cases/${id}/replies`, { text: 'Can I come next week instead?' });
  await w.drain();
  const item = await w.get(id);
  assert.equal(item.replies[0].status, 'read_failed');
  assert.match(item.replies[0].problems[0], /Recorded mode recognizes only the bundled sample replies/);
  assert.equal(item.status, 'awaiting_booking', 'the case keeps going while the reply waits for a retry');
});

test('the demo clock moves forward only, and start over clears everything', async t => {
  const w = await workspace(t);
  await w.start('Grace T.', 'P2-screen');
  assert.equal((await w.call('POST', '/api/clock', { days: 0 })).status, 400);
  assert.equal((await w.call('POST', '/api/clock', { days: 61 })).status, 400);
  assert.equal((await w.forward(3)).today, '2026-10-26');
  assert.equal((await w.call('POST', '/api/reset', {})).status, 400);
  const reset = await w.call('POST', '/api/reset', { confirm: 'start over' });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.clock.today, START);
  assert.equal((await w.call('GET', '/api/cases')).body.cases.length, 0);
});

test('every reply rule is covered by a recorded sample: slots, and a person for questions, refusals, wrong numbers and barriers', async t => {
  const w = await workspace(t);
  const expected = { 'S-time': 'slots', 'S-question': 'medical question', 'S-decline': 'turned down care', 'S-wrong': 'wrong person',
    'S-childcare': "barrier the agent can't solve", 'S-work': "barrier the agent can't solve", 'S-unclear': "couldn't sort" };
  for (const [id, outcome] of Object.entries(expected)) {
    const c = await w.start(`Case ${id}`, 'P7-dx');
    const item = await w.reply(c, reply(id));
    assert.equal(item.replies[0].status, 'read', id);
    if (outcome === 'slots') {
      assert.equal(item.status, 'awaiting_booking');
      assert.match(item.messages.at(-1).body, /other open times/);
    } else {
      assert.equal(item.status, 'needs_review', id);
      assert(item.reviews.find(r => r.status === 'open').reason.includes(outcome), `${id}: ${item.reviews.at(-1).reason}`);
    }
  }
});

test('a new report that changes the plan drops an old booking instead of reminding her about it', async t => {
  const w = await workspace(t);
  const id = await w.start('Grace T.', 'P2-screen');
  await w.book(id, 5);
  let item = await w.next(id, 'P5-6mo');
  assert.equal(item.status, 'waiting_reminder');
  assert.equal(item.agent.booked, null);
  await w.forward(6);
  item = await w.get(id);
  assert(!item.messages.some(m => /^Reminder: your appointment/.test(m.body)));
  assert(!item.events.some(e => e.kind === 'appt'));
});

test('while a person has the case, the agent reads her replies but does not answer them', async t => {
  const w = await workspace(t);
  const id = await w.start('Priya S.', 'P7-dx');
  await w.reply(id, reply('P7-r1'));
  const sent = (await w.get(id)).messages.length;
  const item = await w.reply(id, reply('P3-r1'));
  assert.equal(item.status, 'needs_review');
  assert.equal(item.messages.length, sent, 'no ride offer while the navigator has her');
  assert(item.events.some(e => /has this case, so the agent doesn't answer/.test(e.detail)));
  assert.equal(item.reviews.filter(r => r.status === 'open').length, 1);
});

test('findings in both breasts: each breast gets its own case, and closing one side leaves the other open', async t => {
  const w = await workspace(t);
  const right = await w.start('Joyce K.', 'P10-dx');
  let item = await w.get(right);
  assert.equal(item.side, 'right');
  assert.equal(item.agent.step, 'Biopsy');
  assert.match(item.messages[0].body, /^Hi Joyce, .*the appointment they discussed with you for your right breast\./);
  assert.equal(item.tracks.length, 1);
  assert.equal(item.tracks[0].side, 'left');
  const left = item.tracks[0].id;
  let other = await w.get(left);
  assert.equal(other.status, 'waiting_reminder');
  assert.equal(other.agent.step, '6-month follow-up imaging');
  assert.equal(other.agent.due, '2027-04-23');
  assert.equal(other.reports.length, 1, 'the same report, saved with the left breast read');
  assert.equal(other.reports[0].read.birads, '3');
  assert.equal(other.messages.length, 0);

  // She books the right biopsy only. The right side resolves; the left stays open.
  assert.equal((await w.book(right, 3)).status, 200);
  await w.forward(3);
  item = await w.next(right, 'P10-path');
  assert(item.reports[1].text.includes('PROCEDURE DATE: 10/26/2026'));
  item = (await w.act(right, 'concordance', 'concordant')).body.case;
  assert.equal(item.status, 'closed');
  assert(item.events.some(e => e.kind === 'close' && /Case closed for the right breast/.test(e.detail)));
  assert(item.events.some(e => /The left breast is still open: 6-month follow-up imaging, due Apr 23, 2027/.test(e.detail)));
  other = await w.get(left);
  assert.equal(other.status, 'waiting_reminder');
  assert.equal(other.tracks[0].status, 'closed');

  // Months later the agent reminds her about the left breast by name.
  for (let i = 0; i < 5; i++) await w.forward(30);
  other = await w.get(left);
  assert.match(other.messages[0].body, /Your 6-month follow-up imaging for your left breast is due Apr 23, 2027/);
  const list = (await w.call('GET', '/api/cases')).body.cases;
  assert.deepEqual(list.filter(c => c.patient === 'Joyce K.').map(c => c.side).sort(), ['left', 'right']);
});

test('a single-side report shows the breast named in its own recommendation', async t => {
  const w = await workspace(t);
  const id = await w.start('Grace T.', 'P2-screen');
  const item = await w.get(id);
  assert.equal(item.read.side, 'both', 'Claude gave the exam side');
  assert.equal(item.side, 'right', 'the recommendation names the right breast');
  assert.equal(item.tracks.length, 0);
});
