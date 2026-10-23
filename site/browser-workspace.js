/*
  Runs the workspace inside the browser for the public demo page (docs/workspace.html).
  The page, the engine and the server code are the same files the local workspace uses.
  Only three things are swapped in here:
    - SQLite is sql.js (SQLite compiled to WebAssembly) instead of node:sqlite
    - the page's /api/ requests are answered in the browser instead of by a server
    - Claude's reads are the recorded ones, since there is no API key in a public page
  Cases are saved in this browser only (localStorage).
  scripts/build.js bundles this file with the server modules (window.WorkspaceModules).
*/
(function () {
  'use strict';
  var SAVE_KEY = 'breast-screening-workspace-v1';
  var modules = window.WorkspaceModules;

  // node:crypto's createHash('sha256'), synchronous, for the duplicate-submission fingerprint.
  function sha256Hex(text) {
    var bytes = new TextEncoder().encode(text), K = [], H = [], i, j;
    var isPrime = function (n) { for (var f = 2; f * f <= n; f++) if (n % f === 0) return false; return true; };
    for (var n = 2, found = 0; found < 64; n++) if (isPrime(n)) {
      if (found < 8) H[found] = (Math.pow(n, 1 / 2) % 1) * 4294967296 | 0;
      K[found++] = (Math.pow(n, 1 / 3) % 1) * 4294967296 | 0;
    }
    var len = bytes.length, words = new Array(((len + 8) >> 6) * 16 + 16).fill(0);
    for (i = 0; i < len; i++) words[i >> 2] |= bytes[i] << (24 - (i % 4) * 8);
    words[len >> 2] |= 0x80 << (24 - (len % 4) * 8);
    words[(((len + 8) >> 6) + 1) * 16 - 1] = len * 8;
    var W = new Array(64), rotr = function (x, r) { return (x >>> r) | (x << (32 - r)); };
    for (i = 0; i < words.length - 15; i += 16) {
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (j = 0; j < 64; j++) {
        if (j < 16) W[j] = words[i + j] | 0;
        else {
          var s0 = rotr(W[j - 15], 7) ^ rotr(W[j - 15], 18) ^ (W[j - 15] >>> 3);
          var s1 = rotr(W[j - 2], 17) ^ rotr(W[j - 2], 19) ^ (W[j - 2] >>> 10);
          W[j] = (W[j - 16] + s0 + W[j - 7] + s1) | 0;
        }
        var t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[j] + W[j]) | 0;
        var t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    return H.map(function (x) { return ('00000000' + (x >>> 0).toString(16)).slice(-8); }).join('');
  }

  // The parts of node:sqlite's DatabaseSync that store.js uses, on top of sql.js.
  function sqliteClass(SQL, saved) {
    return function SqlJsDatabase() {
      var db = saved ? new SQL.Database(saved) : new SQL.Database();
      saved = null;
      var clean = function (params) { return params.map(function (v) { return v === undefined ? null : v; }); };
      this.exec = function (sql) { db.exec(sql); };
      this.prepare = function (sql) {
        var all = function () {
          var stmt = db.prepare(sql), rows = [];
          try { stmt.bind(clean([].slice.call(arguments))); while (stmt.step()) rows.push(stmt.getAsObject()); }
          finally { stmt.free(); }
          return rows;
        };
        return {
          all: all,
          get: function () { return all.apply(null, arguments)[0]; },
          run: function () {
            var stmt = db.prepare(sql);
            try { stmt.run(clean([].slice.call(arguments))); } finally { stmt.free(); }
            return { changes: db.getRowsModified() };
          }
        };
      };
      this.close = function () { db.close(); };
      this.bytes = function () { return db.export(); };
    };
  }

  function loadSaved() {
    try {
      var text = localStorage.getItem(SAVE_KEY);
      if (!text) return null;
      var raw = atob(text), bytes = new Uint8Array(raw.length);
      for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      return bytes;
    } catch (e) { return null; }
  }
  function save(database) {
    try {
      var bytes = database.bytes(), raw = '';
      for (var i = 0; i < bytes.length; i += 32768) raw += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
      localStorage.setItem(SAVE_KEY, btoa(raw));
    } catch (e) { /* private window or full storage: the demo still works for this visit */ }
  }

  function showFailure(message) {
    var box = document.getElementById('connection');
    if (box) { box.classList.add('warning'); box.textContent = message; }
  }

  async function start() {
    if (typeof initSqlJs !== 'function') return showFailure('This demo needs to load SQLite from cdn.jsdelivr.net. Check your connection and reload the page.');
    var SQL = await initSqlJs({ locateFile: function (file) { return window.SQLJS_BASE + file; } });
    modules.shims['node:crypto'] = {
      randomUUID: function () { return crypto.randomUUID(); },
      createHash: function () { var text = ''; return { update: function (t) { text += t; return this; }, digest: function () { return sha256Hex(text); } }; }
    };
    var openStore = modules.load('server/store.js').openStore;
    var createReader = modules.load('server/reader.js').createReader;
    var createApi = modules.load('server/api.js').createApi;
    var database = null, Database = sqliteClass(SQL, loadSaved());
    var Tracked = function (name) { Database.call(this, name); database = this; };
    var store;
    try { store = openStore(':memory:', { Database: Tracked }); }
    catch (e) {
      // A saved demo from an older version: start fresh.
      try { localStorage.removeItem(SAVE_KEY); } catch (ignored) {}
      Database = sqliteClass(SQL, null);
      store = openStore(':memory:', { Database: Tracked });
    }
    var api = createApi({
      store: store, reader: createReader({ env: { READER_MODE: 'recorded' } }), runtime: 'browser',
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York'
    });
    var pendingSave = null;
    var saveSoon = function () { clearTimeout(pendingSave); pendingSave = setTimeout(function () { save(database); }, 300); };

    var realFetch = window.fetch.bind(window);
    window.fetch = async function (url, options) {
      options = options || {};
      var u = new URL(typeof url === 'string' ? url : url.url, location.href), at = u.pathname.indexOf('/api/');
      if (at < 0) return realFetch(url, options);
      var headers = {};
      Object.keys(options.headers || {}).forEach(function (k) { headers[k.toLowerCase()] = options.headers[k]; });
      var body = null;
      if (options.body) { try { body = JSON.parse(options.body); } catch (e) { return new Response(JSON.stringify({ error: 'Send a valid JSON object.' }), { status: 400 }); } }
      var result = await api.handle((options.method || 'GET').toUpperCase(), u.pathname.slice(at), body, headers);
      if ((options.method || 'GET').toUpperCase() === 'POST') saveSoon();
      return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'content-type': 'application/json' } });
    };
    // The background reader, as on the server. Recorded reads take a moment, like a real read.
    setInterval(function () { api.runOnce().then(saveSoon).catch(function () {}); }, 700);
    window.startWorkspaceApp();
  }

  start().catch(function () { showFailure('The demo could not start in this browser. Try reloading, or run the workspace locally (see the README).'); });
})();
