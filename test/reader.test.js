const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createReader}=require('../server/reader.js');
const {examples,nextReports}=require('../server/samples.js');
const comparisons=require('../reads/comparisons.json');
const sample=examples('2026-10-23')[0];
// Evelyn's pair: a spiculated BI-RADS 4C mass, and the benign biopsy that followed it.
const imaging=examples('2026-10-23').find(s=>s.id==='P11-dx').text;
const pathology=nextReports('2026-10-30',{firstExam:'2026-10-23',biopsy:'2026-10-27'}).find(s=>s.id==='P11-path').text;
const response=data=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
const comparison=comparisons['P11-path'].comparison;

test('reports are read by rules in every mode, with no model call',async()=>{
  for(const env of [{},{READER_MODE:'live',ANTHROPIC_API_KEY:'test-key',ANTHROPIC_MODEL:'test'},{READER_MODE:'claude-code'}]){
    const reader=createReader({env,fetchImpl:()=>{throw new Error('must not call network');},spawnImpl:()=>{throw new Error('must not start claude');}});
    const result=await reader.read(sample.text);
    assert.equal(result.mode,'rules');
    assert.match(result.model,/no model/);
    assert.equal(result.read.birads,'0');
    assert.equal(result.comparison,null,'an imaging report has nothing to compare');
  }
});

test('recorded mode compares a sample biopsy with its own imaging report, and only that pair',async()=>{
  const reader=createReader({env:{},fetchImpl:()=>{throw new Error('must not call network');}});
  assert.equal(reader.status().mode,'recorded');
  const result=await reader.read(pathology,{imaging});
  assert.equal(result.read.pathology_result,'benign');
  assert.equal(result.comparison.mode,'recorded');
  assert.equal(result.comparison.read.match,'possible_mismatch');
  assert(result.comparison.read.flags.length>0);
  const other=await reader.read(pathology,{imaging:sample.text});
  assert.match(other.comparison.error,/only for the sample pairs/);
});

test('live mode compares pathology with imaging through a forced record_comparison tool and retains provenance',async()=>{
  const calls=[];
  const reader=createReader({env:{READER_MODE:'live',ANTHROPIC_API_KEY:'test-key'},fetchImpl:async(url,options)=>{
    calls.push({url,options});
    if(url.includes('/models?')) return response({data:[{id:'claude-sonnet-test'}]});
    return response({model:'claude-sonnet-test',stop_reason:'tool_use',content:[{type:'tool_use',name:'record_comparison',input:comparison}],usage:{input_tokens:100,output_tokens:50}});
  }});
  const result=await reader.read(pathology,{imaging});
  assert.equal(result.comparison.mode,'live');
  assert.equal(result.comparison.model,'claude-sonnet-test');
  assert.equal(result.comparison.imaging,imaging);
  assert.equal(calls.length,2);
  assert.equal(calls[0].options.headers['x-api-key'],'test-key');
  const body=JSON.parse(calls[1].options.body);
  assert.equal(body.tool_choice.name,'record_comparison');
  assert.match(body.system,/radiology-pathology correlation/);
  assert.match(body.system,/untrusted source material/);
  assert(body.messages[0].content.includes(imaging)&&body.messages[0].content.includes(pathology));
  assert.deepEqual(body.tools[0].input_schema.properties.flags.items.required,['concern','imaging_quote','pathology_quote']);
  await reader.read(pathology,{imaging});
  assert.equal(calls.filter(c=>c.url.includes('/models?')).length,1);
  assert(!JSON.stringify(reader.status()).includes('test-key'));
});

test('a comparison that fails never blocks the case: the reason is kept for the radiologist',async()=>{
  const missing=createReader({env:{READER_MODE:'live'},fetchImpl:()=>{throw new Error('must not call');}});
  assert.match((await missing.read(pathology,{imaging})).comparison.error,/ANTHROPIC_API_KEY/);
  await assert.rejects(missing.readReply('ok'),e=>e.code==='not_configured');
  const failing=createReader({env:{READER_MODE:'live',ANTHROPIC_API_KEY:'secret',ANTHROPIC_MODEL:'test'},fetchImpl:async()=>new Response('secret and report text',{status:401})});
  const result=await failing.read(pathology,{imaging});
  assert.equal(result.read.pathology_result,'benign');
  assert(result.comparison.error.includes('401')&&!result.comparison.error.includes('secret'));
  await assert.rejects(failing.readReply('ok'),e=>e.code==='provider_error'&&!e.message.includes('secret'));
});

test('missing tool output or truncated output is rejected instead of treated as a valid read',async()=>{
  for(const payload of [{content:[],stop_reason:'end_turn'},{content:[{type:'tool_use',name:'record_reply',input:{}}],stop_reason:'max_tokens'}]) {
    const reader=createReader({env:{READER_MODE:'live',ANTHROPIC_API_KEY:'test-key',ANTHROPIC_MODEL:'test'},fetchImpl:async()=>response(payload)});
    await assert.rejects(reader.readReply('ok'),e=>e.code==='invalid_output');
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

// A stand-in for the claude command: records what it was given and answers like `claude -p --output-format json`.
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
function fakeClaude(reply, calls) {
  return (command, args) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.kill = () => {};
    let input = '';
    child.stdin.on('data', d => { input += d; });
    child.stdin.on('finish', () => {
      calls.push({ command, args, input });
      setImmediate(() => { child.stdout.end(typeof reply === 'string' ? reply : JSON.stringify(reply)); child.emit('close', 0); });
    });
    return child;
  };
}

test('claude-code mode compares through the claude command: text on stdin, no tools, no saved session, schema enforced',async()=>{
  const calls=[];
  const reader=createReader({env:{READER_MODE:'claude-code'},spawnImpl:fakeClaude({is_error:false,structured_output:comparison,modelUsage:{'claude-sonnet-test':{outputTokens:120}}},calls)});
  assert.equal(reader.status().mode,'claude-code');
  const result=await reader.read(pathology,{imaging});
  assert.deepEqual(result.comparison.read,comparison);
  assert.equal(result.comparison.model,'claude-sonnet-test');
  const {command,args,input}=calls[0];
  assert.equal(command,'claude');
  assert.equal(args[args.indexOf('--tools')+1],'');
  assert(args.includes('--no-session-persistence'));
  assert.match(args[args.indexOf('--system-prompt')+1],/untrusted source material/);
  assert.deepEqual(JSON.parse(args[args.indexOf('--json-schema')+1]).required,['imaging','pathology','match','flags','summary']);
  assert(input.includes(imaging)&&input.includes(pathology),'both reports go in on stdin, not on the command line');
  assert(!args.some(a=>a.includes(pathology)));
});

test('claude-code mode fails clearly when Claude Code errors, is missing or returns no structured read',async()=>{
  const errored=createReader({env:{READER_MODE:'claude-code'},spawnImpl:fakeClaude({is_error:true,subtype:'error'},[])});
  await assert.rejects(errored.readReply('ok'),e=>e.code==='provider_error');
  const empty=createReader({env:{READER_MODE:'claude-code'},spawnImpl:fakeClaude({is_error:false,result:'hello'},[])});
  await assert.rejects(empty.readReply('ok'),e=>e.code==='invalid_output');
  const missing=createReader({env:{READER_MODE:'claude-code',CLAUDE_CODE_COMMAND:'/no/such/claude'}});
  await assert.rejects(missing.readReply('ok'),e=>e.code==='cli_unavailable');
});
