const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createApp } = require('../server/app.js');
const { createReader } = require('../server/reader.js');
const { examples } = require('../server/samples.js');

const date = '2026-10-23T12:00:00.000Z';
const samples = examples(date.slice(0,10));
const recorded = () => createReader({ env: { READER_MODE: 'recorded' } });
async function fixture(t, options = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(),'screening-test-'));
  const app = createApp({ dbPath:path.join(dir,'cases.sqlite'),reader:recorded(),clock:()=>date,...options });
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  return {app,dir,base};
}
function submit(base, report, extra = {}) {
  return fetch(base+'/api/cases',{ method:'POST',headers:{'content-type':'application/json',...extra.headers},body:JSON.stringify({patient:'Synthetic patient',report,...extra.body}) });
}

test('upload → recorded read → persisted diagnostic case → one test message',async t=>{
  const {app,base}=await fixture(t);
  const response=await submit(base,samples[0].text);
  assert.equal(response.status,202);
  const saved=await response.json();
  assert.equal(saved.case.status,'queued');
  await app.runOnce();
  const item=(await (await fetch(base+'/api/cases/'+saved.case.id)).json()).case;
  assert.equal(item.status,'awaiting_booking');
  assert.equal(item.pathway,'diagnostic');
  assert.equal(item.due,'2026-11-06');
  assert.equal(item.readerMode,'recorded');
  assert.equal(item.messages.length,1);
  assert.equal(item.reviews.length,0);
  assert(item.events.some(e=>e.kind==='validation_passed'));
  assert(item.events.some(e=>e.detail.includes('no model API call')));
  await app.runOnce();
  assert.equal(app.store.get(item.id).messages.length,1);
});

test('concurrent duplicate submissions create one case and one message',async t=>{
  const {app,base}=await fixture(t);
  const responses=await Promise.all(Array.from({length:8},()=>submit(base,samples[0].text)));
  const results=await Promise.all(responses.map(r=>r.json()));
  assert.equal(new Set(results.map(r=>r.case.id)).size,1);
  assert.equal(results.filter(r=>r.created).length,1);
  await app.runOnce();
  assert.equal(app.store.list().length,1);
  assert.equal(app.store.get(results[0].case.id).messages.length,1);
});

test('completed case and message survive reopen; an interrupted read is recovered',async()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'screening-restart-'));
  const dbPath=path.join(dir,'cases.sqlite');
  let app;
  try {
    app=createApp({dbPath,reader:recorded(),clock:()=>date});
    const first=app.store.create('First',samples[0].text,null,date).case.id;
    await app.runOnce();
    const pending=app.store.create('Second',samples[1].text,null,date).case.id;
    app.store.claim(date,'recorded');
    await app.close();
    app=createApp({dbPath,reader:recorded(),clock:()=>date});
    assert.equal(app.store.get(first).messages.length,1);
    assert.equal(app.store.get(pending).status,'queued');
    await app.runOnce();
    await app.runOnce();
    assert.equal(app.store.get(first).messages.length,1);
    assert.equal(app.store.get(pending).status,'closed');
    assert(app.store.get(pending).events.some(e=>e.kind==='read_recovered'));
  } finally {if(app)await app.close();rmSync(dir,{recursive:true,force:true});}
});

test('conflicting report creates a human review and sends no patient message',async t=>{
  const {app,base}=await fixture(t);
  const saved=await (await submit(base,samples[3].text)).json();
  await app.runOnce();
  const item=app.store.get(saved.case.id);
  assert.equal(item.status,'needs_review');
  assert.equal(item.messages.length,0);
  assert.equal(item.reviews.length,1);
  assert.match(item.reviews[0].reason,/findings and impression/);
});

test('BI-RADS 5 creates a navigator heads-up while booking outreach proceeds',async t=>{
  const {app,base}=await fixture(t);
  const saved=await (await submit(base,samples[5].text)).json();
  await app.runOnce();
  const item=app.store.get(saved.case.id);
  assert.equal(item.pathway,'biopsy');
  assert.equal(item.status,'awaiting_booking');
  assert.equal(item.messages.length,1);
  assert.equal(item.reviews[0].kind,'heads_up');
});

test('pathology goes to a person and never delivers a result to the test inbox',async t=>{
  const {app,base}=await fixture(t);
  const expected={'P7-path':['needs_review','concordance'],'P8-path':['closed','surgery']};
  for (const sample of samples.slice(6)) {
    const saved=await (await submit(base,sample.text)).json();
    await app.runOnce();
    const item=app.store.get(saved.case.id);
    assert.equal(item.status,expected[sample.id][0]);
    assert.equal(item.messages.length,0);
    assert.equal(item.reviews.length,1);
    assert.equal(item.reviews[0].kind,expected[sample.id][1]);
  }
});

test('six-month initial reminder fires once when its date arrives',async t=>{
  let now=date;
  const {app,base}=await fixture(t,{clock:()=>now});
  const saved=await (await submit(base,samples[4].text)).json();
  await app.runOnce();
  let item=app.store.get(saved.case.id);
  assert.equal(item.status,'waiting_reminder');
  assert.equal(item.nextAction,'2027-03-23');
  assert.equal(item.messages.length,0);
  now='2027-03-23T12:00:00.000Z';
  await app.runOnce(); await app.runOnce();
  item=app.store.get(saved.case.id);
  assert.equal(item.status,'awaiting_booking');
  assert.equal(item.messages.length,1);
});

