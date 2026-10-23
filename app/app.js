(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const states = { queued:'Queued', reading:'Reading report', read_failed:'Read failed · retry available', needs_review:'Human review', closed:'Closed · routine', awaiting_booking:'Waiting for booking', waiting_reminder:'Reminder scheduled', reply_pending:'Reply queued · outreach paused', reply_failed:'Reply failed · outreach paused', booking_claimed:'Booking claimed · unverified' };
  let selected = null, examples = [], replySamples = [], readerMode = 'recorded', refreshing = false, refreshRequested = false, renderedCase = '', renderedList = '';
  const replyDrafts = new Map();
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  async function api(url, options) {
    const response = await fetch(url, options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'The request failed.');
    return data;
  }
  function badge(status) {
    return element('span', states[status] || status, 'badge ' + (status === 'needs_review' ? 'review' : status === 'read_failed' ? 'failed' : status));
  }
  function section(title) {
    const node = element('div', undefined, 'case-section'); node.append(element('h3', title)); return node;
  }
  function renderReplies(item, inbox) {
    const replyStates = {queued:'Queued for reading',reading:'Reading reply',read_failed:'Read failed; reply saved',processed:'Processed',review:'With human review',superseded:'Newer reply takes priority'};
    function agentMessage(message) {
      const box=element('div',undefined,'message');
      box.append(element('strong','Agent · test inbox'),element('p',message.body),element('small',new Date(message.createdAt).toLocaleString()));
      inbox.append(box);
    }
    item.messages.filter(message=>!message.replyId).forEach(agentMessage);
    for (const [index,reply] of item.replies.entries()) {
      const box=element('div',undefined,'message patient-message');
      box.append(element('strong','Patient · test reply'),element('p',reply.text),element('small',`${replyStates[reply.status] || reply.status} · ${new Date(reply.createdAt).toLocaleString()}`));
      if(reply.problems.length) box.append(element('p',reply.problems.join(' '),'small error'));
      if(reply.read) {
        const evidence=element('details');evidence.append(element('summary','Reply read · '+reply.model),element('pre',JSON.stringify(reply.read,null,2)));box.append(evidence);
      }
      if(reply.status==='read_failed' && item.status==='reply_failed' && index===item.replies.length-1) {
        const retry=element('button','Retry reply read','secondary compact');retry.type='button';
        retry.addEventListener('click',async()=>{
          retry.disabled=true;
          try {await api(`/api/cases/${item.id}/replies/${reply.id}/retry`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});await refresh();}
          catch(e){showError(e.message);retry.disabled=false;}
        });box.append(retry);
      }
      inbox.append(box);
      item.messages.filter(message=>message.replyId===reply.id).forEach(agentMessage);
    }
  }
  function replyComposer(item) {
    const node=section('Reply as the patient');
    if(!item.messages.length || item.status==='closed') {node.append(element('p','The reply box becomes available after the agent sends its first test message for an open case.','muted small'));return node;}
    if(!replyDrafts.has(item.id)) replyDrafts.set(item.id,{text:'',key:crypto.randomUUID(),pending:false,error:''});
    const draft=replyDrafts.get(item.id), form=element('form');
    node.append(element('p',item.status==='needs_review' ? 'This case is with a navigator. Further replies are saved for human review; automated responses stay paused.' : readerMode==='recorded' ? 'Recorded mode recognizes these sample replies. New wording needs live mode.' : 'Live Claude reading interprets the reply; code selects any permitted response.','muted small'));
    const sampleLabel=element('label','Try a reply');sampleLabel.htmlFor='reply-sample';
    const sample=element('select');sample.id='reply-sample';sample.append(element('option','Choose a sample reply…'));sample.firstChild.value='';
    for(const item of replySamples){const option=element('option',item.label);option.value=item.id;sample.append(option);}
    const label=element('label','Patient reply');label.htmlFor='reply-text';
    const text=element('textarea');text.id='reply-text';text.rows=3;text.maxLength=2000;text.required=true;text.value=draft.text;
    const error=element('p',draft.error,'error');error.setAttribute('role','alert');error.hidden=!draft.error;
    const send=element('button',draft.pending?'Saving reply…':'Send test reply');send.type='submit';send.disabled=draft.pending;
    text.addEventListener('input',()=>{draft.text=text.value;draft.key=crypto.randomUUID();});
    sample.addEventListener('change',()=>{const value=replySamples.find(row=>row.id===sample.value);if(value){text.value=draft.text=value.text;draft.key=crypto.randomUUID();}});
    form.append(sampleLabel,sample,label,text,send,error);
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(draft.pending || selected !== item.id)return;
      draft.pending=true;send.disabled=true;error.hidden=true;draft.error='';
      try {
        await api(`/api/cases/${item.id}/replies`,{method:'POST',headers:{'content-type':'application/json','idempotency-key':draft.key},body:JSON.stringify({text:draft.text})});
        draft.text='';draft.key=crypto.randomUUID();draft.pending=false;renderedCase='';await refresh();
      }catch(e){draft.error=e.message;error.textContent=e.message;error.hidden=false;}
      finally{draft.pending=false;send.disabled=false;}
    });
    node.append(form);return node;
  }
  function renderCase(item) {
    $('detail-title').textContent = item.patient;
    $('case-state').replaceWith(Object.assign(badge(item.status), { id:'case-state' }));
    const detail = $('detail'); detail.replaceChildren();
    const facts = element('dl', undefined, 'facts');
    for (const [key, value] of [['Pathway',item.pathway || 'Pending read'],['Due',item.due || 'Not set'],['Reader',item.model || 'No completed read'],['Case ID',item.id]]) {
      facts.append(element('dt',key),element('dd',value));
    }
    detail.append(facts);
    if(item.bookingClaimed) detail.append(element('p','The patient reports a booking. Scheduling verification is still required; this case remains open.','notice small'));
    if (item.problems.length) {
      const list = element('ul',undefined,'problem-list');
      item.problems.forEach(problem => list.append(element('li',problem)));
      detail.append(list);
    }
    if (item.status === 'read_failed') {
      const retry = element('button','Retry report read','secondary compact'); retry.type = 'button';
      retry.addEventListener('click',async () => {
        retry.disabled = true;
        try { await api(`/api/cases/${item.id}/retry`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'}); await refresh(); }
        catch(e) { showError(e.message); retry.disabled = false; }
      });
      detail.append(retry);
    }
    const inbox = section('Test inbox');
    if (!item.messages.length) inbox.append(element('p',item.status === 'waiting_reminder' ? `The first reminder is scheduled for ${item.nextAction}.` : 'No patient message sent for this case.','muted small'));
    renderReplies(item,inbox);
    detail.append(inbox);
    detail.append(replyComposer(item));
    if (item.reviews.length) {
      const reviews = section('Human review queue');
      item.reviews.forEach(review => reviews.append(element('div',review.reason,'review-item')));
      detail.append(reviews);
    }
    for (const [title, content] of [['Report source',item.report],['Claude’s structured read',item.read ? JSON.stringify(item.read,null,2) : 'No completed read yet.']]) {
      const disclosure = element('details'); disclosure.append(element('summary',title),element('pre',content)); detail.append(disclosure);
    }
    const activity = section('Action history'), timeline = element('ol',undefined,'timeline');
    for (const event of item.events) {
      const li = element('li'), time = element('time',new Date(event.createdAt).toLocaleString()); time.dateTime = event.createdAt;
      li.append(time,element('strong',event.kind.replaceAll('_',' ') + ' · '),document.createTextNode(event.detail)); timeline.append(li);
    }
    activity.append(timeline); detail.append(activity);
  }
  function showError(message) { $('form-error').textContent = message; $('form-error').hidden = false; }
  function selectCase(id) {
    selected=id; renderedCase='';
    $('detail-title').textContent='Loading case…';
    $('case-state').hidden=true;
    $('detail').replaceChildren(element('p','Loading the selected case…','empty'));
    return refresh();
  }
  async function refresh() {
    if (refreshing) { refreshRequested=true; return; }
    refreshing = true;
    try {
      const [health, data] = await Promise.all([api('/api/health'),api('/api/cases')]);
      readerMode=health.reader.mode;
      $('connection').classList.toggle('warning',!health.reader.configured || health.reader.mode === 'recorded');
      $('connection').textContent = health.reader.mode === 'recorded'
        ? 'Recorded mode · no API calls. Choose a bundled synthetic sample to exercise case storage, validation, the review queue and the test inbox. New reports need live mode.'
        : health.reader.configured
        ? `Claude API key is configured. Model: ${health.reader.model}. All messages go to the local test inbox.`
        : 'Live reading needs an Anthropic API key. Add ANTHROPIC_API_KEY securely in environment settings or your local .env file, then restart the server. You can save a report now and retry its read later.';
      if (!selected && data.cases.length) selected = data.cases[0].id;
      const signature = JSON.stringify([selected,data.cases]);
      if (signature !== renderedList) {
        renderedList = signature;
        const list = $('cases'); list.replaceChildren();
        if (!data.cases.length) list.append(element('p','No cases yet. Start with a sample report.','empty'));
        for (const item of data.cases) {
        const row = element('button',undefined,'case-row'); row.type = 'button'; row.setAttribute('aria-pressed',String(item.id === selected));
        const label = element('span',item.patient); label.append(element('small',item.pathway ? `${item.pathway}${item.due ? ' · due ' + item.due : ''}` : 'Waiting for a checked read'));
        row.append(label,badge(item.status));
          row.addEventListener('click',() => selectCase(item.id)); list.append(row);
        }
      }
      if (selected) {
        const requested = selected;
        const item = (await api('/api/cases/' + requested)).case;
        const signature = JSON.stringify([item.id,item.updatedAt,item.events.length,item.messages.length]);
        if (item.id !== selected) refreshRequested = true;
        else if (signature !== renderedCase) { renderCase(item); renderedCase = signature; }
      }
    } catch(e) {
      $('connection').classList.add('warning'); $('connection').textContent = 'The local agent is unavailable. Check that the server is running, then refresh.';
    } finally {
      refreshing = false;
      if (refreshRequested) { refreshRequested=false; refresh(); }
    }
  }
  $('refresh').addEventListener('click',refresh);
  $('example').addEventListener('change',() => {
    const example = examples.find(item => item.id === $('example').value);
    if (example) { $('report').value = example.text; $('report-file').value = ''; }
  });
  $('report-file').addEventListener('change',async () => {
    const file = $('report-file').files[0]; if (!file) return;
    $('form-error').hidden = true;
    if (!/\.txt$/i.test(file.name) || file.size > 20000) { showError('Choose a UTF-8 .txt report of at most 20 KB.'); $('report-file').value = ''; return; }
    try { $('report').value = await file.text(); $('example').value = ''; }
    catch { showError('The text file could not be read.'); }
  });
  $('intake-form').addEventListener('submit',async event => {
    event.preventDefault(); $('form-error').hidden = true; $('submit').disabled = true;
    $('form-status').textContent = 'Saving the report and queuing its read…';
    try {
      const saved = await api('/api/cases',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({patient:$('patient').value,report:$('report').value})});
      $('form-status').textContent = saved.created ? 'Case saved. The agent will read it in the background; you can leave this page open or return later.' : 'This report already has a saved case. Showing its current state.';
      await selectCase(saved.case.id);
    } catch(e) { showError(e.message); $('form-status').textContent = ''; }
    finally { $('submit').disabled = false; }
  });
  api('/api/examples').then(data => {
    examples = data;
    for (const sample of examples) { const option = element('option',sample.label); option.value = sample.id; $('example').append(option); }
  }).catch(() => showError('Samples could not be loaded. You can still paste a synthetic report.'));
  api('/api/reply-examples').then(data=>{replySamples=data;renderedCase='';refresh();}).catch(()=>showError('Reply samples could not be loaded. Refresh to try again.'));
  refresh();
  setInterval(() => { if (!document.hidden) refresh(); },2000);
})();
