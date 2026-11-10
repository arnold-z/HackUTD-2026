// Anchor Electron main process.
import { app, BrowserWindow, ipcMain, screen, dialog, Tray, Menu, nativeImage, nativeTheme, systemPreferences, shell, desktopCapturer } from 'electron';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, config } from './config.js';
import { connect, activeSession, latestSession, micros, openIntervention, sessionEvents, sessionRules, type Conn } from './db.js';
import { getFrontWindow, activateWindow, type FrontWindow } from './mac.js';
import { Agent, isContentApp } from './agent.js';
import { captureScreenForModel, screenFingerprint, fingerprintDiff, screenAccess } from './capture.js';
import { initPhoton, photonStatus, photonError, stopPhoton } from './photon.js';
import { chat } from './llm.js';

const RENDERER = join(ROOT, 'renderer');
const PRELOAD = join(ROOT, 'renderer', 'preload.cjs');
const END_PHRASE = 'i am done focusing';

// ---------------- Settings (remembered across sessions) ----------------
type NotesBack = 'main' | 'separate' | 'ask';
type Settings = { notesBack: NotesBack };
const DEFAULT_SETTINGS: Settings = { notesBack: 'main' };
const settingsFile = () => join(app.getPath('userData'), 'settings.json');
let settings: Settings = { ...DEFAULT_SETTINGS };
function loadSettings() {
  try {
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(settingsFile(), 'utf8')) };
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
  if (!['main', 'separate', 'ask'].includes(settings.notesBack)) settings.notesBack = 'main';
}
function saveSettings() {
  try {
    writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch (err: any) {
    console.error('[settings] could not save', err?.message ?? err);
  }
}

let conn: Conn | undefined;
let agent: Agent | undefined;
let mainWin: BrowserWindow | undefined;
let overlays: BrowserWindow[] = [];
let overlayShownFor: bigint | undefined;
let dbStatus = 'connecting…';
let watcherError = '';
let allowQuit = false;

// Watcher state (kept in the main process; pids are not stored in the DB).
let lastKey = '';
let lastLoggedAt = 0;
let lastFront: FrontWindow | undefined;
const pidByKey = new Map<string, number>();
// In-window change detection for content apps (switching notes keeps the same title).
let baselineFp: Uint8Array | null = null;
let lastFpAt = 0;
const FP_INTERVAL_MS = 2000;
const SETTLE_MS = 2000; // a window must stay unchanged this long before it is judged
const SETTLE_BLOCKED_MS = 700; // shorter while the overlay is up, so going back clears it fast
let candidateKey = '';
let candidateSince = 0;
let contentCandidate: Uint8Array | null = null;
let contentSince = 0;
const FP_CHANGE = 0.02; // share of pixels that must change to count as different content (another note)
let lastOnTask: { app: string; pid: number; url: string; title: string; noteId?: string } | undefined;

// Where "Back" should go: the most recent window whose *latest* verdict is still on task, never
// the window you're blocked on, preferring windows the agent was confident about. Computed fresh,
// because a window first allowed (e.g. while unsure) can later be judged off task.
function backTarget(): typeof lastOnTask {
  if (!conn) return lastOnTask;
  const s = activeSession(conn);
  if (!s) return lastOnTask;
  const events = sessionEvents(conn, s.id);
  const current = conn.db.activityEvent.id.find(s.latestEventId);
  const currentKey = current ? keyOf(current) : '';
  const latestByKey = new Map<string, (typeof events)[number]>();
  for (const e of events) latestByKey.set(keyOf(e), e); // events are oldest -> newest
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const k = keyOf(e);
    if (k === currentKey || latestByKey.get(k) !== e || e.verdict !== 'on_task') continue;
    // Only places the agent was sure about: no "allowed because unsure" or blind guesses.
    if (e.confidence < 0.6 || /^Allowed \(unsure/.test(e.reason)) continue;
    if (e.app === 'Notes') {
      // Notes can report a stale note name, so only trust the title Nemotron read on screen.
      const seen = agent?.seenTitles.get(e.id.toString());
      if (!seen) continue;
      const curSeen = current ? agent?.seenTitles.get(current.id.toString()) : undefined;
      if (curSeen && curSeen === seen) continue; // that's the note being blocked
      return { app: 'Notes', title: seen, url: '', pid: pidByKey.get(k) ?? 0, noteId: undefined };
    }
    // Same name as the blocked window is ambiguous: skip it.
    if (current && e.app === current.app && e.title === current.title) continue;
    return toTarget(e);
  }
  return undefined; // nothing safe: "Back to work" opens Anchor instead
}
function toTarget(e: { app: string; title: string; url: string }) {
  const k = keyOf(e);
  return { app: e.app, title: e.title, url: e.url, pid: pidByKey.get(k) ?? 0, noteId: noteIdByKey.get(k) };
}
const noteIdByKey = new Map<string, string>(); // Apple Notes: window key -> note id, for Back

const keyOf = (w: { app: string; title: string; url: string }) => `${w.app}\u0001${w.title}\u0001${w.url}`;

// ---------------- Pause ----------------
function pauseInfo(sessionId: bigint) {
  const p = conn?.db.sessionPause.sessionId.find(sessionId);
  const pausedAtMs = p?.pausedAt ? micros(p.pausedAt) : null;
  const finishedMs = p ? Number(p.pausedMicros / 1000n) : 0;
  return { paused: pausedAtMs !== null, pausedAtMs, pausedMs: finishedMs + (pausedAtMs !== null ? Date.now() - pausedAtMs : 0), finishedMs };
}
function remainingMs(s: { id: bigint; minutes: number; startedAt: { microsSinceUnixEpoch: bigint } }) {
  return s.minutes * 60000 - (Date.now() - micros(s.startedAt) - pauseInfo(s.id).pausedMs);
}

// Pausing costs effort: the user must type a ~100-word paragraph about their goal.
let pauseChallenge = '';
const normalizeTyping = (t: string) =>
  t.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[\u2013\u2014]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();

function cleanParagraph(text: string) {
  let t = text.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D"]/g, '').replace(/[\u2013\u2014]/g, ', ').replace(/[*_#`>\[\]]/g, '');
  t = t.replace(/[^A-Za-z0-9 ,.'?!;:-]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = t.split(' ');
  if (words.length > 110) t = words.slice(0, 100).join(' ').replace(/[,;:]$/, '') + '.';
  return t;
}

function fallbackParagraph(goal: string) {
  const g = goal.replace(/[^A-Za-z0-9 ,.'-]/g, ' ').replace(/\s+/g, ' ').trim();
  const pool = [
    `I started this session to work on ${g}, and stopping now should be a real choice.`,
    'Every pause has a cost, because getting back into deep work takes time and energy.',
    'Before I step away, I want to remember exactly where I left off and what comes next.',
    'Small breaks are healthy when they are planned, but drifting away is not the same thing.',
    'When I return, I will reopen the same window and finish the next small step first.',
    'Focus is a skill that grows each time I choose the task in front of me.',
    'If this break is about avoiding something hard, I can break that hard part into smaller pieces.',
    'Progress comes from steady minutes added together, not from waiting for the perfect mood.',
    'I will drink some water, stretch for a moment, and then come back ready to continue.',
    'Typing this slowly gives me one more chance to decide whether I really need to stop.',
  ];
  const out: string[] = [];
  const bag = [...pool];
  while (out.join(' ').split(' ').length < 95 && bag.length) out.push(bag.splice(Math.floor(Math.random() * bag.length), 1)[0]);
  return out.join(' ');
}

async function makePauseChallenge(goal: string) {
  try {
    const angle = ['a short story', 'a pep talk', 'a study tip', 'a plain explanation', 'a reflection'][Math.floor(Math.random() * 5)];
    const r = await chat(
      [{
        role: 'user',
        content: `Write ${angle} as ONE paragraph of exactly 100 words about this goal: "${goal}". Relate it to the goal's subject. Use plain everyday words, and only periods and commas for punctuation. No lists, quotes, numbers, symbols or markdown. Output only the paragraph.`,
      }],
      { maxTokens: 400, temperature: 0.9, timeoutMs: 20_000 }
    );
    const t = cleanParagraph(r.content);
    const n = t.split(' ').length;
    if (n >= 70 && n <= 130) return t;
  } catch (err: any) {
    console.error('[pause] paragraph generation failed:', err?.message ?? err);
  }
  return fallbackParagraph(goal);
}

// ---------------- Crash guard + log file ----------------
// Any error is logged to ~/Library/Logs/Anchor/main.log and the app keeps running.
app.setName('Anchor');
let logFile = '';
function logLine(level: string, args: unknown[]) {
  if (!logFile) return;
  const text = args.map((a) => (a instanceof Error ? a.stack ?? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  try {
    appendFileSync(logFile, `${new Date().toISOString()} ${level} ${text}\n`);
  } catch {
    /* ignore */
  }
}
for (const level of ['log', 'warn', 'error'] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    orig(...args);
    logLine(level.toUpperCase(), args);
  };
}
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason as any));

// ---------------- Theme ----------------
nativeTheme.themeSource = 'system';
function accentColor(): string {
  try {
    const c = systemPreferences.getAccentColor?.(); // 'RRGGBBAA'
    return c ? `#${c.slice(0, 6)}` : '#007aff';
  } catch {
    return '#007aff';
  }
}

// ---------------- Permissions ----------------
// macOS applies Screen Recording only to a freshly started app, so remember the launch state.
const SETTINGS = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
} as const;
let screenAtLaunch = '';
function permissions() {
  if (process.platform !== 'darwin') return null;
  const screenNow = screenAccess();
  if (!screenAtLaunch) screenAtLaunch = screenNow;
  const accessibility = systemPreferences.isTrustedAccessibilityClient(false);
  const automationBlocked = /automation|-1743|not authori[sz]ed to send apple events/i.test(watcherError);
  return {
    appName: app.isPackaged ? 'Anchor' : 'Electron (and the Terminal you launched from)',
    screen: screenNow === 'granted' ? (screenAtLaunch === 'granted' ? 'ok' : 'restart') : 'missing',
    accessibility: accessibility ? 'ok' : 'missing',
    automation: automationBlocked ? 'missing' : 'ok',
  };
}

// ---------------- Windows ----------------
function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 860,
    minHeight: 600,
    title: 'Anchor',
    // Native macOS look: inset traffic lights, translucent sidebar, follows light/dark mode.
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    backgroundColor: '#00000000',
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  });
  mainWin.loadFile(join(RENDERER, 'index.html'));
  // Closing the window hides it, like a normal Mac app; reopen from the Dock or menu bar.
  mainWin.on('close', (e) => {
    if (allowQuit) return;
    e.preventDefault();
    mainWin?.hide();
  });
  mainWin.on('closed', () => (mainWin = undefined));
  mainWin.webContents.on('render-process-gone', (_e, details) => {
    console.error('[main window] renderer gone:', details.reason);
    setTimeout(() => mainWin?.reload(), 500);
  });
}