test('a six-month case that never books gets the full reminder series, then a navigator one month after it is due',async t=>{
  let now=date;
  const {app,base}=await fixture(t,{clock:()=>now});
  const id=(await (await submit(base,samples[4].text)).json()).case.id;
  await app.runOnce();
  now='2027-05-22T12:00:00.000Z'; await app.runOnce();
  let item=app.store.get(id);
  assert.equal(item.status,'awaiting_booking');
  assert.deepEqual(item.messages.map(m=>[m.createdAt.slice(0,10),m.channel]),[
    ['2027-03-23','text'],['2027-03-30','portal'],['2027-04-06','call'],['2027-04-16','text'],['2027-04-23','text'],['2027-05-07','portal']]);
  now='2027-05-23T12:00:00.000Z'; await app.runOnce();
  item=app.store.get(id);
  assert.equal(item.status,'needs_review');
  assert.match(item.reviews[0].reason,/one month after the due date/);
  assert.equal(item.messages.length,6);
});

test('sample exam dates follow the configured local date across UTC midnight',async t=>{
  const {base}=await fixture(t,{clock:()=> '2026-10-23T01:00:00.000Z',timeZone:'America/New_York'});
  const data=await (await fetch(base+'/api/examples')).json();
  assert(data.every(item=>item.text.includes('DATE: 10/22/2026')));
});

test('provider failure saves a retryable case; retry reuses it and sends once',async t=>{
  let attempts=0;
  const real=recorded();
  const reader={status:()=>({mode:'live',configured:true,model:'test-double'}),async read(text){
    attempts++;
    if(attempts===1)throw Object.assign(new Error('Claude returned HTTP 429. Retry later.'),{code:'provider_error'});
    return real.read(text);
  }};
  const {app,base}=await fixture(t,{reader});
  const saved=await (await submit(base,samples[0].text)).json();
  await app.runOnce();
  assert.equal(app.store.get(saved.case.id).status,'read_failed');
  assert.equal(app.store.get(saved.case.id).messages.length,0);
  await fetch(base+`/api/cases/${saved.case.id}/retry`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  await app.runOnce();
  assert.equal(app.store.list().length,1);
  assert.equal(app.store.get(saved.case.id).messages.length,1);
  await fetch(base+`/api/cases/${saved.case.id}/retry`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  await app.runOnce();
  assert.equal(attempts,2);
});

test('recorded mode fails honestly on a new report, without silently using another fixture',async t=>{
  const {app,base}=await fixture(t);
  const saved=await (await submit(base,samples[0].text+'\nA new finding.')).json();
  await app.runOnce();
  const item=app.store.get(saved.case.id);
  assert.equal(item.status,'read_failed');
  assert.match(item.problems[0],/Recorded mode recognizes only/);
  assert.equal(item.messages.length,0);
});

test('malformed model output goes to human review, not a patient message',async t=>{
  const reader={status:()=>({mode:'live',configured:true}),async read(){throw Object.assign(new Error('unusable output'),{code:'invalid_output'});}};
  const {app,base}=await fixture(t,{reader});
  const saved=await (await submit(base,samples[0].text)).json();
  await app.runOnce();
  const item=app.store.get(saved.case.id);
  assert.equal(item.status,'needs_review');
  assert.equal(item.messages.length,0);
});

test('HTTP validation rejects invalid bodies, cross-origin writes, oversized reports and key conflicts',async t=>{
  const {base}=await fixture(t);
  assert.equal((await submit(base,samples[0].text,{headers:{origin:'https://untrusted.example'}})).status,403);
  assert.equal((await fetch(base+'/api/cases',{method:'POST',headers:{'content-type':'text/plain'},body:'hello'})).status,415);
  assert.equal((await fetch(base+'/api/cases',{method:'POST',headers:{'content-type':'application/json'},body:'{'})).status,400);
  assert.equal((await submit(base,'too short')).status,400);
  assert.equal((await submit(base,'x'.repeat(40000))).status,413);
  assert.equal((await submit(base,samples[0].text,{headers:{'idempotency-key':'fixed-key'}})).status,202);
  assert.equal((await submit(base,samples[1].text,{headers:{'idempotency-key':'fixed-key'}})).status,409);
  const badHostStatus=await new Promise((resolve,reject)=>{
    const request=http.get(base+'/api/health',{headers:{host:'attacker.example'}},response=>{response.resume();resolve(response.statusCode);});
    request.on('error',reject);
  });
  assert.equal(badHostStatus,403);
  assert.equal((await fetch(base+'/server/store.js')).status,404);
  const data=await (await fetch(base+'/api/examples')).json();
  assert.equal(data.length,8);
  assert(data.every(item=>item.text.includes('DATE: 10/23/2026')));
});

test('the simulation page links to the workspace, and the local server serves it',async t=>{
  const {base}=await fixture(t);
  const page=await (await fetch(base+'/workspace.html')).text();
  assert.match(page,/Agent workspace/);
  assert.match(await (await fetch(base+'/simulation')).text(),/href="workspace.html"/);
});
