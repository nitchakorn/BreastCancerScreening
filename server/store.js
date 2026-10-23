const { DatabaseSync } = require('node:sqlite');
const { randomUUID, createHash } = require('node:crypto');
const { mkdirSync } = require('node:fs');
const path = require('node:path');

function openStore(filename) {
  if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS cases (
      id TEXT PRIMARY KEY, intake_key TEXT NOT NULL UNIQUE, patient TEXT NOT NULL, report TEXT NOT NULL,
      status TEXT NOT NULL, pathway TEXT, due TEXT, next_action TEXT, read_json TEXT, model TEXT, reader_mode TEXT,
      problems_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, case_id TEXT NOT NULL REFERENCES cases(id),
      kind TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), dedupe_key TEXT NOT NULL UNIQUE,
      body TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), kind TEXT NOT NULL,
      reason TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(case_id, kind)
    );`);
  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = work(); db.exec('COMMIT'); return result; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  function event(id, kind, detail, now) {
    db.prepare('INSERT INTO events(case_id,kind,detail,created_at) VALUES(?,?,?,?)').run(id, kind, detail, now);
  }
  function get(id) {
    const row = db.prepare('SELECT * FROM cases WHERE id=?').get(id);
    if (!row) return null;
    return {
      id: row.id, patient: row.patient, report: row.report, status: row.status, pathway: row.pathway,
      due: row.due, nextAction: row.next_action, read: row.read_json ? JSON.parse(row.read_json) : null,
      model: row.model, readerMode: row.reader_mode, problems: JSON.parse(row.problems_json), createdAt: row.created_at, updatedAt: row.updated_at,
      events: db.prepare('SELECT seq,kind,detail,created_at AS createdAt FROM events WHERE case_id=? ORDER BY seq').all(id),
      messages: db.prepare('SELECT id,body,created_at AS createdAt FROM messages WHERE case_id=? ORDER BY created_at,id').all(id),
      reviews: db.prepare('SELECT id,kind,reason,created_at AS createdAt FROM reviews WHERE case_id=?').all(id)
    };
  }
  function addReview(id, kind, reason, now) {
    const inserted = db.prepare('INSERT OR IGNORE INTO reviews(id,case_id,kind,reason,created_at) VALUES(?,?,?,?,?)').run(randomUUID(), id, kind, reason, now);
    if (inserted.changes) event(id, 'human_review_created', reason, now);
  }
  function addMessage(id, body, now) {
    const inserted = db.prepare('INSERT OR IGNORE INTO messages(id,case_id,dedupe_key,body,created_at) VALUES(?,?,?,?,?)').run(randomUUID(), id, id + ':initial-booking', body, now);
    if (inserted.changes) event(id, 'test_message_sent', 'Initial booking message delivered to the local test inbox. No external message was sent.', now);
  }
  return {
    get,
    list() { return db.prepare('SELECT id,patient,status,pathway,due,model,created_at AS createdAt FROM cases ORDER BY created_at DESC,rowid DESC').all(); },
    create(patient, report, requestKey, now) {
      return transaction(() => {
        const fingerprint = createHash('sha256').update(JSON.stringify([patient, report])).digest('hex');
        const key = requestKey || fingerprint;
        const existing = db.prepare('SELECT id,patient,report FROM cases WHERE intake_key=?').get(key);
        if (existing) {
          if (existing.patient !== patient || existing.report !== report) {
            const e = new Error('This request key belongs to a different report.'); e.status = 409; throw e;
          }
          return { case: get(existing.id), created: false };
        }
        const id = randomUUID();
        db.prepare('INSERT INTO cases(id,intake_key,patient,report,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id,key,patient,report,'queued',now,now);
        event(id,'report_saved','Synthetic report saved; queued for a report read.',now);
        return { case: get(id), created: true };
      });
    },
    recover(now) {
      transaction(() => {
        for (const row of db.prepare("SELECT id FROM cases WHERE status='reading'").all()) {
          db.prepare("UPDATE cases SET status='queued',updated_at=? WHERE id=?").run(now,row.id);
          event(row.id,'read_recovered','An interrupted read was requeued after restart. Local message delivery remains deduplicated.',now);
        }
      });
    },
    claim(now, mode) {
      return transaction(() => {
        const next = db.prepare("SELECT id,report FROM cases WHERE status='queued' ORDER BY created_at,rowid LIMIT 1").get();
        if (!next) return null;
        db.prepare("UPDATE cases SET status='reading',updated_at=? WHERE id=?").run(now,next.id);
        event(next.id,'reader_requested',mode === 'recorded' ? 'Requested the matching recorded sample read. No model API call.' : 'Requested a live Claude structured read. Source documents cannot select actions or tools.',now);
        return next;
      });
    },
    complete(id, result, decision, now) {
      transaction(() => {
        db.prepare('UPDATE cases SET status=?,pathway=?,due=?,next_action=?,read_json=?,model=?,reader_mode=?,problems_json=?,updated_at=? WHERE id=?')
          .run(decision.status,decision.pathway,decision.due,decision.nextAction,result.read ? JSON.stringify(result.read) : null,result.model || null,result.mode || null,JSON.stringify(decision.problems),now,id);
        event(id,'read_completed',result.mode === 'recorded' ? 'Used the recorded sample read; no model API call.' : result.model ? `Live read returned by ${result.model}.` : 'No usable structured read was returned.',now);
        event(id,decision.problems.length ? 'validation_held' : 'validation_passed',decision.problems.join(' ') || 'Required evidence matches the source; extracted dates and BI-RADS agree with their quotes.',now);
        event(id,'pathway_selected',`Pathway: ${decision.pathway}. State: ${decision.status}.` + (decision.due ? ` Due: ${decision.due}.` : ''),now);
        if (decision.review) addReview(id,'hold',decision.review,now);
        if (decision.headsUp) addReview(id,'heads_up','BI-RADS 5: navigator heads-up. Booking outreach continues.',now);
        if (decision.message) addMessage(id,decision.message,now);
        if (decision.status === 'closed') event(id,'case_closed','Routine screening; no patient outreach is needed.',now);
      });
    },
    fail(id, message, now) {
      transaction(() => {
        db.prepare("UPDATE cases SET status='read_failed',problems_json=?,updated_at=? WHERE id=?").run(JSON.stringify([message]),now,id);
        event(id,'read_failed',message,now);
      });
    },
    retry(id, now) {
      return transaction(() => {
        const row = db.prepare('SELECT status FROM cases WHERE id=?').get(id);
        if (!row) return false;
        if (row.status === 'read_failed') {
          db.prepare("UPDATE cases SET status='queued',problems_json='[]',updated_at=? WHERE id=?").run(now,id);
          event(id,'read_retried','Requeued the existing case; no duplicate case or test message created.',now);
        }
        return true;
      });
    },
    sendDue(now, today = now.slice(0,10)) {
      transaction(() => {
        for (const row of db.prepare("SELECT id,due FROM cases WHERE status='waiting_reminder' AND next_action<=?").all(today)) {
          const A = require('../agent/agent.js');
          if (today >= A.addMonths(row.due,1)) {
            db.prepare("UPDATE cases SET status='needs_review',updated_at=? WHERE id=?").run(now,row.id);
            addReview(row.id,'hold','Six-month follow-up is at least one month overdue. Navigator review is required.',now);
          } else {
            addMessage(row.id,`Your six-month follow-up imaging is due ${row.due}. Use the test booking inbox or ask for help.`,now);
            db.prepare("UPDATE cases SET status='awaiting_booking',updated_at=? WHERE id=?").run(now,row.id);
          }
        }
      });
    },
    close() { db.close(); }
  };
}

module.exports = { openStore };
