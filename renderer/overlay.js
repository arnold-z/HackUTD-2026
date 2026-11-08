// Full-screen overlay shown while an intervention is open.
const $ = (id) => document.getElementById(id);
const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

function render(st) {
  const s = st.session;
  const iv = st.intervention;
  if (!s || !iv) return;
  $('goal').textContent = s.goal;
  $('what').textContent = `You switched to ${iv.distraction}`;
  $('why').textContent = iv.reason || '';
  const b = st.backTo;
  $('back').textContent = b ? `Back to ${b.url ? host(b.url) || b.app : b.app}${b.title ? ' — ' + b.title.slice(0, 40) : ''}` : 'Back to work';
  const secs = Math.ceil((iv.shownMs + 10000 - Date.now()) / 1000);
  const a = $('alert');
  if (iv.alerted) {
    a.textContent = `Off task for ${Math.round((Date.now() - iv.shownMs) / 1000)}s · FocusGuard texted your phone`;
    a.className = 'alert sent';
  } else {
    a.textContent = secs > 0 ? `Texting your phone in ${secs}s` : 'Texting your phone…';
    a.className = 'alert';
  }
}

$('back').addEventListener('click', () => window.fg.goBack());
$('showEnd').addEventListener('click', () => {
  $('endBox').classList.toggle('hidden');
  $('endPhrase').focus();
});
$('endBtn').addEventListener('click', async () => {
  const ok = await window.fg.endSession($('endPhrase').value);
  if (!ok) {
    $('endPhrase').value = '';
    $('endPhrase').placeholder = 'Type exactly: i am done focusing';
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && document.activeElement === $('endPhrase')) $('endBtn').click();
});

window.fg.onState(render);
window.fg.getState().then(render);
