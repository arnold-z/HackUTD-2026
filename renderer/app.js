// Main window UI. State is pushed from the main process (SpacetimeDB cache + agent status).
const $ = (id) => document.getElementById(id);
let phoneTouched = false;
const RING = 2 * Math.PI * 104;

const clock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};
const timeOf = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const VERDICT = { on_task: 'On task', off_task: 'Off task', pending: 'Checking…' };
const WHO = { judge: 'Judge', profile: 'Setup', alert: 'Alert', debrief: 'Summary' };

function status(id, cls, text) {
  const el = $(id);
  el.className = `status ${cls}`;
  el.innerHTML = `<i></i>${esc(text)}`;
}

function setDial(fraction, time, sub, mode) {
  const dial = $('dial');
  dial.className = `dial ${mode}`;
  const arc = $('dialArc');
  arc.style.strokeDasharray = `${RING}`;
  arc.style.strokeDashoffset = `${RING * (1 - Math.max(0, Math.min(1, fraction)))}`;
  $('dialTime').textContent = time;
  $('dialSub').textContent = sub;
}

function render(st) {
  if (st.accent) document.documentElement.style.setProperty('--accent', st.accent);

  const db = st.dbStatus === 'connected';
  status('pill-db', db ? 'ok' : 'err', 'Database');
  status('pill-llm', st.llm.llm === 'ok' ? 'ok' : st.llm.llm === 'error' ? 'err' : '', st.llm.llm === 'ok' ? `Nemotron ${(st.llm.lastLatencyMs / 1000).toFixed(1)}s` : 'Nemotron');
  status('pill-photon', st.photon.status === 'ready' ? 'ok' : st.photon.status === 'error' ? 'err' : st.photon.status === 'dry-run' ? 'warn' : '', st.photon.status === 'dry-run' ? 'iMessage (test mode)' : 'iMessage');

  const problems = [];
  if (!db) problems.push(st.dbStatus);
  if (st.watcherError) problems.push(st.watcherError);
  if (st.llm.llm === 'error') problems.push(`Nemotron didn't respond: ${st.llm.llmError}`);
  if (st.photon.status === 'error' && st.photon.error) problems.push(`iMessage isn't sending: ${st.photon.error}`);
  $('bannerText').textContent = problems.join(' ');
  $('banner').classList.toggle('hidden', problems.length === 0);

  renderPermissions(st.permissions);

  if (!phoneTouched && !$('phone').value) $('phone').value = st.defaultPhone || '';

  const s = st.session;
  const active = s && s.status === 'active';
  $('start').classList.toggle('hidden', !!active);
  $('session').classList.toggle('hidden', !active);
  $('endWrap').classList.toggle('hidden', !active);
  $('about').classList.toggle('hidden', !!active);
  $('startBtn').disabled = !db;

  if (!active) {
    setDial(0, clock((Number($('minutes').value) || 25) * 60000), 'Ready', 'idle');
    $('sGoal').textContent = 'Pick a goal to start';
    $('sMeta').textContent = '';
    const text = st.summary && st.summary.text;
    const show = s && (text || s.status === 'ended');
    $('lastDebrief').classList.toggle('hidden', !show);
    if (show) $('lastDebriefText').textContent = text ? text + (st.summary.sent ? '\n\nSent to your phone.' : "\n\nCouldn't send this to your phone.") : 'Writing your summary…';
    return;
  }

  // Dial: time left, red while an intervention is open
  const total = s.minutes * 60000;
  const left = total - (Date.now() - s.startedMs);
  const off = !!st.intervention;
  setDial(left / total, clock(left), off ? 'Off task' : 'left', off ? 'off' : '');
  $('sGoal').textContent = s.goal;
  $('sMeta').textContent = `${s.minutes}-minute session, started ${timeOf(s.startedMs)}`;

  // Right now
  const c = st.current;
  if (c) {
    $('cVerdict').className = `badge ${c.verdict}`;
    $('cVerdict').textContent = VERDICT[c.verdict] || c.verdict;
    $('cTitle').textContent = c.title || c.app;
    $('cSub').textContent = c.url ? `${c.app}, ${host(c.url)}` : c.app;
    const how = c.source === 'rule' ? 'Decided by a learned rule.' : c.source === 'memory' ? 'Seen earlier this session.' : c.source === 'judge' ? `Nemotron, ${Math.round(c.confidence * 100)}% sure.` : '';
    $('cReason').textContent = c.verdict === 'pending' ? 'The agent is looking into this window.' : [c.reason && !/[.!?]$/.test(c.reason.trim()) ? c.reason.trim() + '.' : c.reason, how].filter(Boolean).join(' ');
  } else {
    $('cVerdict').className = 'badge pending';
    $('cVerdict').textContent = 'Waiting';
    $('cTitle').textContent = 'Switch to the window you want to work in';
    $('cSub').textContent = '';
    $('cReason').textContent = '';
  }

  const m = st.metrics;
  if (m) {
    $('mScore').textContent = m.focusScore;
    $('mOn').textContent = `${Math.round(m.onTaskRatio * 100)}%`;
    $('mDrifts').textContent = m.drifts;
    $('mReturn').textContent = m.meanReturnSeconds === null ? '–' : `${m.meanReturnSeconds}s`;
  }

  $('latency').textContent = st.model.split('/').pop();
  $('trace').innerHTML = st.trace.length
    ? st.trace
        .map(
          (t) => `<div class="row"><span class="who ${esc(t.kind)}">${esc(WHO[t.kind] || t.kind)}</span><div class="main"><div class="tool">${esc(t.tool)}</div>${t.args && t.args !== '{}' ? `<div class="args">${esc(t.args.slice(0, 300))}</div>` : ''}${t.result ? `<div class="res">${esc(t.result.slice(0, 500))}</div>` : ''}</div><span class="time">${timeOf(t.tsMs)}</span></div>`
        )
        .join('')
    : '<div class="empty">Each step the agent takes shows up here.</div>';

  $('events').innerHTML = st.events.length
    ? st.events
        .slice(0, 12)
        .map((e) => `<div class="row"><span class="dot ${e.verdict}"></span><div class="main"><div class="title">${esc(e.title || e.app)}</div><div class="detail">${esc(host(e.url) || e.app)}</div></div><span class="time">${timeOf(e.tsMs)}</span></div>`)
        .join('')
    : '<div class="empty">Windows you switch to will be listed here.</div>';

  $('rules').innerHTML = s.rules.length
    ? s.rules.map((r) => `<span class="chip ${r.verdict}" title="${r.verdict === 'on_task' ? 'Counts as on task' : 'Counts as off task'}">${esc(r.pattern)}</span>`).join('')
    : '<span class="empty" style="padding:0">Setting up rules from your goal…</span>';
}