function showMain() {
  if (!mainWin || mainWin.isDestroyed()) createMainWindow();
  if (mainWin!.isMinimized()) mainWin!.restore();
  mainWin!.show();
  app.focus({ steal: true }); // make Anchor the active app (menu bar shows "Anchor")
  mainWin!.focus();
}

// ---------------- Menu bar item ----------------
// A colored status dot plus "On task 12:34". Every window switch plays a short sweep animation,
// even on-task to on-task; while the agent is still judging, an orange ring spins.
let tray: Tray | undefined;
let trayMenuKey = '';
let trayAnimKey = '';
let trayAnimTimer: NodeJS.Timeout | undefined;
let traySettled: string = 'idleTemplate';
const trayImages = new Map<string, Electron.NativeImage>();
function trayImage(name: string) {
  let img = trayImages.get(name);
  if (!img) {
    img = nativeImage.createFromPath(join(ROOT, 'build', 'tray', `${name}.png`)); // picks up @2x automatically
    if (name.endsWith('Template')) img.setTemplateImage(true);
    trayImages.set(name, img);
  }
  return img;
}

function createTray() {
  tray = new Tray(trayImage('idleTemplate'));
  tray.setToolTip('Anchor');
  tray.on('click', () => showMain());
  updateTray();
}

function playTray(state: 'on' | 'off' | 'pending') {
  if (trayAnimTimer) clearInterval(trayAnimTimer);
  let frame = 0;
  if (state === 'pending') {
    traySettled = 'spin0';
    trayAnimTimer = setInterval(() => {
      if (!tray || tray.isDestroyed()) return;
      tray.setImage(trayImage(`spin${frame++ % 8}`));
    }, 90);
    return;
  }
  traySettled = state;
  trayAnimTimer = setInterval(() => {
    if (!tray || tray.isDestroyed()) return;
    frame++;
    if (frame <= 6) tray.setImage(trayImage(`${state}-sweep${frame}`));
    else {
      tray.setImage(trayImage(state));
      clearInterval(trayAnimTimer);
      trayAnimTimer = undefined;
    }
  }, 45);
}

