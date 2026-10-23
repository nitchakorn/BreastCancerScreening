// The workspace and the simulation share one engine. This replays the simulation's nine patients
// through the workspace (saved cases, recorded reads, bookings, people) and checks that the agent
// makes the same decisions on the same days.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const A = require('../agent/agent.js');
const { openStore } = require('../server/store.js');
const { createLoop } = require('../server/loop.js');
const { createReader } = require('../server/reader.js');

const input = {
  patients: require('../data/patients.json'), documents: require('../data/documents.json'), replies: require('../data/replies.json'),
  reads: { documents: require('../reads/documents.json'), replies: require('../reads/replies.json') }
};
const US = /\b(\d{2})\/(\d{2})\/(\d{4})\b/g;
const K = A.dayOf('2026-10-23'); // move the whole timeline so day 0 is Oct 23, 2026
const move = text => text.replace(US, m => { const iso = A.addDays(`${m.slice(6)}-${m.slice(0, 2)}-${m.slice(3, 5)}`, K); return `${iso.slice(5, 7)}/${iso.slice(8)}/${iso.slice(0, 4)}`; });
const decisions = events => events.filter(e => e.actor === 'agent')
  .map(e => [e.day, e.kind === 'validation_passed' || e.kind === 'validation_held' ? 'check' : e.kind, e.handoffKind || e.channel || ''].join(' '));

test('the workspace makes the same decisions on the same days as the simulation, for all nine patients', async () => {
  const sim = A.simulate(input);
  const store = openStore(':memory:'), loop = createLoop(store), reader = createReader({ env: { READER_MODE: 'recorded' } });
  const caseOf = {};
  async function readQueued(today, now) {
    for (let job = store.claim(now, 'recorded'); job; job = store.claim(now, 'recorded')) {
      loop.applyRead(job, job.type === 'report' ? await reader.read(job.text) : await reader.readReply(job.text), today, now);
    }
  }
  for (let day = 0; day <= A.RULES.days; day++) {
    const today = A.dateOf(day + K), now = `${today}T16:00:00.000Z`;
    const todays = sim.events.filter(e => e.day === day), ticked = new Set();
    for (const e of todays) {
      const p = input.patients.find(x => x.id === e.patient);
      // When the agent acted first that day (a text, an appointment) and the world reacted to it,
      // let the workspace run its daily check before replaying the reaction, as the simulation did.
      const first = todays.find(x => x.patient === p.id);
      if (caseOf[p.id] && !ticked.has(p.id) && !['doc', 'reply', 'person', 'booked'].includes(first.kind)) { loop.step(caseOf[p.id], today, now); ticked.add(p.id); }
      if (e.actor === 'system' && e.kind === 'doc') {
        const text = move(input.documents.find(d => d.id === e.doc).text);
        if (!caseOf[p.id]) caseOf[p.id] = store.createCase(p.name, text, null, now).case.id;
        else store.addInput(caseOf[p.id], 'report', text, null, now);
        await readQueued(today, now);
      } else if (e.actor === 'patient' && e.kind === 'reply') {
        store.addInput(caseOf[p.id], 'reply', input.replies.find(r => r.id === e.reply).text, null, now);
        await readQueued(today, now);
      } else if (e.actor === 'agent' && e.kind === 'booked') {
        const book = p.reactions.map(r => r.book).find(b => b && e.text.includes(A.fmt(b.appt)));
        loop.book(caseOf[p.id], A.addDays(book.appt, K), /with the navigator/.test(e.text) ? 'navigator' : 'patient', today, now);
      } else if (e.actor === 'person' && p.reactions.some(r => r.when === 'concordance' && r.note === e.text)) {
        const review = store.get(caseOf[p.id]).reviews.find(r => r.kind === 'concordance' && r.status === 'open');
        loop.act(caseOf[p.id], review.id, 'concordant', e.text, today, now);
      }
    }
    loop.advanceAll(today, now);
  }
  const last = sim.snapshots[A.RULES.days];
  for (const p of input.patients) {
    const item = store.get(caseOf[p.id], A.dateOf(A.RULES.days + K));
    const workspace = item.events.map(e => ({ ...e, ...(e.meta || {}), day: A.dayOf(e.createdAt.slice(0, 10)) - K }));
    assert.deepEqual(decisions(workspace), decisions(sim.events.filter(e => e.patient === p.id)), `${p.id} decisions`);
    assert.equal(item.agent.resolvedDays, last[p.id].resolvedDays, `${p.id} days to resolution`);
    assert.equal(item.messages.length, sim.events.filter(e => e.patient === p.id && e.actor === 'agent' && ['text', 'portal', 'call'].includes(e.kind)).length, `${p.id} messages`);
  }
  store.close();
});
