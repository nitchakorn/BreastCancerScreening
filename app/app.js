(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const STATES = { queued: 'Queued', reading: 'Reading report', read_failed: 'Read failed · retry', needs_review: 'Needs a person', closed: 'Closed',
    awaiting_booking: 'Waiting for booking', waiting_reminder: 'Reminder scheduled', booked: 'Booked', awaiting_result: 'Waiting for result' };
  const KINDS = { report_saved: 'Report saved', reply_saved: 'Reply saved', reader_requested: 'Read requested', read_completed: 'Read returned', read_failed: 'Read failed',
    read_retried: 'Retried', read_recovered: 'Recovered after restart', doc: 'Report arrived', read: 'Claude read it', validation_passed: 'Checks passed',
    validation_held: 'Checks failed', pathway: 'Pathway', text: 'Text', portal: 'Portal message', call: 'Automated call', reply: 'Her reply',
    readreply: 'Claude read her reply', note: 'Note', booked: 'Schedule checked', appt: 'Appointment', handoff: 'Handed to a person',
    headsup: 'Heads-up', pcp: 'Note to the PCP', overdue: 'Overdue', close: 'Case closed', person: 'A person acted', after_close: 'After closing' };
  const CHANNELS = { text: 'Text', portal: 'Portal message', call: 'Automated call' };
  const LABELS = { booked: 'Says she booked', wants_new_time: 'Wants another time', transport_barrier: 'No ride', other_barrier: 'Other barrier',
    scared_or_worried: 'Scared or worried', medical_question: 'Medical question', declines_care: 'Declines care', wrong_number: 'Wrong number', other: 'Other' };
  const TITLES = { screening: 'Screening mammogram', diagnostic: 'Diagnostic imaging', ultrasound: 'Ultrasound', addendum: 'Report addendum', pathology: 'Pathology report' };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  let selected = null, refreshing = false, renderedCase = '', renderedList = '', current = null, clock = null, examplesKey = '';
  let caseExamples = { reports: [], replies: [] }, starters = [];

  const fmt = iso => iso ? `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}` : '';
  const fmtDay = iso => iso ? `${DAYS[new Date(iso + 'T12:00:00Z').getUTCDay()]} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}` : '';
  const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const when = iso => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const breast = side => side === 'left' || side === 'right' ? `${side[0].toUpperCase()}${side.slice(1)} breast` : side === 'both' ? 'Both breasts' : '';
  const key = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()).replace(/[^a-zA-Z0-9-]/g, '');

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  async function api(url, options) {
    const response = await fetch(url, options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'The request failed.');
    return data;
  }
  function post(url, body, idempotent) {
    const headers = { 'content-type': 'application/json' };
    if (idempotent) headers['idempotency-key'] = key();
    return api(url, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  }
  function badge(status) {
    return element('span', STATES[status] || status, 'badge ' + (status === 'needs_review' ? 'review' : status === 'read_failed' ? 'failed' : status));
  }
  function showError(id, message) { $(id).textContent = message; $(id).hidden = false; }
  function hideError(id) { $(id).hidden = true; }

  // Marks the quoted words inside a text, so a person can see what Claude's read rests on.
  function highlight(text, quotes, warn) {
    const ranges = [];
    for (const q of quotes) { if (typeof q !== 'string' || !q) continue; const at = text.indexOf(q); if (at >= 0) ranges.push([at, at + q.length, q === warn]); }
    ranges.sort((a, b) => a[0] - b[0]);
    const out = document.createDocumentFragment();
    let pos = 0;
    for (const [from, to, isWarn] of ranges) {
      if (from < pos) continue;
      out.append(document.createTextNode(text.slice(pos, from)), element('mark', text.slice(from, to), isWarn ? 'warn' : ''));
      pos = to;
    }
    out.append(document.createTextNode(text.slice(pos)));
    return out;
  }

  /* ---------- the case list ---------- */
  function listLine(item) {
    if (item.status === 'closed') return item.outcome || 'Closed';
    if (item.status === 'needs_review') return item.person ? `With the ${item.person.toLowerCase()}` : 'Needs a person';
    if (item.status === 'booked' && item.booked) return `Appointment ${fmtDay(item.booked)}`;
    if (!item.step) return 'Waiting for a checked read';
    return `${item.step}${item.due ? ' · due ' + fmt(item.due) : ''}`;
  }
  // The dashboard line: where every case stands, and how fast abnormal results get resolved.
  function renderSummary(cases) {
    const box = $('summary'); box.replaceChildren();
    box.hidden = !cases.length;
    const count = test => cases.filter(test).length;
    const abnormal = cases.filter(c => ['0', '4-5', 'unclear'].includes(c.category));
    const days = abnormal.filter(c => c.resolvedDays !== null).map(c => c.resolvedDays).sort((a, b) => a - b);
    const median = days.length ? (days.length % 2 ? days[(days.length - 1) / 2] : (days[days.length / 2 - 1] + days[days.length / 2]) / 2) : null;
    const items = [
      ['Needs a person', count(c => c.status === 'needs_review'), 'review'],
      ['Overdue', count(c => c.overdueDays > 0 && c.status !== 'closed'), 'late'],
      ['Agent following up', count(c => ['awaiting_booking', 'waiting_reminder'].includes(c.status)), ''],
      ['Booked or awaiting result', count(c => ['booked', 'awaiting_result'].includes(c.status)), ''],
      ['Closed', count(c => c.status === 'closed'), ''],
      ['Abnormal results resolved', abnormal.length ? `${days.length} of ${abnormal.length}${median !== null ? ` · median ${median} days` : ''}` : '–', '']
    ];
    for (const [label, value, tone] of items) {
      const div = element('div', undefined, tone && value ? 'stat ' + tone : 'stat');
      div.append(element('dt', label), element('dd', String(value)));
      box.append(div);
    }
  }
  // People first, then the most overdue, then what the agent does next. Closed cases last.
  function worklistOrder(cases) {
    const rank = c => c.status === 'needs_review' ? 0 : c.status === 'read_failed' ? 1 : c.status === 'closed' ? 4 : c.overdueDays > 0 ? 2 : 3;
    return [...cases].sort((a, b) => rank(a) - rank(b) || b.overdueDays - a.overdueDays
      || String(a.nextAction || '9999').localeCompare(String(b.nextAction || '9999')) || b.createdAt.localeCompare(a.createdAt));
  }
  function renderList(cases) {
    renderSummary(cases);
    cases = worklistOrder(cases);
    const list = $('cases'); list.replaceChildren();
    if (!cases.length) list.append(element('p', 'No cases yet. Start with a sample report.', 'empty'));
    for (const item of cases) {
      const row = element('button', undefined, 'case-row'); row.type = 'button'; row.setAttribute('aria-pressed', String(item.id === selected));
      const label = element('span', item.patient + (item.side ? ` · ${breast(item.side)}` : '')); label.append(element('small', listLine(item)));
      const badges = element('span', undefined, 'badges');
      if (item.overdueDays > 0 && item.status !== 'closed') badges.append(element('span', `${plural(item.overdueDays, 'day', 'days')} late`, 'badge late'));
      badges.append(badge(item.status));
      row.append(label, badges);
      row.addEventListener('click', () => select(item.id));
      list.append(row);
    }
  }

  /* ---------- one case ---------- */
  function fact(dl, key, value) { if (value) dl.append(element('dt', key), element('dd', value)); }
  function renderFacts(item) {
    const a = item.agent, dl = $('facts'); dl.replaceChildren();
    if (!a) { fact(dl, 'State', 'Waiting for the first report to be read'); fact(dl, 'Case ID', item.id); return; }
    fact(dl, 'Breast', breast(item.side) + (item.groupId ? '. The report assessed each breast separately, so each has its own case.' : ''));
    fact(dl, 'Step', a.step || (item.pathway === 'pathology' ? 'Pathology review' : null));
    if (a.due && item.status !== 'closed') fact(dl, 'Due', fmt(a.due) + (a.overdueDays ? ` · ${plural(a.overdueDays, 'day', 'days')} late` : ''));
    if (a.booked) fact(dl, 'Booked', `${a.booked.kind === 'biopsy' ? 'Biopsy' : 'Imaging'} on ${fmtDay(a.booked.appt)}`);
    if (a.person && item.status !== 'closed') fact(dl, 'With', a.person.who);
    if (a.handoffDate && !a.person && !item.status.match(/closed|booked|awaiting_result/)) fact(dl, 'Person takes over', `${fmt(a.handoffDate)} if still not booked`);
    fact(dl, 'First exam', fmt(a.openedOn));
    if (a.outcome) fact(dl, 'Outcome', a.outcome + (a.closedBy ? ` (closed by the ${a.closedBy.toLowerCase()})` : ''));
    if (a.resolvedDays !== null) fact(dl, 'Resolved in', plural(a.resolvedDays, 'day', 'days') + ' from the abnormal result');
    fact(dl, 'Reader', item.model || 'No completed read');
    fact(dl, 'Case ID', item.id);
  }
  // Her other breast, when a report gave each breast its own case.
  function renderTracks(item) {
    const box = $('tracks'); box.replaceChildren();
    box.hidden = !item.tracks || !item.tracks.length;
    if (box.hidden) return;
    box.append(element('p', 'Her other breast', 'eyebrow'));
    for (const t of item.tracks) {
      const row = element('div', undefined, 'track');
      const text = element('span', `${breast(t.side)}: ${t.status === 'closed' ? (t.outcome || 'closed') : (t.step || 'waiting for its read') + (t.due ? `, due ${fmt(t.due)}` : '')}`);
      const open = element('button', 'Open', 'secondary compact'); open.type = 'button';
      open.addEventListener('click', () => select(t.id));
      row.append(text, badge(t.status), open);
      box.append(row);
    }
  }
  function renderPerson(item) {
    const a = item.agent, open = item.reviews.filter(r => r.status === 'open').pop();
    $('person').hidden = !open;
    if (!open) return;
    $('person-who').textContent = `Needs the ${(open.who || 'person').toLowerCase()}`;
    $('person-reason').textContent = open.reason;
    $('resume').hidden = !(a && a.can.resume);
    $('concordant').hidden = open.kind !== 'concordance';
    $('person-hint').textContent = open.kind === 'hold' ? 'Add the corrected report under Reports. If it passes the checks, the agent picks the case back up.'
      : open.kind === 'exception' ? (a && a.can.book ? 'The navigator can book her under Test schedule.' : 'Add the missing report under Reports, or close the case.') : '';
    $('close-form').dataset.review = open.id;
    $('resume').dataset.review = open.id;
    $('concordant').dataset.review = open.id;
  }
  function renderComing(item) {
    const list = $('coming'); list.replaceChildren();
    const coming = item.agent ? item.agent.coming : [];
    if (!item.agent) list.append(element('li', 'Claude reads the report first.', 'muted note'));
    else if (item.status === 'closed') list.append(element('li', 'Nothing. The case is closed.', 'muted note'));
    else if (!coming.length) list.append(element('li', 'Nothing scheduled.', 'muted note'));
    for (const c of coming) { const li = element('li'); li.append(element('time', fmtDay(c.date)), element('span', c.what)); list.append(li); }
  }
  function replyBubble(r) {
    const box = element('div', undefined, 'bubble patient');
    const read = r.read, quoteOk = read && typeof read.quote === 'string' && r.text.includes(read.quote);
    const p = element('p'); p.append(highlight(r.text, quoteOk ? [read.quote] : [])); box.append(element('small', 'Her reply', 'who'), p);
    const info = element('div', undefined, 'read-line');
    if (r.status === 'queued' || r.status === 'reading') info.append(element('span', 'Claude is reading this…', 'muted'));
    else if (r.status === 'read_failed') {
      info.append(element('span', r.problems[0] || 'The read failed.', 'error'));
      const retry = element('button', 'Retry', 'secondary compact'); retry.type = 'button'; retry.addEventListener('click', retryReads); info.append(retry);
    } else if (read) {
      for (const label of read.labels || []) info.append(element('span', LABELS[label] || label, 'chip' + (label === 'booked' || label === 'transport_barrier' || label === 'wants_new_time' ? '' : ' warn')));
      info.append(element('span', read.summary || '', 'muted'));
      if (!quoteOk) info.append(element('span', 'Quote not found in her message, so a person reads it.', 'error'));
    } else info.append(element('span', 'No usable read. A person reads it.', 'error'));
    box.append(info, element('time', when(r.createdAt)));
    return box;
  }
  function renderThread(item) {
    const thread = $('thread'); thread.replaceChildren();
    const items = [...item.messages.map(m => ({ at: m.createdAt, m })), ...item.replies.map(r => ({ at: r.createdAt, r }))].sort((x, y) => x.at.localeCompare(y.at));
    if (!items.length) thread.append(element('p', item.status === 'waiting_reminder' && item.agent ? `The first reminder goes out ${fmt(item.agent.coming[0] && item.agent.coming[0].date)}.` : 'No messages yet.', 'muted small'));
    for (const x of items) {
      if (x.m) {
        const box = element('div', undefined, 'bubble agent ' + x.m.channel);
        box.append(element('small', CHANNELS[x.m.channel] || x.m.channel, 'who'), element('p', x.m.body), element('time', when(x.m.createdAt)));
        thread.append(box);
      } else thread.append(replyBubble(x.r));
    }
  }
  function summaryOf(read) {
    if (!read) return 'No usable read.';
    if (read.doc_type === 'pathology') return `${read.pathology_result || 'No result'}${read.diagnosis ? ': ' + read.diagnosis : ''}`;
    return [`BI-RADS ${read.birads ?? 'missing'}`, read.side ? `${read.side} ${read.side === 'both' ? 'breasts' : 'breast'}` : null, read.next_step ? `next: ${read.next_step}` : null].filter(Boolean).join(' · ');
  }
  function renderReports(item) {
    const box = $('reports'); box.replaceChildren();
    item.reports.forEach((r, i) => {
      const card = element('article', undefined, 'report');
      const head = element('div', undefined, 'report-head');
      head.append(element('b', (r.read && TITLES[r.read.doc_type]) || (i ? 'Next report' : 'First report')), element('span', when(r.createdAt), 'muted small'));
      card.append(head);
      if (r.status === 'queued' || r.status === 'reading') card.append(element('p', 'Claude is reading this report…', 'muted'));
      else if (r.status === 'read_failed') {
        card.append(element('p', r.problems[0] || 'The read failed.', 'error'));
        const retry = element('button', 'Retry report read', 'secondary compact'); retry.type = 'button'; retry.addEventListener('click', retryReads); card.append(retry);
      } else {
        card.append(element('p', summaryOf(r.read)));
        if (r.problems.length) { const ul = element('ul', undefined, 'problem-list'); r.problems.forEach(p => ul.append(element('li', p))); card.append(ul); }
        else card.append(element('p', 'Checks passed: every quote matches the report word for word.', 'ok small'));
      }
      const source = element('details'), pre = element('pre');
      const quotes = r.read && r.read.quotes ? Object.values(r.read.quotes) : [];
      pre.append(highlight(r.text, r.read && r.read.mismatch_quote ? [...quotes, r.read.mismatch_quote] : quotes, r.read && r.read.mismatch_quote));
      source.append(element('summary', 'Report and quoted evidence'), pre);
      const raw = element('details'); raw.append(element('summary', 'Claude’s structured read'), element('pre', r.read ? JSON.stringify(r.read, null, 2) : 'No completed read yet.'));
      card.append(source, raw);
      box.append(card);
    });
  }
  function renderTimeline(item) {
    const list = $('timeline'); list.replaceChildren();
    for (const e of [...item.events].reverse()) {
      const li = element('li'), time = element('time', when(e.createdAt)); time.dateTime = e.createdAt;
      const head = element('div', undefined, 'event-head');
      head.append(element('span', e.actor, 'actor ' + e.actor), element('strong', KINDS[e.kind] || e.kind.replaceAll('_', ' ')), time);
      li.append(head, element('p', e.detail));
      list.append(li);
    }
  }
  function renderForms(item) {
    const can = item.agent ? item.agent.can : { reply: false, book: false, addReport: false };
    $('reply-form').hidden = !can.reply;
    $('report-form').hidden = !can.addReport;
    $('book-form').hidden = !can.book;
    const a = item.agent;
    $('schedule-state').textContent = !a ? 'Nothing to book until the report is read.'
      : a.booked ? `${a.booked.kind === 'biopsy' ? 'Biopsy' : 'Imaging'} booked for ${fmtDay(a.booked.appt)}. The agent texts a reminder the day before.`
      : item.status === 'awaiting_result' ? 'The appointment is done. The agent is watching for the report.'
      : can.book ? 'Stands in for the clinic’s scheduling system. The agent checks it every day and trusts it over what she says.'
      : item.status === 'closed' ? 'Nothing to book. The case is closed.' : 'Nothing to book right now.';
    const pending = [...item.reports, ...item.replies].filter(i => i.status === 'queued' || i.status === 'reading').length;
    $('inputs-pending').hidden = !pending || !item.agent;
    $('inputs-pending').textContent = pending ? `Claude is reading ${plural(pending, 'new item', 'new items')}…` : '';
  }
  function renderCase(item) {
    current = item;
    $('detail-empty').hidden = true; $('detail').hidden = false;
    $('detail-title').textContent = item.patient + (item.side && item.side !== 'both' ? ` · ${breast(item.side)}` : '');
    $('case-state').replaceWith(Object.assign(badge(item.status), { id: 'case-state' }));
    renderFacts(item); renderTracks(item); renderPerson(item); renderComing(item); renderThread(item); renderReports(item); renderTimeline(item); renderForms(item);
  }

  /* ---------- loading ---------- */
  function fillSelect(select, items, placeholder) {
    select.replaceChildren(element('option', placeholder));
    select.firstChild.value = '';
    for (const s of items) { const o = element('option', s.label); o.value = s.id; select.append(o); }
  }
  async function loadCaseExamples() {
    if (!selected || !clock) return;
    const wanted = selected + clock.today;
    if (examplesKey === wanted) return;
    examplesKey = wanted;
    try {
      caseExamples = await api(`/api/cases/${selected}/examples`);
      fillSelect($('next-example'), caseExamples.reports, 'Sample results…');
      fillSelect($('reply-example'), caseExamples.replies, 'Sample replies…');
    } catch { examplesKey = ''; }
  }
  function setBookingDefaults() {
    if (!clock) return;
    const input = $('book-date'), min = addDays(clock.today, 1);
    input.min = min;
    if (!input.value || input.value < min) input.value = addDays(clock.today, 3);
  }
  function renderClock(c) {
    const changed = !clock || clock.today !== c.today;
    clock = c;
    $('clock-date').textContent = c.label;
    $('clock-note').textContent = c.offsetDays
      ? `${plural(c.offsetDays, 'day', 'days')} ahead of real time. The agent ran its daily check for every day in between.`
      : 'The agent checks every open case once a day. Move the clock forward to see what it does next.';
    if (changed) { setBookingDefaults(); loadCaseExamples(); loadStarters(); }
  }
  // Sample reports are dated today on the demo clock, so they are reloaded whenever the clock moves.
  async function loadStarters() {
    try {
      const fresh = await api('/api/examples');
      const shown = starters.find(s => s.text === $('report').value);
      starters = fresh;
      const keep = $('example').value;
      fillSelect($('example'), starters, 'Choose a synthetic report…');
      $('example').value = keep;
      if (shown) $('report').value = starters.find(s => s.id === shown.id).text;
    } catch { showError('form-error', 'Samples could not be loaded. You can still paste a synthetic report.'); }
  }
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const [health, data] = await Promise.all([api('/api/health'), api('/api/cases')]);
      renderClock(health.clock);
      $('connection').classList.toggle('warning', health.runtime !== 'browser' && (!health.reader.configured || health.reader.mode === 'recorded'));
      $('connection').textContent = health.runtime === 'browser'
        ? 'This demo runs in your browser with Claude’s recorded reads of the sample reports and replies. Pick samples to run the whole loop. To have Claude read new text live, run the workspace on your computer.'
        : health.reader.mode === 'claude-code'
        ? `Live mode through Claude Code on this computer. Claude reads every new report and reply with your Claude Code sign-in (${health.reader.model}). All messages go to the local test inbox.`
        : health.reader.mode === 'recorded'
        ? 'Recorded mode · no API calls. Claude’s reads of the bundled sample reports and replies were recorded earlier. Pick samples to run the whole loop. New text needs live mode.'
        : health.reader.configured
        ? `Live mode. Claude reads every report and reply with ${health.reader.model}. All messages go to the local test inbox.`
        : 'Live reading needs an Anthropic API key. Add ANTHROPIC_API_KEY in your local .env file, then restart the server. You can save a report now and retry its read later.';
      if (!selected && data.cases.length) select(data.cases[0].id, true);
      const listSignature = JSON.stringify([selected, data.cases]);
      if (listSignature !== renderedList) { renderedList = listSignature; renderList(data.cases); }
      if (selected) {
        const item = (await api('/api/cases/' + selected)).case;
        const signature = JSON.stringify([item.updatedAt, item.events.length, item.status, clock.today, [...item.reports, ...item.replies].map(i => i.status)]);
        if (signature !== renderedCase) { renderCase(item); renderedCase = signature; }
      }
    } catch {
      $('connection').classList.add('warning'); $('connection').textContent = 'The local agent is unavailable. Check that the server is running, then refresh.';
    } finally { refreshing = false; }
  }
  function select(id, quiet) {
    if (selected === id) return;
    selected = id; renderedCase = ''; renderedList = ''; examplesKey = '';
    for (const f of ['reply-text', 'next-text', 'close-note']) $(f).value = '';
    for (const e of ['reply-error', 'book-error', 'next-error', 'person-error']) hideError(e);
    setBookingDefaults(); loadCaseExamples();
    if (!quiet) refresh();
  }
  async function act(fn, errorId, button) {
    hideError(errorId);
    if (button) button.disabled = true;
    try { await fn(); renderedCase = ''; await refresh(); }
    catch (e) { showError(errorId, e.message); }
    finally { if (button) button.disabled = false; }
  }
  async function retryReads() { await act(() => post(`/api/cases/${selected}/retry`), 'next-error'); }

  /* ---------- controls ---------- */
  $('refresh').addEventListener('click', refresh);
  $('example').addEventListener('change', () => {
    const example = starters.find(item => item.id === $('example').value);
    if (example) { $('report').value = example.text; $('report-file').value = ''; }
  });
  $('report-file').addEventListener('change', async () => {
    const file = $('report-file').files[0]; if (!file) return;
    hideError('form-error');
    if (!/\.txt$/i.test(file.name) || file.size > 20000) { showError('form-error', 'Choose a UTF-8 .txt report of at most 20 KB.'); $('report-file').value = ''; return; }
    try { $('report').value = await file.text(); $('example').value = ''; }
    catch { showError('form-error', 'The text file could not be read.'); }
  });
  $('intake-form').addEventListener('submit', async event => {
    event.preventDefault(); hideError('form-error'); $('submit').disabled = true;
    $('form-status').textContent = 'Saving the report and queuing its read…';
    try {
      const saved = await post('/api/cases', { patient: $('patient').value, report: $('report').value });
      select(saved.case.id, true);
      $('form-status').textContent = saved.created ? 'Case saved. The agent reads it in the background.' : 'This report already has a saved case. Showing it.';
      await refresh();
    } catch (e) { showError('form-error', e.message); $('form-status').textContent = ''; }
    finally { $('submit').disabled = false; }
  });
  $('reply-example').addEventListener('change', () => {
    const r = caseExamples.replies.find(x => x.id === $('reply-example').value);
    if (r) $('reply-text').value = r.text;
  });
  $('reply-form').addEventListener('submit', event => {
    event.preventDefault();
    act(async () => { await post(`/api/cases/${selected}/replies`, { text: $('reply-text').value }, true); $('reply-text').value = ''; $('reply-example').value = ''; }, 'reply-error', $('reply-send'));
  });
  $('book-form').addEventListener('submit', event => {
    event.preventDefault();
    const by = event.submitter && event.submitter.dataset.by === 'navigator' ? 'navigator' : 'patient';
    act(() => post(`/api/cases/${selected}/bookings`, { date: $('book-date').value, by }), 'book-error', event.submitter);
  });
  $('next-example').addEventListener('change', () => {
    const r = caseExamples.reports.find(x => x.id === $('next-example').value);
    if (r) $('next-text').value = r.text;
  });
  $('report-form').addEventListener('submit', event => {
    event.preventDefault();
    act(async () => { await post(`/api/cases/${selected}/reports`, { report: $('next-text').value }); $('next-text').value = ''; $('next-example').value = ''; }, 'next-error', $('next-send'));
  });
  for (const [id, action] of [['resume', 'resume'], ['concordant', 'concordant']]) {
    $(id).addEventListener('click', () => act(() => post(`/api/cases/${selected}/reviews/${$(id).dataset.review}`, { action }), 'person-error', $(id)));
  }
  $('close-form').addEventListener('submit', event => {
    event.preventDefault();
    act(async () => { await post(`/api/cases/${selected}/reviews/${$('close-form').dataset.review}`, { action: 'close', note: $('close-note').value }); $('close-note').value = ''; }, 'person-error', event.submitter);
  });
  for (const [id, days] of [['clock-day', 1], ['clock-week', 7], ['clock-month', 30]]) {
    $(id).addEventListener('click', () => act(async () => renderClock(await post('/api/clock', { days })), 'clock-error', $(id)));
  }
  let resetArmed = null;
  $('reset').addEventListener('click', () => {
    if (!resetArmed) {
      $('reset').textContent = 'Click again to clear every case';
      resetArmed = setTimeout(() => { resetArmed = null; $('reset').textContent = 'Start over'; }, 4000);
      return;
    }
    clearTimeout(resetArmed); resetArmed = null; $('reset').textContent = 'Start over';
    act(async () => {
      const done = await post('/api/reset', { confirm: 'start over' });
      selected = null; current = null; renderedList = ''; examplesKey = '';
      $('detail').hidden = true; $('detail-empty').hidden = false; $('detail-title').textContent = 'Case activity';
      $('case-state').hidden = true;
      clock = null; renderClock(done.clock);
    }, 'clock-error', $('reset'));
  });

  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 2000);
})();