function updateTray() {
  if (!tray || tray.isDestroyed()) return;
  const s = conn ? activeSession(conn) : undefined;
  const latest = s && conn ? conn.db.activityEvent.id.find(s.latestEventId) : undefined;
  let title = ' Anchor';
  let windowLabel = '';
  if (s) {
    const left = remainingMs(s);
    const sec = Math.max(0, Math.floor(left / 1000));
    const clock = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    const blocked = !!openIntervention(conn!, s.id);
    const paused = pauseInfo(s.id).paused;
    const state: 'on' | 'off' | 'pending' = blocked || latest?.verdict === 'off_task' ? 'off' : latest?.verdict === 'pending' ? 'pending' : 'on';
    title = paused ? ` Paused  ${clock}` : ` ${state === 'on' ? 'On task' : state === 'off' ? 'Off task' : 'Checking'}  ${clock}`;
    if (paused) {
      if (trayAnimKey !== 'paused') {
        trayAnimKey = 'paused';
        if (trayAnimTimer) clearInterval(trayAnimTimer);
        trayAnimTimer = undefined;
        tray.setImage(trayImage('idleTemplate'));
      }
      tray.setTitle(title, { fontType: 'monospacedDigit' });
      return;
    }
    windowLabel = latest ? `${latest.app}${latest.title && latest.title !== latest.app ? ': ' + latest.title.slice(0, 50) : ''}` : '';
    // A new window (or a new verdict for it) replays the transition.
    const animKey = `${s.latestEventId}:${state}`;
    if (animKey !== trayAnimKey) {
      trayAnimKey = animKey;
      playTray(state);
    }
  } else if (trayAnimKey !== 'idle') {
    trayAnimKey = 'idle';
    if (trayAnimTimer) clearInterval(trayAnimTimer);
    trayAnimTimer = undefined;
    traySettled = 'idleTemplate';
    tray.setImage(trayImage('idleTemplate'));
  }
  tray.setTitle(title, { fontType: 'monospacedDigit' });
  const menuKey = s ? `active:${s.id}:${windowLabel}` : 'idle';
  if (menuKey === trayMenuKey) return;
  trayMenuKey = menuKey;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: s ? `Focusing on: ${s.goal.slice(0, 40)}` : 'No focus session', enabled: false },
      ...(windowLabel ? [{ label: `Now: ${windowLabel}`, enabled: false }] : []),
      { type: 'separator' as const },
      { label: 'Open Anchor', click: () => showMain() },
      { label: s ? 'Quit (end the session first)' : 'Quit Anchor', enabled: !s, click: () => quitApp() },
    ])
  );
}

