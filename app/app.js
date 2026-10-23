(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const states = { queued:'Queued', reading:'Reading report', read_failed:'Read failed · retry available', needs_review:'Human review', closed:'Closed · routine', awaiting_booking:'Waiting for booking', waiting_reminder:'Reminder scheduled' };
  let selected = null, examples = [], refreshing = false, renderedCase = '', renderedList = '';
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
  function renderCase(item) {
    $('detail-title').textContent = item.patient;
    $('case-state').replaceWith(Object.assign(badge(item.status), { id:'case-state' }));
    const detail = $('detail'); detail.replaceChildren();
    const facts = element('dl', undefined, 'facts');
    for (const [key, value] of [['Pathway',item.pathway || 'Pending read'],['Due',item.due || 'Not set'],['Reader',item.model || 'No completed read'],['Case ID',item.id]]) {
      facts.append(element('dt',key),element('dd',value));
    }
    detail.append(facts);
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
    for (const message of item.messages) {
      const box = element('div',undefined,'message'); box.append(element('p',message.body),element('small',`Local test delivery · ${new Date(message.createdAt).toLocaleString()}`)); inbox.append(box);
    }
    detail.append(inbox);
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
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const [health, data] = await Promise.all([api('/api/health'),api('/api/cases')]);
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
          row.addEventListener('click',async () => { selected = item.id; await refresh(); }); list.append(row);
        }
      }
      if (selected) {
        const item = (await api('/api/cases/' + selected)).case;
        const signature = JSON.stringify([item.id,item.updatedAt,item.events.length,item.messages.length]);
        if (signature !== renderedCase) { renderCase(item); renderedCase = signature; }
      }
    } catch(e) {
      $('connection').classList.add('warning'); $('connection').textContent = 'The local agent is unavailable. Check that the server is running, then refresh.';
    } finally { refreshing = false; }
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
      selected = saved.case.id;
      $('form-status').textContent = saved.created ? 'Case saved. The agent will read it in the background; you can leave this page open or return later.' : 'This report already has a saved case. Showing its current state.';
      await refresh();
    } catch(e) { showError(e.message); $('form-status').textContent = ''; }
    finally { $('submit').disabled = false; }
  });
  api('/api/examples').then(data => {
    examples = data;
    for (const sample of examples) { const option = element('option',sample.label); option.value = sample.id; $('example').append(option); }
  }).catch(() => showError('Samples could not be loaded. You can still paste a synthetic report.'));
  refresh();
  setInterval(() => { if (!document.hidden) refresh(); },2000);
})();
