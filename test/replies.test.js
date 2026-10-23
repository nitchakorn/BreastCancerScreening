const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { createApp } = require('../server/app.js');
const { createReader } = require('../server/reader.js');
const { examples } = require('../server/samples.js');
const { replyExamples } = require('../server/reply-samples.js');
const { decideReply } = require('../server/reply-policy.js');
const now = '2026-10-23T12:00:00.000Z';
const sample = examples('2026-10-23')[0];
const replies = replyExamples();
const text = id => replies.find(row => row.id === id).text;
const reader = () => createReader({ env: { READER_MODE: 'recorded' } });

async function fixture(t, customReader = reader(), clock = () => now) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'reply-test-'));
  const app = createApp({ dbPath: path.join(dir,'cases.sqlite'), reader: customReader, clock });
  await new Promise(resolve => app.server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); rmSync(dir,{recursive:true,force:true}); });
  const caseId = app.store.create('Synthetic reply patient',sample.text,null,now).case.id;
  await app.runOnce();
  const post = (body, key, caseOverride = caseId) => fetch(`${base}/api/cases/${caseOverride}/replies`, {
    method:'POST',headers:{'content-type':'application/json',...(key ? {'idempotency-key':key} : {})},body:JSON.stringify({text:body})
  });
  return { app,base,caseId,post };
}

test('ride and time replies produce persisted assistance with reader evidence',async t => {
  const {app,caseId,post}=await fixture(t);
  for(const id of ['P3-r1','new-time']) {
    const result=await post(text(id));assert.equal(result.status,202);
    assert.equal(app.store.get(caseId).status,'reply_pending');
    await app.runOnce();
  }
  const item=app.store.get(caseId);
  assert.equal(item.messages.length,3);
  assert.equal(item.replies.length,2);
  assert(item.replies.every(row=>row.status==='processed'&&row.readerMode==='recorded'&&row.read.quote));
  assert(item.messages.some(row=>/ride-support/.test(row.body)));
  assert(item.messages.some(row=>/sample options/.test(row.body)));
  assert(item.messages.slice(1).every(row=>row.replyId));
  assert.equal(item.status,'awaiting_booking');
});

for(const id of ['P7-r1','medical','decline','wrong-number']) test(`${id} pauses automation and further replies remain with review`,async t => {
  let calls=0;const underlying=reader();
  const custom={status:()=>underlying.status(),read:value=>underlying.read(value),async readReply(value){calls++;return underlying.readReply(value);}};
  const {app,caseId,post}=await fixture(t,custom);
  await post(text(id));await app.runOnce();
  let item=app.store.get(caseId);
  assert.equal(item.status,'needs_review');assert.equal(item.messages.length,1);assert.equal(item.reviews.length,1);
  await post(text('P3-r1'));await app.runOnce();
  item=app.store.get(caseId);
  assert.equal(item.status,'needs_review');assert.equal(item.messages.length,1);
  assert.equal(item.replies[1].status,'review');assert.equal(calls,1);
});

test('a booking claim stays unverified, even after a later practical reply',async t => {
  const {app,caseId,post}=await fixture(t);
  await post(text('P8-r1'));await app.runOnce();
  let item=app.store.get(caseId);
  assert.equal(item.status,'booking_claimed');assert.equal(item.bookingClaimed,true);
  assert.equal(item.messages.length,1);assert(item.events.some(row=>row.kind==='booking_claim_recorded'));
  await post(text('P3-r1'));await app.runOnce();
  item=app.store.get(caseId);
  assert.equal(item.status,'booking_claimed');assert.equal(item.due,'2026-11-06');
  assert(!item.events.some(row=>row.kind==='case_closed'));
});

