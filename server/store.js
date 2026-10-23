const { DatabaseSync } = require('node:sqlite');
const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const A = require('../agent/agent.js');
const { caseStatus, comingUp, handoffDate, OUTREACH_STEPS } = require('./policy.js');

const VERSION = 2;
const fingerprint = parts => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const httpError = (status, message) => Object.assign(new Error(message), { status });
const json = value => value === null || value === undefined ? null : JSON.parse(value);
const META = ['short', 'channel', 'template', 'labels', 'who', 'handoffKind', 'ok'];

// A database from milestone 1 has a different shape. Keep it under a new name and start fresh.
function setAsideOldDatabase(filename) {
  if (!fs.existsSync(filename)) return null;
  const old = new DatabaseSync(filename);
  let outdated = false;
  try {
    const version = old.prepare('PRAGMA user_version').get().user_version;
    outdated = version < VERSION && Boolean(old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cases'").get());
    if (outdated) old.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally { old.close(); }
  if (!outdated) return null;
  const aside = filename.replace(/(\.sqlite)?$/, `.milestone1-${Date.now()}.sqlite`);
  fs.renameSync(filename, aside);
  for (const suffix of ['-wal', '-shm']) if (fs.existsSync(filename + suffix)) fs.renameSync(filename + suffix, aside + suffix);
  return aside;
}

function openStore(filename, { Database = DatabaseSync } = {}) {
  let setAside = null;
  if (filename !== ':memory:') {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    setAside = setAsideOldDatabase(filename);
  }
  const db = new Database(filename);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS cases (
      id TEXT PRIMARY KEY, patient TEXT NOT NULL, status TEXT NOT NULL, pathway TEXT, due TEXT, next_action TEXT,
      state_json TEXT, last_day INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inputs (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), type TEXT NOT NULL CHECK (type IN ('report','reply')),
      intake_key TEXT NOT NULL UNIQUE, text TEXT NOT NULL, status TEXT NOT NULL, read_json TEXT, model TEXT, reader_mode TEXT,
      problems_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS inputs_by_status ON inputs(status, created_at);
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, case_id TEXT NOT NULL REFERENCES cases(id),
      actor TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL, meta_json TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), dedupe_key TEXT NOT NULL UNIQUE,
      channel TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), kind TEXT NOT NULL, who TEXT, reason TEXT NOT NULL,
      status TEXT NOT NULL, resolution TEXT, created_at TEXT NOT NULL, resolved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    PRAGMA user_version=${VERSION};`);

  // One change, one transaction. Nested calls join the outer transaction.
  let depth = 0;
  function transaction(work) {
    if (depth) return work();
    db.exec('BEGIN IMMEDIATE');
    depth = 1;
    try { const result = work(); db.exec('COMMIT'); return result; }
    catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
    finally { depth = 0; }
  }
  function event(caseId, actor, kind, detail, meta, at) {
    db.prepare('INSERT INTO events(case_id,actor,kind,detail,meta_json,created_at) VALUES(?,?,?,?,?,?)').run(caseId, actor, kind, detail, meta ? JSON.stringify(meta) : null, at);
  }
  function insertInput(caseId, type, key, text, now) {
    const id = randomUUID();
    db.prepare("INSERT INTO inputs(id,case_id,type,intake_key,text,status,created_at,updated_at) VALUES(?,?,?,?,?,'queued',?,?)").run(id, caseId, type, key, text, now, now);
    return id;
  }
  function inputJson(row) {
    return { id: row.id, type: row.type, text: row.text, status: row.status, read: json(row.read_json), model: row.model, readerMode: row.reader_mode,
      problems: json(row.problems_json) || [], createdAt: row.created_at, updatedAt: row.updated_at };
  }

  // What a person needs to see about the agent's side of a case.
  function agentView(c, today) {
    if (!c || !c.started) return null;
    const s = c.step, day = A.dayOf(today);
    const outreach = s && OUTREACH_STEPS.includes(s.kind) && !s.awaitingResult;
    const deadline = handoffDate(c);
    return {
      step: s ? s.name : null, kind: s ? s.kind : null, due: s ? s.due || null : null,
      overdueDays: s && s.due && !c.closed && !s.awaitingResult && !c.booked ? Math.max(0, day - A.dayOf(s.due)) : 0,
      booked: c.booked ? { appt: c.booked.appt, kind: c.booked.kind } : null,
      person: c.person ? { who: c.person.who, kind: c.person.kind, reason: c.person.reason } : null,
      outcome: c.closed ? c.closed.outcome : null, closedBy: c.closed ? c.closed.by || null : null,
      openedOn: c.openDate, category: c.openCat,
      resolvedDays: c.resolvedDay !== null ? c.resolvedDay - A.dayOf(c.openDate) : null,
      handoffDate: deadline, coming: comingUp(c, today),
      can: {
        reply: !c.closed,
        book: !c.closed && !c.booked && outreach && !(c.person && c.person.kind !== 'exception'),
        addReport: !c.closed,
        resume: !c.closed && Boolean(c.person && c.person.kind === 'exception') && outreach && Boolean(deadline) && today < deadline
      }
    };
  }

  function get(id, today) {
    const row = db.prepare('SELECT * FROM cases WHERE id=?').get(id);
    if (!row) return null;
    const c = json(row.state_json);
    const day = today || (row.last_day !== null ? A.dateOf(row.last_day) : null);
    const inputs = db.prepare('SELECT * FROM inputs WHERE case_id=? ORDER BY created_at,rowid').all(id).map(inputJson);
    const reports = inputs.filter(i => i.type === 'report'), replies = inputs.filter(i => i.type === 'reply');
    const latest = reports[reports.length - 1] || {};
    return {
      id: row.id, patient: row.patient, status: row.status, pathway: row.pathway, due: row.due, nextAction: row.next_action,
      createdAt: row.created_at, updatedAt: row.updated_at,
      report: latest.text, read: latest.read || null, model: latest.model || null, readerMode: latest.readerMode || null, problems: latest.problems || [],
      agent: day ? agentView(c, day) : null, reports, replies,
      messages: db.prepare('SELECT id,channel,body,created_at AS createdAt FROM messages WHERE case_id=? ORDER BY created_at,rowid').all(id),
      reviews: db.prepare('SELECT id,kind,who,reason,status,resolution,created_at AS createdAt,resolved_at AS resolvedAt FROM reviews WHERE case_id=? ORDER BY rowid').all(id),
      events: db.prepare('SELECT seq,actor,kind,detail,meta_json,created_at AS createdAt FROM events WHERE case_id=? ORDER BY seq').all(id)
        .map(({ meta_json, ...e }) => ({ ...e, meta: json(meta_json) }))
    };
  }

  return {
    transaction, get, setAside,
    close() { db.close(); },
    setting(key, fallback) { const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key); return row ? row.value : fallback; },
    setSetting(key, value) { db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value)); },
    caseRow(id) { return db.prepare('SELECT * FROM cases WHERE id=?').get(id); },
    review(id) { return db.prepare('SELECT * FROM reviews WHERE id=?').get(id); },
    list(today) {
      return db.prepare('SELECT id,patient,status,pathway,due,next_action,state_json,last_day,created_at,updated_at FROM cases ORDER BY created_at DESC,rowid DESC').all().map(row => {
        const c = json(row.state_json), day = today || (row.last_day !== null ? A.dateOf(row.last_day) : null), view = day ? agentView(c, day) : null;
        return { id: row.id, patient: row.patient, status: row.status, pathway: row.pathway, due: row.due, nextAction: row.next_action,
          step: view ? view.step : null, overdueDays: view ? view.overdueDays : 0, booked: view && view.booked ? view.booked.appt : null,
          person: view && view.person ? view.person.who : null, outcome: view ? view.outcome : null, resolvedDays: view ? view.resolvedDays : null,
          openReviews: db.prepare("SELECT COUNT(*) AS n FROM reviews WHERE case_id=? AND status='open'").get(row.id).n,
          createdAt: row.created_at, updatedAt: row.updated_at };
      });
    },
    openCases() { return db.prepare("SELECT id,last_day FROM cases WHERE state_json IS NOT NULL AND status != 'closed'").all(); },

    createCase(patient, text, requestKey, now) {
      return transaction(() => {
        const key = requestKey || fingerprint([patient, text]);
        const existing = db.prepare('SELECT i.case_id,i.text,c.patient FROM inputs i JOIN cases c ON c.id=i.case_id WHERE i.intake_key=?').get(key);
        if (existing) {
          if (existing.patient !== patient || existing.text !== text) throw httpError(409, 'This request key belongs to a different report.');
          return { case: get(existing.case_id), created: false };
        }
        const id = randomUUID();
        db.prepare("INSERT INTO cases(id,patient,status,created_at,updated_at) VALUES(?,?,'queued',?,?)").run(id, patient, now, now);
        insertInput(id, 'report', key, text, now);
        event(id, 'system', 'report_saved', 'Synthetic report saved; queued for a report read.', null, now);
        return { case: get(id), created: true };
      });
    },
    create(patient, text, requestKey, now) { return this.createCase(patient, text, requestKey, now); },
    pending() { return db.prepare("SELECT COUNT(*) AS n FROM inputs WHERE status IN ('queued','reading')").get().n; },
    addInput(caseId, type, text, requestKey, now) {
      return transaction(() => {
        const row = db.prepare('SELECT id,status,state_json FROM cases WHERE id=?').get(caseId);
        if (!row) throw httpError(404, 'Case not found.');
        if (row.status === 'closed') throw httpError(409, 'This case is closed. Start a new case for her next report.');
        if (!row.state_json) throw httpError(409, 'The first report has not been read yet. Wait for it or retry it first.');
        const key = requestKey ? `${caseId}:${type}:${requestKey}` : type === 'report' ? fingerprint([caseId, 'report', text]) : randomUUID();
        const existing = db.prepare('SELECT case_id,type,text FROM inputs WHERE intake_key=?').get(key);
        if (existing) {
          if (existing.case_id !== caseId || existing.type !== type || existing.text !== text) throw httpError(409, 'This request key belongs to a different submission.');
          return { case: get(caseId), created: false };
        }
        insertInput(caseId, type, key, text, now);
        if (type === 'report') event(caseId, 'system', 'report_saved', 'Next report saved; queued for a report read.', null, now);
        else event(caseId, 'system', 'reply_saved', 'Her reply arrived in the test inbox; queued for a read.', null, now);
        return { case: get(caseId), created: true };
      });
    },
    claim(now, mode) {
      return transaction(() => {
        const next = db.prepare("SELECT * FROM inputs WHERE status='queued' ORDER BY created_at,rowid LIMIT 1").get();
        if (!next) return null;
        db.prepare("UPDATE inputs SET status='reading',updated_at=? WHERE id=?").run(now, next.id);
        db.prepare("UPDATE cases SET status='reading',updated_at=? WHERE id=? AND state_json IS NULL").run(now, next.case_id);
        const what = next.type === 'report' ? 'report' : 'reply';
        event(next.case_id, 'system', 'reader_requested', mode === 'recorded' ? `Requested the matching recorded ${what} read. No model API call.`
          : `Requested a live Claude structured read of the ${what}. Source text cannot select actions or tools.`, null, now);
        return { ...next, status: 'reading' };
      });
    },
    inputRead(inputId, result, now) {
      const row = db.prepare('SELECT case_id,type FROM inputs WHERE id=?').get(inputId);
      db.prepare("UPDATE inputs SET status='read',read_json=?,model=?,reader_mode=?,problems_json='[]',updated_at=? WHERE id=?")
        .run(result.read ? JSON.stringify(result.read) : null, result.model || null, result.mode || null, now, inputId);
      event(row.case_id, 'system', 'read_completed', result.mode === 'recorded' ? `Used the recorded ${row.type} read; no model API call.`
        : result.read && result.model ? `Live read returned by ${result.model}.` : 'No usable structured read was returned.', null, now);
    },
    inputProblems(inputId, problems) { db.prepare('UPDATE inputs SET problems_json=? WHERE id=?').run(JSON.stringify(problems), inputId); },
    note(caseId, kind, detail, now) { event(caseId, 'system', kind, detail, null, now); },
    inputFailed(inputId, message, now) {
      transaction(() => {
        const row = db.prepare('SELECT case_id FROM inputs WHERE id=?').get(inputId);
        db.prepare("UPDATE inputs SET status='read_failed',problems_json=?,updated_at=? WHERE id=?").run(JSON.stringify([message]), now, inputId);
        db.prepare("UPDATE cases SET status='read_failed',updated_at=? WHERE id=? AND state_json IS NULL").run(now, row.case_id);
        event(row.case_id, 'system', 'read_failed', message, null, now);
      });
    },
    recover(now) {
      transaction(() => {
        for (const row of db.prepare("SELECT id,case_id FROM inputs WHERE status='reading'").all()) {
          db.prepare("UPDATE inputs SET status='queued',updated_at=? WHERE id=?").run(now, row.id);
          db.prepare("UPDATE cases SET status='queued',updated_at=? WHERE id=? AND state_json IS NULL").run(now, row.case_id);
          event(row.case_id, 'system', 'read_recovered', 'An interrupted read was requeued after restart. Messages stay deduplicated.', null, now);
        }
      });
    },
    retry(caseId, now) {
      return transaction(() => {
        if (!db.prepare('SELECT id FROM cases WHERE id=?').get(caseId)) return false;
        const failed = db.prepare("SELECT id FROM inputs WHERE case_id=? AND status='read_failed'").all(caseId);
        for (const row of failed) db.prepare("UPDATE inputs SET status='queued',problems_json='[]',updated_at=? WHERE id=?").run(now, row.id);
        if (failed.length) {
          db.prepare("UPDATE cases SET status='queued',updated_at=? WHERE id=? AND state_json IS NULL").run(now, caseId);
          event(caseId, 'system', 'read_retried', 'Requeued the failed read; no duplicate case or message created.', null, now);
        }
        return true;
      });
    },

    // Save one engine run: its events, test messages and handoffs, then the case itself.
    saveCase(row, c, lastDay, today, now, events, resolution) {
      let failedCheck = null, newHandoff = false;
      let n = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE case_id=?').get(row.id).n;
      for (const e of events) {
        const at = e.date < today ? `${e.date}T13:00:00.000Z` : now;
        const meta = {};
        for (const k of META) if (e[k] !== undefined) meta[k] = e[k];
        const kind = e.kind === 'check' ? (e.ok ? 'validation_passed' : 'validation_held') : e.kind;
        event(row.id, e.actor, kind, e.text, Object.keys(meta).length ? meta : null, at);
        if (e.kind === 'check' && !e.ok) failedCheck = e.text.replace(/^Check failed\. /, '');
        if (e.actor === 'agent' && ['text', 'portal', 'call'].includes(e.kind)) {
          db.prepare('INSERT INTO messages(id,case_id,dedupe_key,channel,body,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(), row.id, `${row.id}:${n++}`, e.kind, e.text, at);
        }
        if (e.kind === 'handoff') {
          newHandoff = true;
          const reason = e.handoffKind === 'hold' && failedCheck ? `${failedCheck} ${e.text}` : e.text;
          db.prepare('INSERT INTO reviews(id,case_id,kind,who,reason,status,created_at) VALUES(?,?,?,?,?,?,?)')
            .run(randomUUID(), row.id, e.handoffKind, e.who, reason, e.handoffKind === 'surgery' ? 'fyi' : 'open', at);
        }
        if (e.kind === 'headsup') {
          db.prepare("INSERT INTO reviews(id,case_id,kind,who,reason,status,created_at) VALUES(?,?,'heads_up','Nurse navigator',?,'fyi',?)").run(randomUUID(), row.id, e.text, at);
        }
      }
      // Only the handoff the engine still holds stays open.
      const open = db.prepare("SELECT id,kind FROM reviews WHERE case_id=? AND status='open' ORDER BY rowid DESC").all(row.id);
      const keep = c.person && c.person.kind !== 'surgery' ? open.find(r => r.kind === c.person.kind) : null;
      for (const r of open) {
        if (keep && r.id === keep.id) continue;
        db.prepare("UPDATE reviews SET status='done',resolution=?,resolved_at=? WHERE id=?").run(keep && newHandoff ? 'Replaced by a newer handoff' : resolution || 'Resolved', now, r.id);
      }
      const coming = comingUp(c, today);
      db.prepare('UPDATE cases SET status=?,pathway=?,due=?,next_action=?,state_json=?,last_day=?,updated_at=? WHERE id=?')
        .run(caseStatus(c, today), c.step ? c.step.kind : c.started ? 'pathology' : null, c.step ? c.step.due || null : null,
          coming.length ? coming[0].date : null, JSON.stringify(c), lastDay, now, row.id);
    },

    reset() {
      transaction(() => {
        for (const table of ['events', 'messages', 'reviews', 'inputs', 'cases']) db.exec(`DELETE FROM ${table}`);
        db.prepare("DELETE FROM settings WHERE key='clock_offset_days'").run();
      });
    }
  };
}

module.exports = { openStore, httpError };
