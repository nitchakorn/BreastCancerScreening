const path = require('node:path');
const { createApp } = require('./app.js');

const host = process.env.HOST || '127.0.0.1';
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('This synthetic-data milestone binds to loopback only. Use HOST=127.0.0.1.');
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
const app = createApp({ dbPath: path.resolve(process.env.CASE_DB_PATH || path.join(__dirname, '../.local/cases.sqlite')) });
app.server.on('error', () => { console.error('The local server could not start. Check whether PORT is already in use.'); process.exitCode = 1; app.close(); });
app.server.listen(port, host, () => {
  console.log(`Synthetic agent workspace listening on ${host}:${port}. Model key configured: ${Boolean(process.env.ANTHROPIC_API_KEY)}.`);
  app.startWorker();
});
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await app.close();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
