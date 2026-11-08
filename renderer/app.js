// Main window UI. State is pushed from the main process (SpacetimeDB cache + agent status).
const $ = (id) => document.getElementById(id);
let state = null;
let phoneTouched = false;

const fmtClock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const label = (v) => ({ on_task: 'on task', off_task: 'off task', pending: 'judging…' }[v] || v);

function setPill(id, cls, text) {
  const el = $(id);
  el.className = `pill ${cls}`;
  el.innerHTML = `<i></i>${esc(text)}`;
}

function render(st) {
  state = st;
  // Status pills
  const db = st.dbStatus === 'connected';
  setPill('pill-db', db ? 'ok' : 'err', db ? 'SpacetimeDB' : 'SpacetimeDB offline');
  setPill('pill-llm', st.llm.llm === 'ok' ? 'ok' : st.llm.llm === 'error' ? 'err' : '', st.llm.llm === 'ok' ? `Nemotron ${st.llm.lastLatencyMs} ms` : st.llm.llm === 'error' ? 'Nemotron error' : 'Nemotron');
  setPill('pill-photon', st.photon.status === 'ready' ? 'ok' : st.photon.status === 'error' ? 'err' : st.photon.status === 'dry-run' ? 'warn' : '', st.photon.status === 'dry-run' ? 'iMessage (dry run)' : 'iMessage');

  const problems = [];
  if (!db) problems.push(st.dbStatus);
  if (st.watcherError) problems.push(st.watcherError);
  if (st.llm.llm === 'error') problems.push(`Nemotron: ${st.llm.llmError}`);
  if (st.photon.status === 'error' && st.photon.error) problems.push(`Photon: ${st.photon.error}`);
  $('banner').textContent = problems.join('  ·  ');
  $('banner').classList.toggle('hidden', problems.length === 0);

  if (!phoneTouched && !$('phone').value) $('phone').value = st.defaultPhone || '';

  const s = st.session;
  const active = s && s.status === 'active';
  $('start').classList.toggle('hidden', !!active);
  $('session').classList.toggle('hidden', !active);
  $('startBtn').disabled = !db;

  if (!active) {
    const show = s && st.summary && st.summary.text;
    $('lastDebrief').classList.toggle('hidden', !show);
    if (show) $('lastDebriefText').textContent = st.summary.text + (st.summary.sent ? '\n\n✓ sent to your iMessage' : '\n\n(not delivered by iMessage)');
    else if (s && s.status === 'ended') {
      $('lastDebrief').classList.remove('hidden');
      $('lastDebriefText').textContent = 'Writing your debrief…';
    }
    return;
  }

  // Goal + clock
  const now = Date.now();
  const total = s.minutes * 60000;
  const elapsed = now - s.startedMs;
  $('sGoal').textContent = s.goal;
  $('sProgress').style.width = `${Math.min(100, (elapsed / total) * 100)}%`;
  $('sElapsed').textContent = `${fmtClock(elapsed)} elapsed`;
  $('sLeft').textContent = `${fmtClock(total - elapsed)} left`;

  // Current window
  const c = st.current;
  if (c) {
    $('cVerdict').className = `verdict ${c.verdict}`;
    $('cVerdict').textContent = label(c.verdict);
    $('cTitle').textContent = c.title || c.app;
    $('cSub').textContent = c.url ? `${c.app} · ${c.url}` : c.app;
    const src = c.source === 'rule' ? 'rule' : c.source === 'memory' ? 'remembered' : c.source === 'judge' ? `Nemotron, ${Math.round(c.confidence * 100)}%` : '';
    $('cReason').textContent = c.reason ? `${c.reason}${src ? `  (${src})` : ''}` : c.verdict === 'pending' ? 'The agent is investigating this window…' : '';
  } else {
    $('cTitle').textContent = 'Switch to the window you want to work in.';
    $('cSub').textContent = '';
    $('cReason').textContent = '';
  }

  // Metrics
  const m = st.metrics;
  if (m) {
    $('mScore').textContent = m.focusScore;
    $('mOn').textContent = `${Math.round(m.onTaskRatio * 100)}%`;
    $('mDrifts').textContent = m.drifts;
    $('mReturn').textContent = m.meanReturnSeconds === null ? '—' : `${m.meanReturnSeconds}s`;
  }

  // Event list
  $('events').innerHTML = st.events.length
    ? st.events.map((e) => `<div class="list-item"><span class="t">${fmtTime(e.tsMs)}</span><span class="w" title="${esc(e.title)}">${esc(e.title || e.app)} <span style="color:var(--faint)">${esc(host(e.url) || e.app)}</span></span><span class="dot ${e.verdict}"></span></div>`).join('')
    : '<div class="empty">No windows yet.</div>';

  // Agent trace
  $('latency').textContent = st.model.split('/').pop();
  $('trace').innerHTML = st.trace.length
    ? st.trace.map((t) => `<div class="step"><div class="head"><span class="kind ${esc(t.kind)}">${esc(t.kind)}</span><span class="tool">${esc(t.tool)}</span><span class="ts">${fmtTime(t.tsMs)}</span></div>${t.args && t.args !== '{}' ? `<div class="args">${esc(t.args.slice(0, 300))}</div>` : ''}${t.result ? `<div class="res">→ ${esc(t.result.slice(0, 500))}</div>` : ''}</div>`).join('')
    : '<div class="empty">The agent’s tool calls will appear here.</div>';

  // Rules
  $('rules').innerHTML = s.rules.length
    ? s.rules.map((r) => `<span class="chip ${r.verdict}" title="${esc(r.source)}">${r.verdict === 'on_task' ? '+' : '−'} ${esc(r.kind)}:${esc(r.pattern)}</span>`).join('')
    : '<span class="empty">Building your context profile…</span>';
}

$('phone').addEventListener('input', () => (phoneTouched = true));
$('startBtn').addEventListener('click', async () => {
  const goal = $('goal').value.trim();
  if (!goal) return $('goal').focus();
  $('startBtn').disabled = true;
  try {
    await window.fg.startSession(goal, Number($('minutes').value) || 30, $('phone').value.trim());
  } catch (e) {
    alert(e.message || e);
  } finally {
    $('startBtn').disabled = false;
  }
});
$('endBtn').addEventListener('click', async () => {
  const ok = await window.fg.endSession($('endPhrase').value);
  if (!ok) {
    $('endPhrase').value = '';
    $('endPhrase').placeholder = 'Type exactly: i am done focusing';
    $('endPhrase').focus();
  } else $('endPhrase').value = '';
});

window.fg.onState(render);
window.fg.getState().then(render);