// Permission checker: one row per macOS permission, shown only when something is missing.
const PERMS = [
  { key: 'screen', name: 'Screen Recording', why: 'Lets the agent see which note, document or chat is open.' },
  { key: 'accessibility', name: 'Accessibility', why: 'Reads window titles and switches you back to your work.' },
  { key: 'automation', name: 'Automation', why: 'Reads the browser tab URL and returns you to the right tab.' },
];
let lastPermKey = '';
function renderPermissions(p) {
  if (!p) return $('perms').classList.add('hidden');
  const needs = PERMS.some((x) => p[x.key] !== 'ok');
  $('perms').classList.remove('hidden'); // always visible, so access can be verified at a glance
  const key = JSON.stringify(p);
  if (key === lastPermKey) return;
  $('permTitle').textContent = needs ? 'FocusGuard needs access' : 'Permissions';
  lastPermKey = key;
  const restart = PERMS.some((x) => p[x.key] === 'restart');
  $('permRows').innerHTML = PERMS.map((x) => {
    const s = p[x.key];
    const label = s === 'ok' ? 'On' : s === 'restart' ? 'Restart to apply' : 'Off';
    // macOS often reports Screen Recording as off until the app restarts, so offer the restart right away.
    const restartBtn = x.key === 'screen' && s === 'missing' ? '<button class="btn" data-restart>Restart</button>' : '';
    const btn = s === 'missing' ? `<button class="btn" data-perm="${x.key}">Open settings</button>${restartBtn}` : s === 'restart' ? '<button class="btn primary" data-restart>Restart FocusGuard</button>' : '';
    return `<div class="row"><div class="main"><div class="title">${x.name}</div><div class="detail">${x.why}</div></div><span class="perm-state ${s}">${label}</span>${btn}</div>`;
  }).join('');
  $('permNote').textContent = !needs
    ? 'Everything FocusGuard needs is turned on.'
    : restart
    ? 'macOS applies Screen Recording only after a restart. Your session continues afterwards.'
    : `In the settings page, turn on ${p.appName}, then click Restart. If it's on but still shows Off after restarting, remove it with − and add it again with +.`;
  for (const b of $('permRows').querySelectorAll('[data-perm]')) b.addEventListener('click', () => window.fg.openPermission(b.dataset.perm));
  for (const b of $('permRows').querySelectorAll('[data-restart]')) b.addEventListener('click', () => window.fg.restartApp());
}

// Length presets
for (const b of $('lengths').querySelectorAll('button')) {
  b.addEventListener('click', () => {
    $('minutes').value = b.dataset.min;
    for (const o of $('lengths').querySelectorAll('button')) o.classList.toggle('on', o === b);
    window.fg.getState().then(render);
  });
}
$('minutes').addEventListener('input', () => {
  for (const o of $('lengths').querySelectorAll('button')) o.classList.toggle('on', o.dataset.min === $('minutes').value);
  window.fg.getState().then(render);
});
$('phone').addEventListener('input', () => (phoneTouched = true));

$('startBtn').addEventListener('click', async () => {
  const goal = $('goal').value.trim();
  if (!goal) return $('goal').focus();
  $('startBtn').disabled = true;
  try {
    await window.fg.startSession(goal, Number($('minutes').value) || 25, $('phone').value.trim());
    $('goal').value = '';
  } catch (e) {
    alert(e.message || e);
  } finally {
    $('startBtn').disabled = false;
  }
});

async function endSession() {
  const ok = await window.fg.endSession($('endPhrase').value);
  $('endPhrase').value = '';
  if (!ok) {
    $('endPhrase').placeholder = 'Type it exactly';
    $('endPhrase').focus();
  }
}
$('endBtn').addEventListener('click', endSession);
$('endPhrase').addEventListener('keydown', (e) => e.key === 'Enter' && endSession());

window.fg.onState(render);
window.fg.getState().then(render);