function quitApp() {
  allowQuit = true;
  destroyOverlays();
  tray?.destroy();
  app.quit();
}

function createOverlays() {
  destroyOverlays();
  for (const d of screen.getAllDisplays()) {
    const w = new BrowserWindow({
      ...d.bounds,
      frame: false,
      show: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      closable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      transparent: true,
      vibrancy: 'fullscreen-ui',
      visualEffectState: 'active',
      backgroundColor: '#00000000',
      webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
    });
    w.setAlwaysOnTop(true, 'screen-saver');
    // skipTransformProcessType: without it Electron turns Anchor into a background "accessory"
    // app (no menu bar, never frontmost), so macOS kept reporting the previous app as active.
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    w.on('close', (e) => {
      if (!allowQuit) e.preventDefault();
    });
    w.on('blur', () => setTimeout(enforceFocus, 400));
    w.loadFile(join(RENDERER, 'overlay.html'));
    overlays.push(w);
  }
}

function destroyOverlays() {
  for (const w of overlays) {
    if (!w.isDestroyed()) {
      w.removeAllListeners('close');
      w.destroy();
    }
  }
  overlays = [];
}

// ---- Text alert: only after the popup has stayed on screen for the full 10 seconds ----
const ALERT_AFTER_MS = 10_000;
let countdownStartedAt: number | undefined;
let countdownTimer: NodeJS.Timeout | undefined;
let alertedThisShowing = false;
function startCountdown() {
  if (countdownTimer) return; // already counting
  countdownStartedAt = Date.now();
  alertedThisShowing = false;
  countdownTimer = setTimeout(() => {
    countdownTimer = undefined;
    const s = conn ? activeSession(conn) : undefined;
    const iv = s && conn ? openIntervention(conn, s.id) : undefined;
    if (!iv || !overlayVisible()) return;
    console.log('[alert] popup stayed up for 10 s; texting');
    alertedThisShowing = true;
    agent?.sendAlertFor(iv.id);
    pushState();
  }, ALERT_AFTER_MS);
  pushState();
}
function stopCountdown(why: string) {
  if (!countdownTimer) return;
  clearTimeout(countdownTimer);
  countdownTimer = undefined;
  countdownStartedAt = undefined;
  console.log(`[alert] countdown cancelled (${why})`);
}

function showOverlay() {
  startCountdown();
  if (!overlays.length || overlays.some((w) => w.isDestroyed())) createOverlays();
  for (const w of overlays) {
    w.setAlwaysOnTop(true, 'screen-saver');
    w.showInactive();
  }
  focusOverlay();
}

function focusOverlay() {
  const primary = screen.getPrimaryDisplay();
  const target = overlays.find((w) => {
    const b = w.getBounds();
    return b.x === primary.bounds.x && b.y === primary.bounds.y;
  }) ?? overlays[0];
  app.focus({ steal: true });
  target?.show();
  target?.focus();
}

function hideOverlay() {
  stopCountdown('popup closed');
  for (const w of overlays) if (!w.isDestroyed()) w.hide();
  overlayShownFor = undefined;
}

const overlayVisible = () => overlays.some((w) => !w.isDestroyed() && w.isVisible());

// While an intervention is open, any other window that isn't judged on-task gets covered again.
function enforceFocus() {
  if (!conn || !overlayVisible() || Date.now() < graceUntil) return;
  const s = activeSession(conn);
  if (!s || pauseInfo(s.id).paused || !openIntervention(conn, s.id)) return;
  if (!lastFront || lastFront.pid === process.pid) return;
  if (Date.now() - lastLoggedAt < 800) return; // give the reducer a moment to resolve a return
  const latest = conn.db.activityEvent.id.find(s.latestEventId);
  if (latest && latest.verdict === 'on_task') return;
  if (awaitingNewVerdict(s.id)) return; // you moved to another window that is still being judged
  if (staleVerdict(s.id)) {
    requestRecheck('focus guard');
    return;
  }
  startCountdown(); // covered again after Back didn't land on task: a fresh 10 s
  focusOverlay();
}

