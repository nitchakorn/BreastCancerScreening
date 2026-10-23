const { randomUUID, createHash } = require('node:crypto');

function replyStore({ db, transaction, event, addReview, addMessage, get }) {
  // Additive migration keeps existing case databases usable.
  if (!db.prepare('PRAGMA table_info(cases)').all().some(column => column.name === 'booking_claimed')) db.exec('ALTER TABLE cases ADD COLUMN booking_claimed INTEGER NOT NULL DEFAULT 0');
  db.exec(`CREATE TABLE IF NOT EXISTS replies (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, case_id TEXT NOT NULL REFERENCES cases(id),
    request_key TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, read_json TEXT, model TEXT, reader_mode TEXT,
    problems_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(case_id,request_key)
  );`);
  function listReplies(caseId) {
    return db.prepare('SELECT * FROM replies WHERE case_id=? ORDER BY seq').all(caseId).map(row => ({
      id: row.id, text: row.text, status: row.status, read: row.read_json ? JSON.parse(row.read_json) : null,
      model: row.model, readerMode: row.reader_mode, problems: JSON.parse(row.problems_json), createdAt: row.created_at, updatedAt: row.updated_at
    }));
  }
  function conflict(message) { return Object.assign(new Error(message), { status: 409 }); }
  function newer(row) { return Boolean(db.prepare('SELECT 1 FROM replies WHERE case_id=? AND seq>? LIMIT 1').get(row.case_id,row.seq)); }
  return {
    listReplies,
    createReply(caseId, text, requestKey, now) {
      return transaction(() => {
        const parent = db.prepare('SELECT status FROM cases WHERE id=?').get(caseId);
        if (!parent) return null;
        const key = requestKey || createHash('sha256').update(text).digest('hex');
        const existing = db.prepare('SELECT id,text FROM replies WHERE case_id=? AND request_key=?').get(caseId,key);
        if (existing) {
          if (existing.text !== text) throw conflict('This reply request key belongs to different text.');
          return { case: get(caseId), replyId: existing.id, created: false };
        }
        if (parent.status === 'closed' || !db.prepare('SELECT 1 FROM messages WHERE case_id=?').get(caseId)) throw conflict('Replies are available after the first test message, while the case remains open.');
        const id = randomUUID(), held = parent.status === 'needs_review';
        db.prepare('INSERT INTO replies(id,case_id,request_key,text,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id,caseId,key,text,held ? 'review' : 'queued',now,now);
        event(caseId,'patient_reply_saved','Synthetic patient reply saved before processing.',now);
        db.prepare('UPDATE cases SET status=?,updated_at=? WHERE id=?').run(held ? 'needs_review' : 'reply_pending',now,caseId);
        if (held) {
          addReview(caseId,'reply:'+id,'A new reply arrived while this case is with a navigator. Automated responses remain paused.',now);
          event(caseId,'reply_kept_for_review','The case is already held for a person; no automated response was sent.',now);
        }
        return { case: get(caseId), replyId: id, created: true };
      });
    },
    recoverReplies(now) {
      transaction(() => {
        for (const row of db.prepare("SELECT id,case_id FROM replies WHERE status='reading'").all()) {
          db.prepare("UPDATE replies SET status='queued',updated_at=? WHERE id=?").run(now,row.id);
          event(row.case_id,'reply_read_recovered','Interrupted reply read requeued. Reply assistance remains deduplicated.',now);
        }
      });
    },
    claimReply(now, mode) {
      return transaction(() => {
        const row = db.prepare("SELECT * FROM replies WHERE status='queued' ORDER BY seq LIMIT 1").get();
        if (!row) return null;
        const parent = db.prepare('SELECT status FROM cases WHERE id=?').get(row.case_id);
        if (parent.status === 'needs_review' || parent.status === 'closed') {
          db.prepare("UPDATE replies SET status='review',updated_at=? WHERE id=?").run(now,row.id);
          event(row.case_id,'reply_kept_for_review','A person now owns this case; the queued reply will not trigger an automated response.',now);
          return null;
        }
        db.prepare("UPDATE replies SET status='reading',updated_at=? WHERE id=?").run(now,row.id);
        event(row.case_id,'reply_reader_requested',mode === 'recorded' ? 'Using a reply fixture; no model API call.' : 'Requested a live Claude reply read with supporting evidence.',now);
        return row;
      });
    },
    completeReply(id, result, decision, now) {
      transaction(() => {
        const row = db.prepare('SELECT * FROM replies WHERE id=?').get(id);
        const parent = db.prepare('SELECT status,booking_claimed FROM cases WHERE id=?').get(row.case_id);
        const held = parent.status === 'needs_review' || parent.status === 'closed';
        const superseded = newer(row) && !decision.review;
        db.prepare('UPDATE replies SET status=?,read_json=?,model=?,reader_mode=?,problems_json=?,updated_at=? WHERE id=?')
          .run(held || decision.review ? 'review' : superseded ? 'superseded' : 'processed',result.read ? JSON.stringify(result.read) : null,result.model || null,result.mode || null,JSON.stringify(decision.problems),now,id);
        event(row.case_id,'reply_read_completed',result.mode === 'recorded' ? 'Reply fixture read completed; no model API call.' : result.model ? `Reply read returned by ${result.model}.` : 'No usable reply read was returned.',now);
        if (decision.review || held) {
          const reason = decision.review || 'A person owns this case. Automated responses remain paused.';
          addReview(row.case_id,'reply:'+id,reason,now);
          db.prepare("UPDATE cases SET status='needs_review',updated_at=? WHERE id=?").run(now,row.case_id);
          event(row.case_id,'reply_handoff',reason,now);
        } else if (superseded) {
          event(row.case_id,'reply_superseded','A newer reply arrived. Waiting for that reply before sending automated assistance.',now);
        } else {
          const claimed = parent.booking_claimed || decision.booked;
          db.prepare('UPDATE cases SET status=?,booking_claimed=?,updated_at=? WHERE id=?').run(claimed ? 'booking_claimed' : 'awaiting_booking',claimed ? 1 : 0,now,row.case_id);
          if (decision.booked) event(row.case_id,'booking_claim_recorded','The patient says they booked. No scheduling integration is configured, so the appointment remains unverified and the case remains open.',now);
          for (const message of decision.messages) addMessage(row.case_id,message.body,now,'reply:'+id+':'+message.kind);
          event(row.case_id,'reply_action_selected',decision.booked ? 'Awaiting independent booking verification.' : 'Practical assistance offered in the test inbox.',now);
        }
      });
    },
    failReply(id, message, now) {
      transaction(() => {
        const row = db.prepare('SELECT * FROM replies WHERE id=?').get(id);
        db.prepare("UPDATE replies SET status='read_failed',problems_json=?,updated_at=? WHERE id=?").run(JSON.stringify([message]),now,id);
        const parent = db.prepare('SELECT status FROM cases WHERE id=?').get(row.case_id);
        if (parent.status !== 'needs_review') db.prepare('UPDATE cases SET status=?,updated_at=? WHERE id=?').run(newer(row) ? 'reply_pending' : 'reply_failed',now,row.case_id);
        event(row.case_id,'reply_read_failed',message+' Automated outreach remains paused.',now);
      });
    },
    retryReply(caseId, id, now) {
      return transaction(() => {
        const row = db.prepare('SELECT * FROM replies WHERE id=? AND case_id=?').get(id,caseId);
        if (!row) return false;
        if (row.status !== 'read_failed') return true;
        if (newer(row)) throw conflict('A newer reply exists. An earlier failed reply cannot be replayed.');
        if (db.prepare('SELECT status FROM cases WHERE id=?').get(caseId).status === 'needs_review') throw conflict('A navigator owns this case. The failed reply is retained for review.');
        db.prepare("UPDATE replies SET status='queued',problems_json='[]',updated_at=? WHERE id=?").run(now,id);
        db.prepare("UPDATE cases SET status='reply_pending',updated_at=? WHERE id=?").run(now,caseId);
        event(caseId,'reply_read_retried','Requeued the saved reply; existing assistance will not be resent.',now);
        return true;
      });
    }
  };
}

module.exports = { replyStore };