for(const state of ['booking_claimed','reply_pending','reply_failed']) test(`unbooked deadline still hands off a case in ${state}`,async t=>{
  let current=now;
  const {app,caseId,post}=await fixture(t,reader(),()=>current);
  await post(state==='booking_claimed' ? text('P8-r1') : state==='reply_failed' ? 'An unknown reply.' : text('P3-r1'));
  if(state!=='reply_pending') await app.runOnce();
  assert.equal(app.store.get(caseId).status,state);
  current='2026-11-22T12:00:00.000Z';
  await app.runOnce();
  const item=app.store.get(caseId);
  assert.equal(item.status,'needs_review');assert.equal(item.messages.length,1);
  assert(item.reviews.some(row=>/not booked within 30 days/.test(row.reason)));
});

test('duplicate reply retries reuse a reply and its assistance; keys are scoped to the case',async t => {
  const {app,caseId,post}=await fixture(t);
  const submissions=await Promise.all(Array.from({length:6},()=>post(text('P3-r1'),'same-request')));
  const results=await Promise.all(submissions.map(row=>row.json()));
  assert.equal(new Set(results.map(row=>row.replyId)).size,1);
  await app.runOnce();await app.runOnce();
  assert.equal(app.store.get(caseId).messages.length,2);
  assert.equal(app.store.get(caseId).replies.length,1);
  assert.equal((await post(text('P8-r1'),'same-request')).status,409);
  await post(text('P3-r1'),'a-new-intent');await app.runOnce();
  assert.equal(app.store.get(caseId).replies.length,2);
});

test('unknown fixture text fails explicitly and pauses the case until a retry or new reply',async t => {
  const {app,caseId,post,base}=await fixture(t);
  const saved=await (await post('Some new wording outside the reply fixtures.')).json();
  await app.runOnce();
  let item=app.store.get(caseId);
  assert.equal(item.status,'reply_failed');assert.equal(item.messages.length,1);
  assert.match(item.replies[0].problems[0],/sample replies/);
  await post(text('P3-r1'));await app.runOnce();
  item=app.store.get(caseId);assert.equal(item.messages.length,2);
  const retry=await fetch(`${base}/api/cases/${caseId}/replies/${saved.replyId}/retry`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  assert.equal(retry.status,409);
});

test('a transient reply provider failure can be retried without duplicating delivery',async t => {
  const underlying=reader();let calls=0;
  const custom={status:()=>underlying.status(),read:value=>underlying.read(value),async readReply(value){if(++calls===1)throw Object.assign(new Error('Claude returned HTTP 429.'),{code:'provider_error'});return underlying.readReply(value);}};
  const {app,caseId,post,base}=await fixture(t,custom);
  const saved=await (await post(text('P3-r1'))).json();await app.runOnce();
  assert.equal(app.store.get(caseId).status,'reply_failed');
  const retry=()=>fetch(`${base}/api/cases/${caseId}/replies/${saved.replyId}/retry`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  await retry();await app.runOnce();await retry();await app.runOnce();
  assert.equal(calls,2);assert.equal(app.store.get(caseId).messages.length,2);
});

test('a newer reply suppresses stale assistance while an older handoff still takes priority',async t => {
  for(const [first,second,expectCalls] of [['P3-r1','P7-r1',2],['P7-r1','P3-r1',1]]) {
    let release,started;const gate=new Promise(resolve=>{release=resolve;});const entered=new Promise(resolve=>{started=resolve;});
    const underlying=reader();let calls=0;
    const custom={status:()=>underlying.status(),read:value=>underlying.read(value),async readReply(value){if(++calls===1){started();await gate;}return underlying.readReply(value);}};
    const {app,caseId,post}=await fixture(t,custom);
    await post(text(first));const processing=app.runOnce();await entered;
    await post(text(second));release();await processing;await app.runOnce();
    const item=app.store.get(caseId);
    assert.equal(item.status,'needs_review');assert.equal(item.messages.length,1);assert.equal(calls,expectCalls);
  }
});

test('invalid or missing reply evidence goes to review without practical assistance',async t => {
  for(const bad of [null,{labels:['transport_barrier'],quote:'invented',summary:'Needs a ride'},{labels:['invented_action'],quote:text('P3-r1'),summary:'Unsupported action'}]) {
    const underlying=reader();
    const custom={status:()=>underlying.status(),read:value=>underlying.read(value),async readReply(){return {read:bad,mode:'live',model:'test-double'};}};
    const {app,caseId,post}=await fixture(t,custom);
    await post(text('P3-r1'));await app.runOnce();
    const item=app.store.get(caseId);assert.equal(item.status,'needs_review');assert.equal(item.messages.length,1);
  }
});

test('exceptions take priority over practical labels and booking claims',() => {
  const result=decideReply('I booked but I am scared.',{labels:['booked','transport_barrier','scared_or_worried'],quote:'I booked but I am scared.',summary:'The patient is scared.'});
  assert.equal(result.status,'needs_review');assert.equal(result.messages.length,0);assert.equal(result.booked,false);
});

test('interrupted reply reads recover after restart and completed assistance remains deduplicated',async()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'reply-restart-'));const dbPath=path.join(dir,'cases.sqlite');let app;
  try {
    app=createApp({dbPath,reader:reader(),clock:()=>now});
    const id=app.store.create('Recovery',sample.text,null,now).case.id;await app.runOnce();
    const reply=app.store.createReply(id,text('P3-r1'),'recovery',now);
    app.store.claimReply(now,'recorded');await app.close();
    app=createApp({dbPath,reader:reader(),clock:()=>now});
    assert.equal(app.store.get(id).replies[0].status,'queued');await app.runOnce();
    assert.equal(app.store.get(id).messages.length,2);
    app.store.createReply(id,text('P3-r1'),'recovery',now);await app.runOnce();
    assert.equal(app.store.get(id).messages.length,2);assert.equal(app.store.get(id).replies[0].id,reply.replyId);
  }finally{if(app)await app.close();rmSync(dir,{recursive:true,force:true});}
});