// When you left the popup (Back, a switch, a grace period). A verdict older than this can't bring
// the popup back: what's on screen now must be checked again first.
let leftPopupAt = 0;
let forceRecheck = false;
function markLeftPopup() {
  leftPopupAt = Date.now();
}
function staleVerdict(sessionId: bigint): boolean {
  if (!conn) return false;
  const s = conn.db.session.id.find(sessionId);
  const latest = s ? conn.db.activityEvent.id.find(s.latestEventId) : undefined;
  return !!latest && micros(latest.ts) < leftPopupAt;
}
function requestRecheck(why: string) {
  if (forceRecheck) return;
  forceRecheck = true;
  console.log(`[overlay] not re-showing an old verdict (${why}); checking the current window again`);
}

// The block is for window X, but you've since moved to window Y and its verdict isn't in yet.
// Don't cover Y with X's message (and don't let the judge's screenshot capture the overlay):
// wait for Y's verdict, which either clears the block or re-shows it for Y.
function awaitingNewVerdict(sessionId: bigint): boolean {
  if (!conn) return false;
  const s = conn.db.session.id.find(sessionId);
  const iv = openIntervention(conn, sessionId);
  if (!s || !iv) return false;
  const latest = conn.db.activityEvent.id.find(s.latestEventId);
  return !!latest && latest.id !== iv.eventId && latest.verdict === 'pending';
}

// ---------------- Watcher ----------------
async function tick() {
  if (!conn) return;
  const s = activeSession(conn);
  if (!s || pauseInfo(s.id).paused) return; // paused: nothing is watched or judged
  // Anchor's own window in front: always allowed, nothing to judge.
  if (mainWin && !mainWin.isDestroyed() && mainWin.isFocused()) return;
  let w: FrontWindow;
  try {
    w = await getFrontWindow();
    watcherError = '';
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    watcherError = /not allowed|assistive|1002|-1743|-25211/i.test(msg)
      ? 'macOS blocked window access. Open System Settings → Privacy & Security → Accessibility (and Automation) and enable the app running Anchor (Terminal / VS Code / Electron), then restart it.'
      : `window watcher: ${msg}`;
    pushState();
    return;
  }
  lastFront = w;
  if (w.pid === process.pid || !w.app) return; // ignore our own windows
  const key = keyOf(w);
  pidByKey.set(key, w.pid);
  if (w.noteId) noteIdByKey.set(key, w.noteId);
  let relog = false;
  const now = Date.now();
  if (forceRecheck) {
    // Re-judge whatever is on screen now instead of reusing the verdict from before.
    forceRecheck = false;
    relog = true;
    lastKey = key;
    candidateKey = key;
    baselineFp = null;
    contentCandidate = null;
  } else if (key !== lastKey) {
    // Only judge a window once it has stayed put for SETTLE_MS (passing through the Notes list
    // on the way from note A to note B doesn't count). Shorter while blocked, so going back is quick.
    const settle = openIntervention(conn, s.id) ? SETTLE_BLOCKED_MS : SETTLE_MS;
    if (key !== candidateKey) {
      candidateKey = key;
      candidateSince = now;
    } else if (now - candidateSince >= settle) {
      lastKey = key;
      relog = true;
      baselineFp = null;
      contentCandidate = null;
    }
  } else {
    candidateKey = key;
    const interval = contentCandidate || now < graceUntil ? 1000 : FP_INTERVAL_MS;
    if (isContentApp(w.app) && now - lastFpAt > interval && (!openIntervention(conn, s.id) || now < graceUntil)) {
      // Same window title in a notes/docs/chat app: did the content change (another note)?
      lastFpAt = now;
      const latest = conn.db.activityEvent.id.find(s.latestEventId);
      const fp = await screenFingerprint();
      if (fp && latest && latest.verdict !== 'pending') {
        if (!baselineFp) baselineFp = fp;
        else if (contentCandidate) {
          if (fingerprintDiff(contentCandidate, fp) > FP_CHANGE) {
            contentCandidate = fp; // still changing: wait for it to settle
            contentSince = now;
          } else if (now - contentSince >= SETTLE_MS) {
            console.log(`[watcher] content changed inside ${w.app}; asking the judge again`);
            baselineFp = fp;
            contentCandidate = null;
            relog = true;
          }
        } else if (fingerprintDiff(baselineFp, fp) > FP_CHANGE) {
          contentCandidate = fp;
          contentSince = now;
        }
      }
    }
  }
  if (relog) {
    lastLoggedAt = Date.now();
    try {
      console.log(`[watcher] now on: ${w.app} / ${w.title.slice(0, 60)}`);
      await conn.reducers.logActivity({ sessionId: s.id, app: w.app, title: w.title.slice(0, 300), url: w.url.slice(0, 1000) });
    } catch (err: any) {
      console.error('[watcher] logActivity failed', err?.message ?? err);
    }
  }
  enforceFocus();
}

function startWatcher() {
  const loop = async () => {
    await tick().catch((e) => console.error('[watcher]', e));
    setTimeout(loop, config.pollMs);
  };
  loop();
}

