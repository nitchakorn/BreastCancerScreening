const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createReader}=require('../server/reader.js');
const {examples,recordedRead}=require('../server/samples.js');
const sample=examples('2026-10-23')[0];
const response=data=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});

test('no key defaults to explicitly recorded mode and performs zero API calls',async()=>{
  const reader=createReader({env:{},fetchImpl:()=>{throw new Error('must not call network');}});
  assert.equal(reader.status().mode,'recorded');
  const result=await reader.read(sample.text);
  assert.equal(result.mode,'recorded');
  assert.match(result.model,/no API call/);
});

test('live reader discovers a model, requests a structured tool result and retains provenance',async()=>{
  const calls=[];
  const reader=createReader({env:{READER_MODE:'live',ANTHROPIC_API_KEY:'test-key'},fetchImpl:async(url,options)=>{
    calls.push({url,options});
    if(url.includes('/models?')) return response({data:[{id:'claude-sonnet-test'}]});
    return response({model:'claude-sonnet-test',stop_reason:'tool_use',content:[{type:'tool_use',name:'record_report',input:recordedRead(sample.text)}],usage:{input_tokens:100,output_tokens:50}});
  }});
  const result=await reader.read(sample.text);
  assert.equal(result.mode,'live');
  assert.equal(result.model,'claude-sonnet-test');
  assert.equal(calls.length,2);
  assert.equal(calls[0].options.headers['x-api-key'],'test-key');
  const body=JSON.parse(calls[1].options.body);
  assert.equal(body.tool_choice.name,'record_report');
  assert.equal(body.model,'claude-sonnet-test');
  assert.match(body.system,/untrusted source material/);
  assert(body.messages[0].content.includes(sample.text));
  await reader.read(sample.text);
  assert.equal(calls.filter(c=>c.url.includes('/models?')).length,1);
  assert(!JSON.stringify(reader.status()).includes('test-key'));
});

test('live mode without credentials fails before any network call',async()=>{
  const reader=createReader({env:{READER_MODE:'live'},fetchImpl:()=>{throw new Error('must not call');}});
  await assert.rejects(reader.read(sample.text),e=>e.code==='not_configured');
});

test('provider errors expose a safe status, not upstream secrets or document content',async()=>{
  const reader=createReader({env:{READER_MODE:'live',ANTHROPIC_API_KEY:'secret',ANTHROPIC_MODEL:'test'},fetchImpl:async()=>new Response('secret and report text',{status:401})});
  await assert.rejects(reader.read(sample.text),e=>e.code==='provider_error'&&e.message.includes('401')&&!e.message.includes('secret'));
});

test('missing tool output or truncated output is rejected instead of treated as a valid read',async()=>{
  for(const payload of [{content:[],stop_reason:'end_turn'},{content:[{type:'tool_use',name:'record_report',input:{}}],stop_reason:'max_tokens'}]) {
    const reader=createReader({env:{READER_MODE:'live',ANTHROPIC_API_KEY:'test-key',ANTHROPIC_MODEL:'test'},fetchImpl:async()=>response(payload)});
    await assert.rejects(reader.read(sample.text),e=>e.code==='invalid_output');
  }
});

test('live reply reading uses the reply prompt and a forced record_reply tool limited to the known labels',async()=>{
  const calls=[];
  const reader=createReader({env:{READER_MODE:'live',ANTHROPIC_API_KEY:'test-key',ANTHROPIC_MODEL:'test'},fetchImpl:async(url,options)=>{
    calls.push(JSON.parse(options.body));
    return response({model:'test',stop_reason:'tool_use',content:[{type:'tool_use',name:'record_reply',input:{labels:['transport_barrier'],quote:'no ride',summary:'She has no ride.'}}]});
  }});
  const result=await reader.readReply('I have no ride this week.');
  assert.deepEqual(result.read.labels,['transport_barrier']);
  assert.equal(calls[0].tool_choice.name,'record_reply');
  assert.match(calls[0].system,/patient's text-message reply/);
  assert.match(calls[0].system,/untrusted source material/);
  assert(calls[0].tools[0].input_schema.properties.labels.items.enum.includes('declines_care'));
});

test('recorded mode reads the bundled replies and refuses any other text',async()=>{
  const reader=createReader({env:{}});
  const known=await reader.readReply("I want to come but I don't drive and my son works all day. I have no way to get there.");
  assert.deepEqual(known.read.labels,['transport_barrier']);
  await assert.rejects(reader.readReply('Can I come next week?'),e=>e.code==='unsupported_sample');
});
