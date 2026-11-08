// FocusGuard Electron main process.
import { app, BrowserWindow, ipcMain, screen, dialog, Tray, Menu, nativeImage } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, config } from './config.js';
import { connect, activeSession, latestSession, micros, openIntervention, sessionEvents, sessionRules, type Conn } from './db.js';
import { getFrontWindow, activateWindow, type FrontWindow } from './mac.js';
import { Agent } from './agent.js';
import { initPhoton, photonStatus, photonError, stopPhoton } from './photon.js';

const RENDERER = join(ROOT, 'renderer');
const PRELOAD = join(ROOT, 'renderer', 'preload.cjs');
const END_PHRASE = 'i am done focusing';

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
let lastOnTask: { app: string; pid: number; url: string; title: string } | undefined;

const keyOf = (w: { app: string; title: string; url: string }) => `${w.app}\u0001${w.title}\u0001${w.url}`;

// ---------------- Crash guard + log file ----------------
// Any error is logged to ~/Library/Logs/FocusGuard/main.log and the app keeps running.
app.setName('FocusGuard');
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

// ---------------- Windows ----------------
function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 860,
    minHeight: 600,
    title: 'FocusGuard',
    backgroundColor: '#0d1110',
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
  mainWin!.focus();
}

// ---------------- Menu bar item ----------------
let tray: Tray | undefined;
let trayMenuKey = '';
function createTray() {
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('FocusGuard');
  tray.on('click', () => showMain());
  updateTray();
}

function updateTray() {
  if (!tray || tray.isDestroyed()) return;
  const s = conn ? activeSession(conn) : undefined;
  let title = '◎ FocusGuard';
  if (s) {
    const left = s.minutes * 60000 - (Date.now() - micros(s.startedAt));
    const sec = Math.max(0, Math.floor(left / 1000));
    const clock = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
    title = openIntervention(conn!, s.id) ? `● Off task · ${clock}` : `◎ ${clock}`;
  }
  tray.setTitle(title);
  const menuKey = s ? `active:${s.id}` : 'idle';
  if (menuKey === trayMenuKey) return;
  trayMenuKey = menuKey;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: s ? `Focusing: ${s.goal.slice(0, 40)}` : 'No focus session', enabled: false },
      { type: 'separator' },
      { label: 'Open FocusGuard', click: () => showMain() },
      { label: s ? 'Quit (end the session first)' : 'Quit FocusGuard', enabled: !s, click: () => quitApp() },
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
      backgroundColor: '#0b0e0c',
      webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
    });
    w.setAlwaysOnTop(true, 'screen-saver');
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
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

function showOverlay() {
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
  for (const w of overlays) if (!w.isDestroyed()) w.hide();
  overlayShownFor = undefined;
}

const overlayVisible = () => overlays.some((w) => !w.isDestroyed() && w.isVisible());

// While an intervention is open, any other window that isn't judged on-task gets covered again.
function enforceFocus() {
  if (!conn || !overlayVisible()) return;
  const s = activeSession(conn);
  if (!s || !openIntervention(conn, s.id)) return;
  if (!lastFront || lastFront.pid === process.pid) return;
  if (Date.now() - lastLoggedAt < 800) return; // give the reducer a moment to resolve a return
  const latest = conn.db.activityEvent.id.find(s.latestEventId);
  if (latest && latest.verdict === 'on_task') return;
  focusOverlay();
}

