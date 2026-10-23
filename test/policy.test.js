const {test}=require('node:test');
const assert=require('node:assert/strict');
const {decide}=require('../server/policy.js');
const {examples}=require('../server/samples.js');
const A=require('../agent/agent.js');
const ruleRead=text=>A.readReport(text);
const today='2026-10-23';
const sample=examples(today)[0];

for(const [name,change] of [
  ['missing date evidence',r=>{r.quotes.exam_date=null;}],
  ['invented quote',r=>{r.quotes.birads='BI-RADS 0: invented';}],
  ['different category hidden behind a real quote',r=>{r.birads='1';}],
  ['different date hidden behind a real quote',r=>{r.exam_date='2026-10-22';}],
  ['unknown findings agreement',r=>{r.findings_match_impression=null;}],
  ['conflicting evidence despite a matching-impression flag',r=>{r.mismatch_quote='focal asymmetry';}],
  ['missing recommendation quote',r=>{r.quotes.next_step=null;}],
  ['impossible date',r=>{r.exam_date='2026-02-30';}],
  ['future exam',r=>{r.exam_date='2027-10-23';}],
  ['malformed quote object',r=>{r.quotes.birads={text:'BI-RADS 0'};}],
  ['unsupported category shape',r=>{r.birads='0A';}]
]) test(`hold instead of outreach: ${name}`,()=>{
  const read=ruleRead(sample.text); change(read);
  const result=decide(sample.text,read,today);
  assert.equal(result.status,'needs_review');
  assert.equal(result.message,null);
  assert(result.problems.length>0);
});

test('valid BI-RADS 4A routes to biopsy using the existing rules',()=>{
  const doc=examples(today)[2];
  const result=decide(doc.text,ruleRead(doc.text),today);
  assert.equal(result.pathway,'biopsy');
  assert.equal(result.due,'2026-11-06');
  assert(result.message);
});

test('late report is handed off rather than starting fresh outreach past its threshold',()=>{
  const read=ruleRead(sample.text);
  const result=decide(sample.text,read,'2026-11-23');
  assert.equal(result.status,'needs_review');
  assert.equal(result.message,null);
  assert.match(result.review,/already beyond/);
});

test('BI-RADS 6 is explicitly held because this demo has no automated pathway',()=>{
  const text=sample.text.replace('BI-RADS 0','BI-RADS 6');
  const read=ruleRead(sample.text); read.birads='6';read.quotes.birads=read.quotes.birads.replace('BI-RADS 0','BI-RADS 6');
  assert.equal(decide(text,read,today).status,'needs_review');
});

test('a report that assesses each breast separately is followed breast by breast, most urgent first',()=>{
  const doc=examples(today).find(s=>s.id==='P10-dx');
  const result=decide(doc.text,ruleRead(doc.text),today);
  assert.equal(result.pathway,'biopsy');
  assert.match(result.message,/for your right breast/);
});