// ---------------- DB reactions ----------------
let lastActiveId: bigint | undefined;
function onDbChange() {
  if (!conn) return;
  const s = activeSession(conn);
  // When a session ends (timer or manually), bring the window back with the debrief.
  if (lastActiveId !== undefined && !s) {
    hideOverlay();
    showMain();
  }
  lastActiveId = s?.id;
  updateTray();
  // Track the last on-task window for the "Back to …" button.
  if (s) {
    const latest = conn.db.activityEvent.id.find(s.latestEventId);
    if (latest && latest.verdict === 'on_task') {
      lastOnTask = { app: latest.app, title: latest.title, url: latest.url, pid: pidByKey.get(keyOf(latest)) ?? 0, noteId: noteIdByKey.get(keyOf(latest)) };
    }
  }
  const iv = s ? openIntervention(conn, s.id) : undefined;
  if (iv && s && awaitingNewVerdict(s.id)) {
    if (overlayVisible()) {
      console.log('[overlay] hidden while the new window is judged');
      stopCountdown('switched to another window');
      markLeftPopup();
      for (const w of overlays) if (!w.isDestroyed()) w.hide();
    }
    overlayShownFor = iv.id;
  } else if (iv && overlayShownFor !== iv.id) {
    overlayShownFor = iv.id;
    showOverlay();
  } else if (iv && s && !overlayVisible() && Date.now() >= graceUntil && conn.db.activityEvent.id.find(s.latestEventId)?.verdict === 'off_task') {
    if (staleVerdict(s.id)) requestRecheck('popup hidden');
    else {
      console.log('[overlay] re-shown: current window judged off task');
      showOverlay(); // the window you landed on was judged off task (a fresh verdict)
    }
  } else if (!iv && overlayVisible()) {
    hideOverlay();
  }
  pushState();
}

let pushTimer: NodeJS.Timeout | undefined;
function pushState() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = undefined;
    const st = snapshot();
    mainWin?.webContents.send('state', st);
    for (const w of overlays) if (!w.isDestroyed()) w.webContents.send('state', st);
  }, 60);
}

function snapshot() {
  const base = {
    dbStatus,
    watcherError,
    llm: agent?.status ?? { llm: 'unknown', llmError: '', lastLatencyMs: 0 },
    photon: { status: photonStatus, error: photonError },
    model: config.llmModel,
    permissions: permissions(),
    accent: accentColor(),
    defaultPhone: config.userPhone,
    endPhrase: END_PHRASE,
    settings,
  };
  if (!conn) return { ...base, session: null };
  const s = activeSession(conn) ?? latestSession(conn);
  if (!s) return { ...base, session: null };
  const events = sessionEvents(conn, s.id);
  const latest = conn.db.activityEvent.id.find(s.latestEventId);
  const iv = openIntervention(conn, s.id);
  const traces = [...conn.db.agentTrace.iter()]
    .filter((t) => t.sessionId === s.id)
    .sort((a, b) => (a.id < b.id ? 1 : -1))
    .slice(0, 60);
  const jobs = new Map([...conn.db.agentJob.iter()].filter((j) => j.sessionId === s.id).map((j) => [j.id, j]));
  const summary = conn.db.sessionSummary.sessionId.find(s.id);
  let profile: any = null;
  try {
    profile = s.profileJson ? JSON.parse(s.profileJson) : null;
  } catch {
    profile = null;
  }
  const evOut = (e: (typeof events)[number]) => ({
    id: e.id.toString(),
    tsMs: micros(e.ts),
    app: e.app,
    title: e.title,
    url: e.url,
    verdict: e.verdict,
    reason: e.reason,
    confidence: e.confidence,
    source: e.source,
  });
  return {
    ...base,
    session: {
      id: s.id.toString(),
      goal: s.goal,
      minutes: s.minutes,
      phone: s.phone,
      status: s.status,
      startedMs: micros(s.startedAt),
      ...pauseInfo(s.id),
      endedMs: s.endedAt ? micros(s.endedAt) : null,
      profile,
      rules: sessionRules(conn, s.id).map((r) => ({ kind: r.kind, pattern: r.pattern, verdict: r.verdict, source: r.source })),
    },
    current: latest ? evOut(latest) : null,
    events: events.slice(-25).reverse().map(evOut),
    intervention: iv
      ? { id: iv.id.toString(), distraction: iv.distraction, reason: iv.reason, shownMs: countdownStartedAt ?? Date.now(), counting: !!countdownTimer, alerted: alertedThisShowing }
      : null,
    backTo: (() => {
      const b = backTarget();
      return b ? { app: b.app, title: b.title, url: b.url, isNote: b.app === 'Notes' } : null;
    })(),
    trace: traces.map((t) => ({
      id: t.id.toString(),
      jobId: t.jobId.toString(),
      kind: jobs.get(t.jobId)?.kind ?? '',
      step: t.step,
      tool: t.tool,
      args: t.args,
      result: t.result,
      tsMs: micros(t.ts),
    })),
    metrics: agent ? agent.metricsFor(s.id) : null,
    summary: summary ? { text: summary.text, sent: summary.sent } : null,
  };
}

