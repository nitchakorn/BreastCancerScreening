const A = require('../agent/agent.js');
const P = require('./policy.js');
const { httpError } = require('./store.js');

/*
  Drives the shared engine (agent/agent.js) for saved cases.
  Each change loads the case, catches it up day by day to today, applies the new input,
  and saves everything that happened in one transaction.
*/
function createLoop(store) {
  function step(caseId, today, now, work, options = {}) {
    return store.transaction(() => {
      const row = store.caseRow(caseId);
      if (!row) throw httpError(404, 'Case not found.');
      const c = row.state_json ? JSON.parse(row.state_json) : A.newCase({ id: row.id, name: row.patient, first: P.firstName(row.patient) });
      const events = [], splits = [];
      const engine = A.createEngine({
        log: e => events.push(e), check: options.check,
        side: (c, side, read, doc) => splits.push({ side, read, doc }),
        openTracks: () => store.groupTracks(row).map(t => t.state_json && JSON.parse(t.state_json)).filter(t => t && t.started && !t.closed)
      });
      const day = row.last_day === null ? A.dayOf(today) : Math.max(A.dayOf(today), row.last_day);
      if (row.last_day !== null) for (let d = row.last_day + 1; d < day; d++) engine.tick(c, d);
      const result = work ? work(engine, c, day) : undefined;
      if (c.started) engine.tick(c, day);
      store.saveCase(row, c, day, A.dateOf(day), now, events, options.resolution);
      // The report gave another breast its own assessment: that breast is followed in its own case.
      for (const split of splits) {
        const open = store.groupTracks(store.caseRow(caseId)).find(t => t.side === split.side && t.status !== 'closed');
        const id = open ? open.id : store.createTrack(store.caseRow(caseId), split.side, now);
        const inputId = store.copyReport(id, { text: split.doc.text, read: split.read, model: options.model, mode: options.mode }, now);
        step(id, today, now, (e, t, d) => e.onDoc(t, P.docFor({ id: inputId, text: split.doc.text }, split.read), split.read, d, { split: true }), { resolution: 'A new report came in' });
      }
      return result;
    });
  }

  // Run the daily checks for every open case that hasn't been checked today.
  function advanceAll(today, now) {
    const day = A.dayOf(today);
    for (const row of store.openCases()) if (row.last_day === null || row.last_day < day) step(row.id, today, now);
  }

  // A report or reply came back from Claude. Save the read and let the engine act on it.
  function applyRead(input, result, today, now) {
    store.transaction(() => {
      store.inputRead(input.id, result, now);
      const row = store.caseRow(input.case_id);
      if (row && row.status === 'closed') return store.note(input.case_id, 'after_close', `This ${input.type} was read after the case closed, so the agent took no action.`, now);
      if (input.type === 'report') {
        let problems = [];
        const cmp = result.comparison;
        const comparison = !cmp ? null : cmp.error ? { error: cmp.error }
          : { read: cmp.read, model: cmp.model, problems: A.checkComparison(cmp.read, cmp.imaging, input.text) };
        step(input.case_id, today, now, (engine, c, day) => {
          engine.onDoc(c, P.docFor(input, result.read), result.read, day, { comparison });
        }, { check: (doc, read) => (problems = P.checkReport(input.text, read, today)), resolution: 'A new report came in', model: result.model, mode: result.mode });
        store.inputProblems(input.id, problems);
      } else {
        step(input.case_id, today, now, (engine, c, day) => engine.onReply(c, { id: input.id, text: input.text }, result.read, day), { resolution: 'She replied' });
      }
    });
  }

  // The test scheduling system: she booked online, or a navigator booked for her.
  function book(caseId, date, by, today, now) {
    return step(caseId, today, now, (engine, c, day) => {
      const problem = P.bookingProblem(c, date, A.dateOf(day));
      if (problem) throw httpError(409, problem);
      const kind = c.step.kind === 'biopsy' ? 'biopsy' : 'imaging';
      if (by === 'navigator') engine.personNote(c, day, 'Nurse navigator', `Booked her ${kind} for ${A.weekday(date)} ${A.fmt(date)}.`);
      engine.onBook(c, { appt: date, kind }, day, by === 'navigator');
    }, { resolution: by === 'navigator' ? 'The navigator booked her' : 'She booked' });
  }

  // A person acts on a handoff: hand it back, confirm concordance, or close the case.
  function act(caseId, reviewId, action, note, today, now) {
    const text = typeof note === 'string' ? note.trim().slice(0, 500) : '';
    return step(caseId, today, now, (engine, c, day) => {
      const review = store.review(reviewId);
      if (!review || review.case_id !== caseId || review.status !== 'open') throw httpError(404, 'This review is not open.');
      const who = review.who || 'Nurse navigator';
      if (action === 'resume') {
        const s = c.step, deadline = P.handoffDate(c);
        if (review.kind !== 'exception' || !s || !P.OUTREACH_STEPS.includes(s.kind) || s.awaitingResult || !deadline || A.dateOf(day) >= deadline) {
          throw httpError(409, 'The agent can only take this back while booking outreach is still open. Book her, add the missing report, or close the case.');
        }
        engine.personNote(c, day, who, text || 'Talked with her. Handing the case back to the agent.');
        engine.resume(c, day);
      } else if (action === 'concordant') {
        if (review.kind !== 'concordance') throw httpError(409, 'Only a benign pathology result waits for a concordance check.');
        engine.personNote(c, day, who, text || 'The pathology matches the imaging.');
        engine.concordant(c, day);
      } else if (action === 'discordant') {
        if (review.kind !== 'concordance') throw httpError(409, 'Only a benign pathology result waits for a concordance check.');
        engine.personNote(c, day, who, text || 'Not concordant. The result doesn’t explain the imaging finding. Recommend a repeat biopsy.');
        engine.discordant(c, day);
      } else if (action === 'close') {
        if (!text) throw httpError(400, 'Add a short note saying why the case is closing.');
        engine.closeByPerson(c, day, who, text);
      } else throw httpError(400, 'Unknown action.');
    }, { resolution: action === 'resume' ? 'Handed back to the agent' : action === 'concordant' ? 'Concordance confirmed'
      : action === 'discordant' ? 'Not a match: repeat biopsy' : 'Closed by a person' });
  }

  return { step, advanceAll, applyRead, book, act };
}

module.exports = { createLoop };