// ---------------- Watcher ----------------
async function tick() {
  if (!conn) return;
  const s = activeSession(conn);
  if (!s) return;
  let w: FrontWindow;
  try {
    w = await getFrontWindow();
    watcherError = '';
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    watcherError = /not allowed|assistive|1002|-1743|-25211/i.test(msg)
      ? 'macOS blocked window access. Open System Settings → Privacy & Security → Accessibility (and Automation) and enable the app running FocusGuard (Terminal / VS Code / Electron), then restart it.'
      : `window watcher: ${msg}`;
    pushState();
    return;
  }
  lastFront = w;
  if (w.pid === process.pid || !w.app) return; // ignore our own windows
  const key = keyOf(w);
  pidByKey.set(key, w.pid);
  if (key !== lastKey) {
    lastKey = key;
    lastLoggedAt = Date.now();
    try {
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
  // Track the last on-task window for the "Back to …" button.
  if (s) {
    const latest = conn.db.activityEvent.id.find(s.latestEventId);
    if (latest && latest.verdict === 'on_task') {
      lastOnTask = { app: latest.app, title: latest.title, url: latest.url, pid: pidByKey.get(keyOf(latest)) ?? 0 };
    }
  }
  const iv = s ? openIntervention(conn, s.id) : undefined;
  if (iv && overlayShownFor !== iv.id) {
    overlayShownFor = iv.id;
    showOverlay();
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
    defaultPhone: config.userPhone,
    endPhrase: END_PHRASE,
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
      endedMs: s.endedAt ? micros(s.endedAt) : null,
      profile,
      rules: sessionRules(conn, s.id).map((r) => ({ kind: r.kind, pattern: r.pattern, verdict: r.verdict, source: r.source })),
    },
    current: latest ? evOut(latest) : null,
    events: events.slice(-25).reverse().map(evOut),
    intervention: iv
      ? { id: iv.id.toString(), distraction: iv.distraction, reason: iv.reason, shownMs: micros(iv.shownAt), alerted: iv.alerted }
      : null,
    backTo: lastOnTask ? { app: lastOnTask.app, title: lastOnTask.title, url: lastOnTask.url } : null,
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

ipcMain.handle('end-session', async (_e, args: { phrase: string }) => {
  if (!conn) return false;
  if (String(args?.phrase ?? '').trim().toLowerCase() !== END_PHRASE) return false;
  const s = activeSession(conn);
  if (s) await conn.reducers.endSession({ sessionId: s.id });
  hideOverlay();
  showMain();
  return true;
});

ipcMain.handle('go-back', async () => {
  const target = lastOnTask;
  hideOverlayTemporarily();
  try {
    if (target) await activateWindow(target);
    else showMain();
  } catch (err: any) {
    console.error('[go-back]', err?.message ?? err);
  }
  return true;
});

ipcMain.handle('get-state', () => snapshot());

// Lower the overlay briefly so the restored window can take focus; if the user doesn't
// land on an on-task window, enforceFocus() raises it again on the next tick.
function hideOverlayTemporarily() {
  for (const w of overlays) if (!w.isDestroyed()) w.setAlwaysOnTop(false);
  lastLoggedAt = Date.now();
  setTimeout(() => {
    if (!conn) return;
    const s = activeSession(conn);
    if (s && openIntervention(conn, s.id)) {
      for (const w of overlays) if (!w.isDestroyed()) w.setAlwaysOnTop(true, 'screen-saver');
      enforceFocus();
    }
  }, 2500);
}

// ---------------- App lifecycle ----------------
app.whenReady().then(() => {
  // Our own Dock icon even when running unpackaged with `npm start`.
  try {
    app.dock?.setIcon(nativeImage.createFromPath(join(ROOT, 'build', 'icon.png')));
  } catch {
    /* packaged app uses the bundle icon */
  }
  try {
    mkdirSync(app.getPath('logs'), { recursive: true });
    logFile = join(app.getPath('logs'), 'main.log');
    console.log('[app] FocusGuard started; log file:', logFile);
  } catch {
    /* logging stays console-only */
  }
  createTray();
  createMainWindow();
  createOverlays();
  initPhoton()?.catch(() => pushState());
  conn = connect(
    // One saved identity per server+database, so switching between local and Maincloud just works.
    join(app.getPath('userData'), `stdb-token-${(config.stdbUri + '-' + config.stdbDatabase).replace(/[^a-z0-9]+/gi, '_')}`),
    (c) => {
      agent = new Agent(c, pushState);
      agent.start();
      const tables = [c.db.session, c.db.activityEvent, c.db.intervention, c.db.agentTrace, c.db.agentJob, c.db.relevanceRule, c.db.sessionSummary] as const;
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
      detail: `End it first: type "${END_PHRASE}" in FocusGuard's End session box.`,
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