// ---------------- IPC ----------------
ipcMain.handle('start-session', async (_e, args: { goal: string; minutes: number; phone: string }) => {
  if (!conn) throw new Error('Not connected to SpacetimeDB yet');
  lastKey = '';
  lastOnTask = undefined;
  await conn.reducers.startSession({ goal: String(args.goal), minutes: Math.round(Number(args.minutes) || 30), phone: String(args.phone || config.userPhone) });
  return true;
});

ipcMain.handle('pause-challenge', async () => {
  const s = conn ? activeSession(conn) : undefined;
  if (!s) return null;
  pauseChallenge = await makePauseChallenge(s.goal);
  return pauseChallenge;
});

ipcMain.handle('pause-submit', async (_e, typed: string) => {
  const s = conn ? activeSession(conn) : undefined;
  if (!s || !pauseChallenge) return { ok: false, reason: 'No pause in progress' };
  if (normalizeTyping(String(typed)) !== normalizeTyping(pauseChallenge)) return { ok: false, reason: "That doesn't match the paragraph yet" };
  pauseChallenge = '';
  await conn!.reducers.pauseSession({ sessionId: s.id });
  hideOverlay();
  console.log('[pause] session paused');
  return { ok: true };
});

ipcMain.handle('resume-session', async () => {
  const s = conn ? activeSession(conn) : undefined;
  if (s) await conn!.reducers.resumeSession({ sessionId: s.id });
  lastKey = ''; // re-check whatever window is open now
  return true;
});

ipcMain.handle('end-session', async (_e, args: { phrase: string }) => {
  if (!conn) return false;
  if (String(args?.phrase ?? '').trim().toLowerCase() !== END_PHRASE) return false;
  const s = activeSession(conn);
  if (s) await conn.reducers.endSession({ sessionId: s.id });
  hideOverlay();
  showMain();
  return true;
});

ipcMain.handle('set-setting', (_e, args: { key: string; value: string }) => {
  if (args?.key === 'notesBack' && ['main', 'separate', 'ask'].includes(args.value)) {
    settings.notesBack = args.value as NotesBack;
    saveSettings();
    console.log('[settings] notesBack =', settings.notesBack);
  }
  pushState();
  return settings;
});

ipcMain.handle('go-back', async (_e, args?: { separate?: boolean }) => {
  stopCountdown('clicked Back');
  const target = backTarget();
  // How to reopen a note: the user's saved choice, or the button they picked on the block screen.
  const separate = settings.notesBack === 'ask' ? !!args?.separate : settings.notesBack === 'separate';
  console.log('[go-back] target:', target ? `${target.app} / ${target.title}${target.noteId ? ' (note ' + target.noteId.slice(-12) + ')' : ''}` : 'none (Anchor window)');
  const s = conn ? activeSession(conn) : undefined;
  const offEvent = s && conn ? conn.db.activityEvent.id.find(s.latestEventId) : undefined;
  if (offEvent && isContentApp(offEvent.app)) contentGrace();
  else hideOverlayTemporarily();
  try {
    if (target) await activateWindow(target, { separate });
    else showMain();
  } catch (err: any) {
    console.error('[go-back]', err?.message ?? err);
  }
  return true;
});

ipcMain.handle('get-state', () => snapshot());

ipcMain.handle('open-permission', async (_e, kind: keyof typeof SETTINGS) => {
  if (kind === 'screen') {
    // Asking for a capture once makes macOS list this app in Screen Recording settings.
    try {
      await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
    } catch {
      /* ignore */
    }
  }
  if (kind === 'accessibility') systemPreferences.isTrustedAccessibilityClient(true);
  hideOverlay(); // the settings window must not be hidden behind the overlay
  await shell.openExternal(SETTINGS[kind] ?? SETTINGS.screen);
  return true;
});

ipcMain.handle('restart-app', () => {
  console.log('[app] restarting to apply permissions');
  allowQuit = true;
  destroyOverlays();
  app.relaunch();
  app.exit(0);
});

