// Full-screen overlay shown while an intervention is open.
const $ = (id) => document.getElementById(id);
const RING = 2 * Math.PI * 104;
const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

function render(st) {
  if (st.accent) document.documentElement.style.setProperty('--accent', st.accent);
  const s = st.session;
  const iv = st.intervention;
  if (!s || !iv) return;
  $('goal').textContent = s.goal;
  const site = iv.distraction.split(' — ')[0];
  $('why').textContent = iv.reason ? `${site}: ${iv.reason}` : `You switched to ${site}.`;
  const b = st.backTo;
  $('back').textContent = b ? `Back to ${b.url ? host(b.url) || b.app : b.app}` : 'Back to work';

  const elapsed = (Date.now() - iv.shownMs) / 1000;
  const arc = $('dialArc');
  arc.style.strokeDasharray = `${RING}`;
  const left = Math.max(0, 10 - elapsed);
  if (iv.alerted || left === 0) {
    // Countdown finished: show a settled state instead of a running number.
    arc.style.strokeDashoffset = '0';
    $('count').textContent = iv.alerted ? 'Sent' : '…';
    $('count').classList.add('word');
    $('countSub').textContent = iv.alerted ? 'Texted your phone' : 'Texting your phone';
  } else {
    arc.style.strokeDashoffset = `${RING * (1 - left / 10)}`;
    $('count').textContent = Math.ceil(left);
    $('count').classList.remove('word');
    $('countSub').textContent = 'until we text you';
  }
}

$('back').addEventListener('click', () => window.fg.goBack());
$('showEnd').addEventListener('click', () => {
  $('endBox').classList.toggle('hidden');
  $('endPhrase').focus();
});
async function end() {
  const ok = await window.fg.endSession($('endPhrase').value);
  $('endPhrase').value = '';
  if (!ok) $('endPhrase').placeholder = 'Type it exactly: i am done focusing';
}
$('endBtn').addEventListener('click', end);
$('endPhrase').addEventListener('keydown', (e) => e.key === 'Enter' && end());

window.fg.onState(render);
window.fg.getState().then(render);
