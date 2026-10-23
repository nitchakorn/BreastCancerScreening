const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openStore } = require('./store.js');
const { createReader } = require('./reader.js');
const { decide } = require('./policy.js');
const { examples } = require('./samples.js');

const root = path.join(__dirname, '..');
const staticFiles = new Map([
  ['/', ['app/index.html', 'text/html; charset=utf-8']],
  ['/app.css', ['app/app.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app/app.js', 'text/javascript; charset=utf-8']],
  ['/simulation', ['docs/index.html', 'text/html; charset=utf-8']]
]);

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

function createApp({ dbPath = path.join(root, '.local/cases.sqlite'), reader = createReader(), clock = () => new Date().toISOString(), timeZone = process.env.APP_TIME_ZONE || 'America/New_York' } = {}) {
  const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const currentDate = () => dateFormatter.format(new Date(clock()));
  const store = openStore(dbPath);
  store.recover(clock());
  let timer = null, active = null, stopped = false;

  async function runOnce() {
    if (active || stopped) return active;
    active = (async () => {
      store.sendDue(clock(), currentDate());
      const job = store.claim(clock(), reader.status().mode);
      if (!job) return;
      try {
        const result = await reader.read(job.report);
        const decision = decide(job.report, result.read, currentDate());
        store.complete(job.id, result, decision, clock());
      } catch (e) {
        if (e.code === 'invalid_output') {
          store.complete(job.id, { read: null }, decide(job.report, null, currentDate()), clock());
        } else {
          const safe = ['not_configured', 'connection_failed', 'provider_error', 'model_unavailable', 'unsupported_sample'].includes(e.code)
            ? e.message : 'The read could not be completed. The case is saved; retry after checking the server configuration.';
          store.fail(job.id, safe, clock());
        }
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
      // This milestone is a local, unauthenticated synthetic-data workspace.
      // Reject unexpected Host headers to prevent browser DNS rebinding into it.
      if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(req.headers.host || '')) return json(403, { error: 'Use the local loopback address for this demo.' });
      const url = new URL(req.url, 'http://' + req.headers.host);
      if (!['GET', 'POST'].includes(req.method)) return json(405, { error: 'Method not allowed.' });
      if (req.method === 'POST') {
        if (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host) return json(403, { error: 'Cross-origin writes are not allowed.' });
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return json(415, { error: 'Use application/json.' });
      }
      if (req.method === 'GET' && url.pathname === '/api/health') return json(200, { status: 'ok', reader: reader.status(), delivery: 'local_test_inbox', milestone: 'upload-read-save-message' });
      if (req.method === 'GET' && url.pathname === '/api/examples') {
        return json(200, examples(currentDate()));
      }
      if (req.method === 'GET' && url.pathname === '/api/cases') return json(200, { cases: store.list() });
      const caseRoute = url.pathname.match(/^\/api\/cases\/([0-9a-f-]{36})(\/retry)?$/);
      if (caseRoute) {
        if (req.method === 'POST' && caseRoute[2]) {
          await readJson(req);
          if (!store.retry(caseRoute[1], clock())) return json(404, { error: 'Case not found.' });
          return json(202, { case: store.get(caseRoute[1]) });
        }
        if (req.method === 'GET' && !caseRoute[2]) {
          const item = store.get(caseRoute[1]);
          return json(item ? 200 : 404, item ? { case: item } : { error: 'Case not found.' });
        }
        return json(405, { error: 'Method not allowed.' });
      }
      if (req.method === 'POST' && url.pathname === '/api/cases') {
        const input = await readJson(req);
        if (!input || typeof input !== 'object' || Array.isArray(input)) return json(400, { error: 'Send a report object.' });
        const patient = typeof input.patient === 'string' ? input.patient.trim() : '';
        const report = typeof input.report === 'string' ? input.report.trim() : '';
        if (!patient || patient.length > 100 || report.length < 30 || report.length > 20000) return json(400, { error: 'Provide a synthetic patient label (1–100 characters) and report text (30–20,000 characters).' });
        const key = req.headers['idempotency-key'];
        if (key && (typeof key !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(key))) return json(400, { error: 'Invalid Idempotency-Key.' });
        const saved = store.create(patient, report, key, clock());
        return json(saved.created ? 202 : 200, saved);
      }
      if (req.method === 'GET' && staticFiles.has(url.pathname)) {
        const [filename, type] = staticFiles.get(url.pathname);
        const headers = { 'content-type': type, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-cache' };
        if (url.pathname !== '/simulation') headers['content-security-policy'] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
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
    server, store, runOnce, startWorker,
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
