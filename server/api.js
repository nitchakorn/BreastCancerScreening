const A = require('../agent/agent.js');
const { createLoop } = require('./loop.js');
const { examples, nextReports, sampleReplies } = require('./samples.js');

/*
  The workspace API: routes, the demo clock and the background reader.
  The Node server (app.js) puts HTTP in front of it. The public demo page runs the
  same API inside the browser, with an in-memory store and the recorded reads.
*/
const SAFE_READER_ERRORS = ['not_configured', 'connection_failed', 'provider_error', 'model_unavailable', 'unsupported_sample', 'cli_unavailable'];
const DAY_MS = 86400000;
const bad = message => Object.assign(new Error(message), { status: 400 });
const cleanText = value => typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : '';

function createApi({ store, reader, clock = () => new Date().toISOString(), timeZone = 'America/New_York', runtime = 'server', log = () => {} }) {
  const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const loop = createLoop(store);
  // The demo clock: real time plus however many days the workspace has been moved forward.
  const offsetDays = () => Number(store.setting('clock_offset_days', '0')) || 0;
  const nowIso = () => new Date(Date.parse(clock()) + offsetDays() * DAY_MS).toISOString();
  const todayOf = iso => dateFormatter.format(new Date(iso));
  const clockView = () => { const today = todayOf(nowIso()); return { today, label: `${A.weekday(today)}, ${A.fmt(today)}`, offsetDays: offsetDays() }; };
  let active = null, stopped = false;

  // One pass of the worker: the daily checks, then at most one queued report or reply.
  async function runOnce() {
    if (active || stopped) return active;
    active = (async () => {
      const now = nowIso();
      loop.advanceAll(todayOf(now), now);
      const job = store.claim(now, reader.status().mode);
      if (!job) return;
      let result;
      try {
        result = job.type === 'report' ? await reader.read(job.text) : await reader.readReply(job.text);
      } catch (e) {
        const at = nowIso();
        if (e.code === 'invalid_output') return loop.applyRead(job, { read: null, mode: reader.status().mode }, todayOf(at), at);
        return store.inputFailed(job.id, SAFE_READER_ERRORS.includes(e.code) ? e.message
          : 'The read could not be completed. The case is saved; retry after checking the server configuration.', at);
      }
      const at = nowIso();
      try { loop.applyRead(job, result, todayOf(at), at); }
      catch {
        store.inputFailed(job.id, 'The agent could not act on this read. The case is saved; retry it, and check the server log if it fails again.', at);
        log('The agent could not act on a read; inspect the saved case state.');
      }
    })();
    try { await active; } finally { active = null; }
  }

  function requestKey(headers) {
    const key = headers['idempotency-key'];
    if (key && (typeof key !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(key))) throw bad('Invalid Idempotency-Key.');
    return key || null;
  }

  async function route(method, p, body, headers) {
    const now = nowIso(), today = todayOf(now);
    if (method === 'GET' && p === '/api/health') return [200, { status: 'ok', reader: reader.status(), delivery: 'local_test_inbox', milestone: 'agent-loop', runtime, clock: clockView() }];
    if (method === 'GET' && p === '/api/clock') return [200, clockView()];
    if (method === 'POST' && p === '/api/clock') {
      const days = body && body.days;
      if (!Number.isInteger(days) || days < 1 || days > 60) throw bad('Move the clock forward by 1 to 60 days.');
      if (active) await active;
      store.setSetting('clock_offset_days', offsetDays() + days);
      const later = nowIso();
      loop.advanceAll(todayOf(later), later);
      return [200, clockView()];
    }
    if (method === 'POST' && p === '/api/reset') {
      if (!body || body.confirm !== 'start over') throw bad('Send {"confirm":"start over"} to clear every case.');
      if (active) await active;
      store.reset();
      return [200, { reset: true, clock: clockView() }];
    }
    if (method === 'GET' && p === '/api/examples') return [200, examples(today)];
    if (method === 'GET' && p === '/api/cases') return [200, { cases: store.list(today) }];
    if (method === 'POST' && p === '/api/cases') {
      if (!body || typeof body !== 'object' || Array.isArray(body)) return [400, { error: 'Send a report object.' }];
      const patient = typeof body.patient === 'string' ? body.patient.trim() : '';
      const report = cleanText(body.report);
      if (!patient || patient.length > 100 || report.length < 30 || report.length > 20000) return [400, { error: 'Provide a synthetic patient label (1–100 characters) and report text (30–20,000 characters).' }];
      const saved = store.createCase(patient, report, requestKey(headers), now);
      return [saved.created ? 202 : 200, saved];
    }
    const match = p.match(/^\/api\/cases\/([0-9a-f-]{36})(?:\/(retry|examples|reports|replies|bookings|reviews\/([0-9a-f-]{36})))?$/);
    if (!match) return [404, { error: 'Not found.' }];
    const [, id, action, reviewId] = match;
    if (method === 'GET' && !action) {
      const item = store.get(id, today);
      return item ? [200, { case: item }] : [404, { error: 'Case not found.' }];
    }
    if (method === 'GET' && action === 'examples') {
      const row = store.caseRow(id);
      if (!row) return [404, { error: 'Case not found.' }];
      const c = row.state_json ? JSON.parse(row.state_json) : null;
      const anchors = { firstExam: c && c.openDate, biopsy: c && c.step && c.step.kind === 'pathology' ? A.addDays(c.step.due, -A.RULES.pathology.dueDaysAfterBiopsy) : null };
      return [200, { reports: nextReports(today, anchors), replies: sampleReplies() }];
    }
    if (method !== 'POST' || !action || action === 'examples') return [405, { error: 'Method not allowed.' }];
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('Send a JSON object.');
    if (action === 'retry') {
      if (!store.retry(id, now)) return [404, { error: 'Case not found.' }];
      return [202, { case: store.get(id, today) }];
    }
    if (action === 'reports') {
      const report = cleanText(body.report);
      if (report.length < 30 || report.length > 20000) throw bad('Report text must be 30–20,000 characters.');
      const saved = store.addInput(id, 'report', report, requestKey(headers), now);
      return [saved.created ? 202 : 200, saved];
    }
    if (action === 'replies') {
      const text = cleanText(body.text);
      if (!text || text.length > 1000) throw bad('A reply must be 1–1,000 characters.');
      const saved = store.addInput(id, 'reply', text, requestKey(headers), now);
      return [saved.created ? 202 : 200, saved];
    }
    if (action === 'bookings') {
      loop.book(id, typeof body.date === 'string' ? body.date : '', body.by === 'navigator' ? 'navigator' : 'patient', today, now);
      return [200, { case: store.get(id, today) }];
    }
    loop.act(id, reviewId, body.action, body.note, today, now);
    return [200, { case: store.get(id, today) }];
  }

  // Every request ends as a status and a JSON body. Unexpected errors never leak details.
  async function handle(method, path, body, headers = {}) {
    try {
      const [status, result] = await route(method, path, body, headers);
      return { status, body: result };
    } catch (e) {
      return { status: e.status || 500, body: { error: e.status ? e.message : 'The request could not be completed. Your saved cases are retained.' } };
    }
  }

  store.recover(nowIso());
  return {
    handle, runOnce, clock: clockView,
    async stop() { stopped = true; if (active) await active; }
  };
}

module.exports = { createApi };
