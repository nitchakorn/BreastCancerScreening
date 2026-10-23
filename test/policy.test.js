const {test}=require('node:test');
const assert=require('node:assert/strict');
const {decide}=require('../server/policy.js');
const {examples,recordedRead}=require('../server/samples.js');
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
  const read=recordedRead(sample.text); change(read);
  const result=decide(sample.text,read,today);
  assert.equal(result.status,'needs_review');
  assert.equal(result.message,null);
  assert(result.problems.length>0);
});

test('valid BI-RADS 4A routes to biopsy using the existing rules',()=>{
  const doc=examples(today)[2];
  const result=decide(doc.text,recordedRead(doc.text),today);
  assert.equal(result.pathway,'biopsy');
  assert.equal(result.due,'2026-11-06');
  assert(result.message);
});

test('late report is handed off rather than starting fresh outreach past its threshold',()=>{
  const read=recordedRead(sample.text);
  const result=decide(sample.text,read,'2026-11-23');
  assert.equal(result.status,'needs_review');
  assert.equal(result.message,null);
  assert.match(result.review,/already beyond/);
});

test('BI-RADS 6 is explicitly held because this demo has no automated pathway',()=>{
  const text=sample.text.replace('BI-RADS 0','BI-RADS 6');
  const read=recordedRead(sample.text); read.birads='6';read.quotes.birads=read.quotes.birads.replace('BI-RADS 0','BI-RADS 6');
  assert.equal(decide(text,read,today).status,'needs_review');
});

test('a report that assesses each breast separately is followed breast by breast, most urgent first',()=>{
  const doc=examples(today).find(s=>s.id==='P10-dx');
  const result=decide(doc.text,recordedRead(doc.text),today);
  assert.equal(result.pathway,'biopsy');
  assert.match(result.message,/for your right breast/);
});

test('a per-breast assessment whose quote is not in the report holds the whole report for a radiologist',()=>{
  const doc=examples(today).find(s=>s.id==='P10-dx');
  const read=recordedRead(doc.text);
  read.breasts[1].quotes.birads='BI-RADS 2: Benign.';
  const result=decide(doc.text,read,today);
  assert.equal(result.status,'needs_review');
  assert.equal(result.message,null);
  assert.match(result.review,/left breast's BI-RADS quote does not match/);
});

test('two assessments for the same breast are held too',()=>{
  const doc=examples(today).find(s=>s.id==='P10-dx');
  const read=recordedRead(doc.text);
  read.breasts[1].side='right';
  assert.equal(decide(doc.text,read,today).status,'needs_review');
});
