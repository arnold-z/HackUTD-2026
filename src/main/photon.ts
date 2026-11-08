// Photon Spectrum: sends iMessages to the user's phone (off-task alerts and the debrief).
// The SDK is loaded lazily so a Photon problem can never stop the app from starting.
import { config } from './config.js';

type App = any;
let appPromise: Promise<App> | undefined;
export let photonStatus: 'idle' | 'ready' | 'error' | 'dry-run' = config.dryRunSms ? 'dry-run' : 'idle';
export let photonError = '';

async function makeApp() {
  const { Spectrum } = await import('spectrum-ts');
  const { imessage } = await import('spectrum-ts/providers/imessage');
  return Spectrum({
    projectId: config.spectrumProjectId,
    projectSecret: config.spectrumProjectSecret,
    providers: [imessage.config()],
    options: { logLevel: 'warn' },
  });
}

// Start connecting early so the first alert isn't slowed by setup.
export function initPhoton(): Promise<App> | undefined {
  if (config.dryRunSms) return undefined;
  if (!config.spectrumProjectId || !config.spectrumProjectSecret) {
    photonStatus = 'error';
    photonError = 'SPECTRUM_PROJECT_ID / SPECTRUM_PROJECT_SECRET missing in .env';
    return undefined;
  }
  if (!appPromise) {
    appPromise = makeApp().then(
      (a) => {
        photonStatus = 'ready';
        return a;
      },
      (err) => {
        photonStatus = 'error';
        photonError = String(err?.message ?? err);
        appPromise = undefined; // allow a retry on the next send
        throw err;
      }
    );
  }
  return appPromise;
}

export async function sendText(phone: string, text: string): Promise<{ ok: boolean; detail: string }> {
  const to = phone || config.userPhone;
  if (!to) return { ok: false, detail: 'no phone number' };
  if (config.dryRunSms) {
    console.log(`[photon dry-run] to ${to}: ${text}`);
    return { ok: true, detail: 'dry run (ANCHOR_DRY_RUN_SMS=1)' };
  }
  try {
    const app = await initPhoton();
    if (!app) return { ok: false, detail: photonError || 'photon not configured' };
    const { imessage } = await import('spectrum-ts/providers/imessage');
    const space = await imessage(app).space.create(to);
    await space.send(text);
    photonStatus = 'ready';
    return { ok: true, detail: `sent to ${to}` };
  } catch (err: any) {
    photonError = String(err?.message ?? err);
    console.error('[photon] send failed:', photonError);
    return { ok: false, detail: photonError };
  }
}

export async function stopPhoton() {
  try {
    const app = await appPromise;
    await app?.stop();
  } catch {
    /* ignore */
  }
}
