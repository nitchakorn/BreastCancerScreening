const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const A = require('../agent/agent.js');
const { openStore } = require('./store.js');
const { createLoop } = require('./loop.js');
const { createReader } = require('./reader.js');
const { examples, nextReports, sampleReplies } = require('./samples.js');

const root = path.join(__dirname, '..');
const staticFiles = new Map([
  ['/', ['app/index.html', 'text/html; charset=utf-8']],
  ['/app.css', ['app/app.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app/app.js', 'text/javascript; charset=utf-8']],
  ['/simulation', ['docs/index.html', 'text/html; charset=utf-8']]
]);
const SAFE_READER_ERRORS = ['not_configured', 'connection_failed', 'provider_error', 'model_unavailable', 'unsupported_sample'];
const DAY_MS = 86400000;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [], tooLarge = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 32768) {
        if (!tooLarge) { tooLarge = true; chunks = []; reject(Object.assign(new Error('Report submission exceeds 32 KB.'), { status: 413 })); }
      } else if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('Send a valid JSON object.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
const bad = message => Object.assign(new Error(message), { status: 400 });
const cleanText = value => typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : '';
function requestKey(req) {
  const key = req.headers['idempotency-key'];
  if (key && (typeof key !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(key))) throw bad('Invalid Idempotency-Key.');
  return key || null;
}

function createApp({ dbPath = path.join(root, '.local/cases.sqlite'), reader = createReader(), clock = () => new Date().toISOString(), timeZone = process.env.APP_TIME_ZONE || 'America/New_York' } = {}) {
  const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const store = openStore(dbPath);
  const loop = createLoop(store);
  // The demo clock: real time plus however many days the workspace has been moved forward.
  const offsetDays = () => Number(store.setting('clock_offset_days', '0')) || 0;
  const nowIso = () => new Date(Date.parse(clock()) + offsetDays() * DAY_MS).toISOString();
  const todayOf = iso => dateFormatter.format(new Date(iso));
  const clockView = () => { const now = nowIso(), today = todayOf(now); return { today, label: `${A.weekday(today)}, ${A.fmt(today)}`, offsetDays: offsetDays() }; };
  if (store.setAside) console.log(`Moved the milestone 1 case database to ${path.basename(store.setAside)} and started a new one.`);
  store.recover(nowIso());
  let timer = null, active = null, stopped = false;

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
        console.error('The agent could not act on a read; inspect the saved case state.');
      }
    })();
    try { await active; } finally { active = null; }
  }

  function startWorker() {
    if (timer || stopped) return;
    const tick = () => runOnce().catch(() => console.error('Background processing failed; inspect the saved case state.'));
    timer = setInterval(tick, 1000);
    timer.unref();
    tick();
  }

  const server = http.createServer(async (req, res) => {
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify(body));
    };
    try {
      // A local, unauthenticated synthetic-data workspace.
      // Reject unexpected Host headers to prevent browser DNS rebinding into it.
      if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(req.headers.host || '')) return json(403, { error: 'Use the local loopback address for this demo.' });
      const url = new URL(req.url, 'http://' + req.headers.host);
      if (!['GET', 'POST'].includes(req.method)) return json(405, { error: 'Method not allowed.' });
      if (req.method === 'POST') {
        if (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host) return json(403, { error: 'Cross-origin writes are not allowed.' });
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return json(415, { error: 'Use application/json.' });
      }
      const now = nowIso(), today = todayOf(now);
      const p = url.pathname;
      if (req.method === 'GET' && p === '/api/health') return json(200, { status: 'ok', reader: reader.status(), delivery: 'local_test_inbox', milestone: 'agent-loop', clock: clockView() });
      if (req.method === 'GET' && p === '/api/clock') return json(200, clockView());
      if (req.method === 'POST' && p === '/api/clock') {
        const { days } = await readJson(req);
        if (!Number.isInteger(days) || days < 1 || days > 60) throw bad('Move the clock forward by 1 to 60 days.');
        if (active) await active;
        store.setSetting('clock_offset_days', offsetDays() + days);
        const later = nowIso();
        loop.advanceAll(todayOf(later), later);
        return json(200, clockView());
      }
      if (req.method === 'POST' && p === '/api/reset') {
        const body = await readJson(req);
        if (!body || body.confirm !== 'start over') throw bad('Send {"confirm":"start over"} to clear every case.');
        if (active) await active;
        store.reset();
        return json(200, { reset: true, clock: clockView() });
      }
      if (req.method === 'GET' && p === '/api/examples') return json(200, examples(today));
      if (req.method === 'GET' && p === '/api/cases') return json(200, { cases: store.list(today) });
      if (req.method === 'POST' && p === '/api/cases') {
        const input = await readJson(req);
        if (!input || typeof input !== 'object' || Array.isArray(input)) return json(400, { error: 'Send a report object.' });
        const patient = typeof input.patient === 'string' ? input.patient.trim() : '';
        const report = cleanText(input.report);
        if (!patient || patient.length > 100 || report.length < 30 || report.length > 20000) return json(400, { error: 'Provide a synthetic patient label (1–100 characters) and report text (30–20,000 characters).' });
        const saved = store.createCase(patient, report, requestKey(req), now);
        return json(saved.created ? 202 : 200, saved);
      }
      const route = p.match(/^\/api\/cases\/([0-9a-f-]{36})(?:\/(retry|examples|reports|replies|bookings|reviews\/([0-9a-f-]{36})))?$/);
      if (route) {
        const [, id, action, reviewId] = route;
        if (req.method === 'GET' && !action) {
          const item = store.get(id, today);
          return json(item ? 200 : 404, item ? { case: item } : { error: 'Case not found.' });
        }
        if (req.method === 'GET' && action === 'examples') {
          const row = store.caseRow(id);
          if (!row) return json(404, { error: 'Case not found.' });
          const c = row.state_json ? JSON.parse(row.state_json) : null;
          const anchors = { firstExam: c && c.openDate, biopsy: c && c.step && c.step.kind === 'pathology' ? A.addDays(c.step.due, -A.RULES.pathology.dueDaysAfterBiopsy) : null };
          return json(200, { reports: nextReports(today, anchors), replies: sampleReplies() });
        }
        if (req.method !== 'POST' || !action || action === 'examples') return json(405, { error: 'Method not allowed.' });
        const body = await readJson(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('Send a JSON object.');
        if (action === 'retry') {
          if (!store.retry(id, now)) return json(404, { error: 'Case not found.' });
          return json(202, { case: store.get(id, today) });
        }
        if (action === 'reports') {
          const report = cleanText(body.report);
          if (report.length < 30 || report.length > 20000) throw bad('Report text must be 30–20,000 characters.');
          const saved = store.addInput(id, 'report', report, requestKey(req), now);
          return json(saved.created ? 202 : 200, saved);
        }
        if (action === 'replies') {
          const text = cleanText(body.text);
          if (!text || text.length > 1000) throw bad('A reply must be 1–1,000 characters.');
          const saved = store.addInput(id, 'reply', text, requestKey(req), now);
          return json(saved.created ? 202 : 200, saved);
        }
        if (action === 'bookings') {
          loop.book(id, typeof body.date === 'string' ? body.date : '', body.by === 'navigator' ? 'navigator' : 'patient', today, now);
          return json(200, { case: store.get(id, today) });
        }
        if (reviewId) {
          loop.act(id, reviewId, body.action, body.note, today, now);
          return json(200, { case: store.get(id, today) });
        }
      }
      if (req.method === 'GET' && staticFiles.has(p)) {
        const [filename, type] = staticFiles.get(p);
        const headers = { 'content-type': type, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-cache' };
        if (p !== '/simulation') headers['content-security-policy'] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
        res.writeHead(200, headers);
        return res.end(fs.readFileSync(path.join(root, filename)));
      }
      return json(404, { error: 'Not found.' });
    } catch (e) {
      return json(e.status || 500, { error: e.status ? e.message : 'The request could not be completed. Your saved cases are retained.' });
    }
  });
  server.requestTimeout = 60000;
  return {
    server, store, runOnce, startWorker, clock: clockView,
    async close() {
      stopped = true;
      clearInterval(timer);
      if (server.listening) await new Promise(resolve => server.close(resolve));
      if (active) await active;
      store.close();
    }
  };
}

module.exports = { createApp };