// Off task inside a notes/docs/chat app: going "back" means opening a different note in the
// same app, which the overlay would cover. Hide it for a short grace period; the watcher
// re-judges the new content from a screenshot, and the overlay returns if still off task.
let graceUntil = 0;
function contentGrace() {
  graceUntil = Date.now() + 8000;
  stopCountdown('went back');
  markLeftPopup();
  lastFpAt = 0; // check content on the next tick
  for (const w of overlays) if (!w.isDestroyed()) w.hide();
  // Fingerprint the off-task content right away so a quick switch to another note registers.
  setTimeout(async () => {
    if (!baselineFp) baselineFp = await screenFingerprint();
  }, 250);
  const deadline = Date.now() + 20000;
  const check = () => {
    if (!conn) return;
    const s = activeSession(conn);
    if (!s || !openIntervention(conn, s.id)) return; // resolved: on task again
    const latest = conn.db.activityEvent.id.find(s.latestEventId);
    if ((Date.now() < graceUntil || latest?.verdict === 'pending') && Date.now() < deadline) {
      setTimeout(check, 1000);
      return;
    }
    graceUntil = 0;
    // Only cover the screen again for a window that was actually judged off task, never
    // because a judgment of the window you went back to is still running.
    if (latest && latest.verdict === 'off_task') {
      if (staleVerdict(s.id)) {
        requestRecheck('grace over');
        setTimeout(check, 1000);
        return;
      }
      console.log(`[overlay] grace over, still off task: ${latest.app} / ${latest.title.slice(0, 60)}`);
      showOverlay();
    }
    else if (latest?.verdict === 'pending') setTimeout(check, 1000);
  };
  setTimeout(check, 1000);
}

// Lower the overlay briefly so the restored window can take focus; if the user doesn't
// land on an on-task window, enforceFocus() raises it again on the next tick.
function hideOverlayTemporarily() {
  markLeftPopup();
  for (const w of overlays) if (!w.isDestroyed()) w.setAlwaysOnTop(false);
  lastLoggedAt = Date.now();
  setTimeout(() => {
    if (!conn) return;
    const s = activeSession(conn);
    if (s && openIntervention(conn, s.id)) {
      if (awaitingNewVerdict(s.id) || staleVerdict(s.id)) {
        // Don't raise the old message: hide it until the current window has a fresh verdict.
        for (const w of overlays) if (!w.isDestroyed()) w.hide();
        if (!awaitingNewVerdict(s.id)) requestRecheck('after Back');
        return;
      }
      for (const w of overlays) if (!w.isDestroyed()) w.setAlwaysOnTop(true, 'screen-saver');
      enforceFocus();
    }
  }, 3500);
}

// ---------------- App lifecycle ----------------
app.whenReady().then(() => {
  loadSettings();
  // Our own Dock icon even when running unpackaged with `npm start`.
  try {
    app.dock?.setIcon(nativeImage.createFromPath(join(ROOT, 'build', 'icon.png')));
  } catch {
    /* packaged app uses the bundle icon */
  }
  try {
    mkdirSync(app.getPath('logs'), { recursive: true });
    logFile = join(app.getPath('logs'), 'main.log');
    console.log('[app] Anchor started; log file:', logFile);
  } catch {
    /* logging stays console-only */
  }
  createTray();
  nativeTheme.on('updated', () => pushState());
  systemPreferences.on?.('accent-color-changed' as any, () => pushState());
  createMainWindow();
  createOverlays();
  // Stay a regular foreground app (Dock icon, own menu bar, can be frontmost) even after the
  // always-on-top overlays are set up, and come to the front at launch.
  if (process.platform === 'darwin') {
    try {
      app.setActivationPolicy('regular');
      app.dock?.show();
    } catch {
      /* ignore */
    }
  }
  mainWin?.once('ready-to-show', () => showMain());
  setTimeout(() => showMain(), 800);
  app.on('activate', () => showMain());
  initPhoton()?.catch(() => pushState());
  conn = connect(
    // One saved identity per server+database, so switching between local and Maincloud just works.
    join(app.getPath('userData'), `stdb-token-${(config.stdbUri + '-' + config.stdbDatabase).replace(/[^a-z0-9]+/gi, '_')}`),
    (c) => {
      agent = new Agent(c, pushState, captureScreenForModel);
      agent.start();
      const tables = [c.db.session, c.db.activityEvent, c.db.intervention, c.db.agentTrace, c.db.agentJob, c.db.relevanceRule, c.db.sessionSummary, c.db.sessionPause] as const;
      for (const t of tables) {
        (t as any).onInsert(() => onDbChange());
        (t as any).onUpdate?.(() => onDbChange());
        (t as any).onDelete(() => onDbChange());
      }
      onDbChange();
      startWatcher();
    },
    (status) => {
      dbStatus = status;
      console.log(`[spacetimedb] ${status}`);
      pushState();
    }
  );
  setInterval(() => {
    pushState(); // clocks and countdowns in the UI
    updateTray();
  }, 1000);
});

app.on('before-quit', (e) => {
  if (allowQuit) return;
  const s = conn ? activeSession(conn) : undefined;
  if (s) {
    e.preventDefault();
    showMain();
    dialog.showMessageBox(mainWin!, {
      type: 'info',
      message: 'A focus session is running.',
      detail: `End it first: type "${END_PHRASE}" in Anchor's End session box.`,
    });
    return;
  }
  // Cmd+Q with no session running: a real quit.
  console.log('[app] quitting');
  allowQuit = true;
  destroyOverlays();
  tray?.destroy();
  stopPhoton();
});

// Never quit just because windows closed: the app lives in the Dock and menu bar.
app.on('window-all-closed', () => {});

app.on('activate', () => showMain());