test('legacy database migration preserves the original cases and messages',async()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'reply-migration-'));const dbPath=path.join(dir,'cases.sqlite');let app;
  try {
    app=createApp({dbPath,reader:reader(),clock:()=>now});
    const id=app.store.create('Legacy',sample.text,null,now).case.id;await app.runOnce();await app.close();
    const db=new DatabaseSync(dbPath);db.exec('DROP TABLE replies; ALTER TABLE cases DROP COLUMN booking_claimed;');db.close();
    app=createApp({dbPath,reader:reader(),clock:()=>now});
    assert.equal(app.store.get(id).messages.length,1);assert.deepEqual(app.store.get(id).replies,[]);
    app.store.createReply(id,text('P3-r1'),null,now);await app.runOnce();
    assert.equal(app.store.get(id).messages.length,2);
  }finally{if(app)await app.close();rmSync(dir,{recursive:true,force:true});}
});

test('reply endpoints validate case ownership, input and pre-outreach/closed state',async t=>{
  const {app,caseId,post,base}=await fixture(t);
  assert.equal((await post('')).status,400);assert.equal((await post('a'.repeat(2001))).status,400);
  assert.equal((await post(text('P3-r1'),'bad key')).status,400);
  const pending=app.store.create('Pending',sample.text,null,now).case.id;
  assert.equal((await post(text('P3-r1'),null,pending)).status,409);
  const closed=app.store.create('Routine',examples('2026-10-23')[1].text,null,now).case.id;
  await app.runOnce();await app.runOnce();
  assert.equal((await post(text('P3-r1'),null,closed)).status,409);
  const saved=await (await post(text('P3-r1'))).json();
  assert.equal((await fetch(`${base}/api/cases/${closed}/replies/${saved.replyId}/retry`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,404);
  assert.equal((await fetch(base+'/api/reply-examples')).status,200);
  assert.equal(app.store.get(caseId).replies.length,1);
});
