// macOS window access through AppleScript (osascript): no native modules needed.
// Needs: Accessibility (window titles + refocus) and Automation (browser URLs) permissions
// for the app running FocusGuard (Terminal/iTerm/VS Code in dev, or FocusGuard itself).
import { execFile } from 'node:child_process';

export type FrontWindow = { app: string; pid: number; title: string; url: string };

const SEP = '\u001f';
const CHROMIUM = ['Google Chrome', 'Google Chrome Canary', 'Arc', 'Brave Browser', 'Microsoft Edge', 'Chromium', 'Vivaldi', 'Opera'];
const SAFARI = ['Safari', 'Safari Technology Preview'];

function osa(script: string, timeoutMs = 2500): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout.replace(/\n$/, ''));
    });
  });
}

const q = (s: string) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

const FRONT_SCRIPT = `
tell application "System Events"
  set fp to first application process whose frontmost is true
  set appName to name of fp
  set appPid to unix id of fp
  set winTitle to ""
  try
    set winTitle to name of front window of fp
  end try
  if winTitle is missing value then set winTitle to ""
end tell
return appName & (ASCII character 31) & appPid & (ASCII character 31) & winTitle`;

async function browserUrl(app: string): Promise<string> {
  try {
    if (CHROMIUM.includes(app)) {
      return await osa(`tell application ${q(app)}\n  if (count of windows) > 0 then return URL of active tab of front window\nend tell\nreturn ""`, 1500);
    }
    if (SAFARI.includes(app)) {
      return await osa(`tell application ${q(app)}\n  if (count of documents) > 0 then return URL of front document\nend tell\nreturn ""`, 1500);
    }
  } catch {
    /* Automation permission not granted yet, or no window */
  }
  return '';
}

// Apple Notes keeps its window title as "Notes" for every note; ask it for the selected note.
let notesScriptingWorks = true;
async function selectedNoteName(): Promise<string> {
  if (!notesScriptingWorks) return '';
  try {
    return await osa(`tell application "Notes"
  try
    set s to selection
    if (count of s) > 0 then return name of item 1 of s
  end try
end tell
return ""`, 1500);
  } catch (err: any) {
    // Automation not allowed for Notes, or this macOS has no Notes selection: stop asking.
    if (/-1743|not authori[sz]ed|-1728|can.t get selection/i.test(String(err?.message))) notesScriptingWorks = false;
    return '';
  }
}

export async function getFrontWindow(): Promise<FrontWindow> {
  const out = await osa(FRONT_SCRIPT);
  const [app = '', pid = '0', title = ''] = out.split(SEP);
  const url = await browserUrl(app);
  if (app === 'Notes') {
    const note = await selectedNoteName();
    if (note) return { app, pid: Number(pid), title: note, url };
  }
  return { app, pid: Number(pid), title, url };
}

// Bring a window back: the app by pid, and for browsers the exact tab by URL.
export async function activateWindow(w: { app: string; pid: number; url: string }): Promise<void> {
  if (w.url && CHROMIUM.includes(w.app)) {
    await osa(`
tell application ${q(w.app)}
  activate
  set targetUrl to ${q(w.url)}
  repeat with wi from 1 to (count of windows)
    set theWin to window wi
    repeat with ti from 1 to (count of tabs of theWin)
      if URL of tab ti of theWin is targetUrl then
        set active tab index of theWin to ti
        set index of theWin to 1
        return
      end if
    end repeat
  end repeat
  open location targetUrl
end tell`, 4000);
    return;
  }
  if (w.url && SAFARI.includes(w.app)) {
    await osa(`
tell application ${q(w.app)}
  activate
  set targetUrl to ${q(w.url)}
  repeat with theWin in windows
    repeat with theTab in tabs of theWin
      if URL of theTab is targetUrl then
        set current tab of theWin to theTab
        set index of theWin to 1
        return
      end if
    end repeat
  end repeat
  open location targetUrl
end tell`, 4000);
    return;
  }
  if (w.pid > 0) {
    await osa(`tell application "System Events" to set frontmost of (first process whose unix id is ${Math.floor(w.pid)}) to true`);
    return;
  }
  await osa(`tell application ${q(w.app)} to activate`);
}
