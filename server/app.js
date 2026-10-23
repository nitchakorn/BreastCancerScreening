const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openStore } = require('./store.js');
const { createReader } = require('./reader.js');
const { createApi } = require('./api.js');

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

function createApp({ dbPath = path.join(root, '.local/cases.sqlite'), store = null, reader = createReader(), clock = () => new Date().toISOString(), timeZone = process.env.APP_TIME_ZONE || 'America/New_York' } = {}) {
  store = store || openStore(dbPath);
  if (store.setAside) console.log(`Moved the milestone 1 case database to ${path.basename(store.setAside)} and started a new one.`);
  const api = createApi({ store, reader, clock, timeZone, log: message => console.error(message) });
  let timer = null, stopped = false;

  function startWorker() {
    if (timer || stopped) return;
    const tick = () => api.runOnce().catch(() => console.error('Background processing failed; inspect the saved case state.'));
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
      if (url.pathname.startsWith('/api/')) {
        const body = req.method === 'POST' ? await readJson(req) : null;
        const result = await api.handle(req.method, url.pathname, body, req.headers);
        return json(result.status, result.body);
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
    server, store, startWorker, runOnce: api.runOnce, clock: api.clock,
    async close() {
      stopped = true;
      clearInterval(timer);
      if (server.listening) await new Promise(resolve => server.close(resolve));
      await api.stop();
      store.close();
    }
  };
}

module.exports = { createApp };