test('a per-breast assessment whose quote is not in the report holds the whole report for a radiologist',()=>{
  const doc=examples(today).find(s=>s.id==='P10-dx');
  const read=ruleRead(doc.text);
  read.breasts[1].quotes.birads='BI-RADS 2: Benign.';
  const result=decide(doc.text,read,today);
  assert.equal(result.status,'needs_review');
  assert.equal(result.message,null);
  assert.match(result.review,/left breast's BI-RADS quote does not match/);
});

test('two assessments for the same breast are held too',()=>{
  const doc=examples(today).find(s=>s.id==='P10-dx');
  const read=ruleRead(doc.text);
  read.breasts[1].side='right';
  assert.equal(decide(doc.text,read,today).status,'needs_review');
});

// The rules that read reports. The first version had Claude read every report; those reads are kept in
// reads/documents.json, and the rules must reach the same answer on every one of them.
test('the rules read every demo report the same way Claude did',()=>{
  const docs=require('../data/documents.json'), claude=require('../reads/documents.json');
  let compared=0;
  for(const d of docs){
    const rule=A.readReport(d.text), old=claude[d.id];
    assert.deepEqual(rule.unclear,[],d.id);
    for(const q of Object.values(rule.quotes)) if(q) assert(d.text.includes(q),`${d.id} quotes the report word for word`);
    if(!old) continue;
    for(const key of ['doc_type','exam_date','birads','side','pathology_result','findings_match_impression']) assert.equal(String(rule[key]),String(old[key]),`${d.id} ${key}`);
    assert.deepEqual(rule.breasts.map(b=>[b.side,b.birads]),(old.breasts||[]).map(b=>[b.side,b.birads]),`${d.id} breasts`);
    compared++;
  }
  assert.equal(compared,19);
});

test('a negative report whose findings describe a mass is held for a radiologist, with the finding quoted',()=>{
  const doc=examples(today).find(s=>s.id==='P9-screen');
  const read=A.readReport(doc.text);
  assert.equal(read.findings_match_impression,false);
  assert.match(read.mismatch_quote,/possible new 1.1 cm irregular mass/);
  const result=decide(doc.text,read,today);
  assert.equal(result.status,'needs_review');
  assert.equal(result.message,null);
});

test('the rules never guess: a report they cannot read cleanly goes to a radiologist',()=>{
  const base=examples(today)[0].text;
  for(const [name,text,why] of [
    ['no category',base.replace('BI-RADS 0: Incomplete.','Incomplete.'),/No BI-RADS category/],
    ['two categories with no breast named',examples(today).find(s=>s.id==='P1-screen').text.replace('BI-RADS 1: Negative.','BI-RADS 1: Negative. BI-RADS 2: Benign.'),/more than one BI-RADS category/],
    ['two categories for the same breast',base.replace('BI-RADS 0: Incomplete.','BI-RADS 0: Incomplete. BI-RADS 2: Benign.'),/right breast has two different BI-RADS categories/],
    ['no exam date',base.replace(/DATE: \d{2}\/\d{2}\/\d{4}/,'DATE: pending'),/No valid exam date/],
    ['unknown kind of report','NOTE: Patient called the clinic.\nIMPRESSION: BI-RADS 2: Benign.',/don't recognize/],
    ['overall assessment less urgent than one breast',examples(today).find(s=>s.id==='P10-dx').text.replace('OVERALL ASSESSMENT: BI-RADS 4A.','OVERALL ASSESSMENT: BI-RADS 3.'),/less urgent than the right breast/],
    ['unknown diagnosis','SURGICAL PATHOLOGY REPORT\nSPECIMEN: Left breast, core biopsy\nPROCEDURE DATE: 10/20/2026\nDIAGNOSIS: Specimen sent for consultation.',/isn't one the rules know/]
  ]){
    const read=A.readReport(text), result=decide(text,read,today);
    assert(read.unclear.some(u=>why.test(u)),`${name}: ${read.unclear}`);
    assert.equal(result.status,'needs_review',name);
    assert.equal(result.message,null,name);
  }
});

test('pathology rules ignore what a report rules out, and read cancer, atypia and benign results',()=>{
  const path=dx=>A.readReport(`SURGICAL PATHOLOGY REPORT\nSPECIMEN: Right breast, core biopsy\nPROCEDURE DATE: 10/20/2026\nDIAGNOSIS: ${dx}`).pathology_result;
  assert.equal(path('Fibroadenoma. Negative for atypia and malignancy.'),'benign');
  assert.equal(path('Benign breast tissue. No evidence of carcinoma.'),'benign');
  assert.equal(path('Invasive ductal carcinoma, Nottingham grade 2.'),'malignant');
  assert.equal(path('Ductal carcinoma in situ, intermediate grade.'),'malignant');
  assert.equal(path('Atypical ductal hyperplasia.'),'atypia');
  assert.equal(path('Lobular carcinoma in situ, classic type.'),'atypia');
  assert.equal(path('Nondiagnostic sample.'),'nondiagnostic');
});

test('Claude\'s comparison is used only when every quote is in the report it came from',()=>{
  const docs=Object.fromEntries(require('../data/documents.json').map(d=>[d.id,d.text]));
  const saved=require('../reads/comparisons.json');
  for(const [id,{imaging,comparison}] of Object.entries(saved)) assert.deepEqual(A.checkComparison(comparison,docs[imaging],docs[id]),[],id);
  const changed=structuredClone(saved['P11-path'].comparison);
  changed.flags[0].imaging_quote='a smooth round mass';
  assert.match(A.checkComparison(changed,docs['P11-dx'],docs['P11-path']).join(' '),/Concern 1 quotes the imaging report inexactly/);
  const noFlags=structuredClone(saved['P11-path'].comparison); noFlags.flags=[];
  assert.match(A.checkComparison(noFlags,docs['P11-dx'],docs['P11-path']).join(' '),/needs at least one concern/);
});

test('a BI-RADS 5 finding with a benign biopsy is flagged by rule, with or without Claude',()=>{
  const events=[], engine=A.createEngine({log:e=>events.push(e)}), c=A.newCase({id:'x',name:'Test',first:'Test'});
  const dx=examples(today).find(s=>s.id==='P8-dx').text, day=A.dayOf(today);
  engine.onDoc(c,{id:'dx',kind:'imaging',title:'Diagnostic report',text:dx},A.readReport(dx),day);
  const path='SURGICAL PATHOLOGY REPORT\nSPECIMEN: Right breast, core biopsy\nPROCEDURE DATE: 10/23/2026\nDIAGNOSIS: Benign breast tissue.';
  engine.onDoc(c,{id:'path',kind:'pathology',title:'Pathology report',text:path},A.readReport(path),day,{comparison:{error:'Not available.'}});
  assert(events.some(e=>e.kind==='flag'&&e.rule));
  const handoff=events.filter(e=>e.kind==='handoff').pop();
  assert.equal(handoff.handoffKind,'concordance');
  assert.match(handoff.text,/may not match the imaging/);
});
