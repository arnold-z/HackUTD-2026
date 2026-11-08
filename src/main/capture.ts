// Screen capture for content-aware judging. Needs macOS Screen Recording permission;
// without it macOS returns only the wallpaper, which the agent is told to treat as "no info".
import { desktopCapturer, screen, systemPreferences, type NativeImage } from 'electron';

export const screenAccess = () => (process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted');

const MAX_BYTES = 170_000; // NVIDIA's hosted API accepts inline images up to ~180 KB

function displayIdUnderCursor(): string {
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  return String(d.id);
}

async function grab(width: number, height: number): Promise<NativeImage | null> {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
  if (!sources.length) return null;
  const id = displayIdUnderCursor();
  const src = sources.find((s) => s.display_id === id) ?? sources[0];
  return src.thumbnail.isEmpty() ? null : src.thumbnail;
}

// JPEG data URL of the screen the user is looking at, sized for the model.
export async function captureScreenForModel(): Promise<string | null> {
  if (screenAccess() !== 'granted') return null; // would only show the wallpaper
  try {
    const img = await grab(1280, 800);
    if (!img) return null;
    for (const [w, q] of [[1280, 62], [1024, 55], [880, 50], [720, 45]] as const) {
      const jpg = img.resize({ width: w, quality: 'good' }).toJPEG(q);
      if (jpg.length <= MAX_BYTES) return `data:image/jpeg;base64,${jpg.toString('base64')}`;
    }
    return null;
  } catch (err: any) {
    console.error('[capture]', err?.message ?? err);
    return null;
  }
}

// Tiny grayscale fingerprint used to notice when the content inside a window changes
// (switching notes) without calling the model.
export async function screenFingerprint(): Promise<Uint8Array | null> {
  if (screenAccess() !== 'granted') return null;
  try {
    const img = await grab(320, 200);
    if (!img) return null;
    const small = img.resize({ width: 160, height: 100 }); // sharp enough that lines of text register
    const { width, height } = small.getSize();
    const bgra = small.toBitmap();
    const out = new Uint8Array(width * height);
    for (let i = 0; i < out.length; i++) out[i] = (bgra[i * 4] + bgra[i * 4 + 1] + bgra[i * 4 + 2]) / 3;
    return out;
  } catch {
    return null;
  }
}

// Share of pixels that changed noticeably (0..1). Opening another note rewrites the text area
// (many pixels); typing a few characters or a blinking cursor changes very few.
export function fingerprintDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return 1;
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 28) changed++;
  return changed / a.length;
}
