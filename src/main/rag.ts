// Resource folder index for retrieval (RAG): scan → extract text → chunk → embed with
// Nemotron 3.5 Embed 8B → cosine search. Vectors stay on this Mac (cached per file so an
// unchanged file is never re-embedded).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { embed } from './llm.js';

const TEXT_EXT = new Set([
  '.md', '.markdown', '.txt', '.rst', '.tex', '.py', '.js', '.mjs', '.ts', '.tsx', '.jsx', '.java', '.c', '.h', '.cpp', '.hpp', '.cs',
  '.go', '.rs', '.rb', '.swift', '.kt', '.scala', '.r', '.m', '.sql', '.sh', '.json', '.yaml', '.yml', '.toml', '.csv', '.html', '.css', '.xml',
]);
const DOC_EXT = new Set(['.pdf', '.docx', '.ipynb']);
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next', 'target']);
const MAX_FILES = 150;
const MAX_TEXT_BYTES = 2_000_000;
const MAX_DOC_BYTES = 40_000_000;
const CHUNK_CHARS = 1500;
const CHUNK_OVERLAP = 200;
const MAX_CHUNKS_PER_FILE = 40;
const BATCH = 16;

export type Chunk = { file: string; name: string; text: string; vec: Float32Array };
export type DocResult = { path: string; name: string; chunks: number; status: 'indexed' | 'skipped' | 'error'; detail: string };
export type IndexStatus = { state: 'idle' | 'indexing' | 'ready' | 'error'; folder: string; files: number; done: number; chunks: number; error: string };
export type Hit = { path: string; name: string; score: number; snippet: string };

export class ResourceIndex {
  chunks: Chunk[] = [];
  status: IndexStatus = { state: 'idle', folder: '', files: 0, done: 0, chunks: 0, error: '' };
  private files = new Set<string>();

  constructor(private cacheDir: string, private onProgress: () => void = () => {}) {
    mkdirSync(cacheDir, { recursive: true });
  }

  has(path: string) {
    return this.files.has(path);
  }

  get ready() {
    return this.status.state === 'ready' && this.chunks.length > 0;
  }

  async indexFolder(folder: string): Promise<DocResult[]> {
    this.status = { state: 'indexing', folder, files: 0, done: 0, chunks: 0, error: '' };
    this.onProgress();
    try {
      const paths = await scan(folder);
      return await this.indexFiles(paths, folder);
    } catch (err: any) {
      this.status = { ...this.status, state: 'error', error: String(err?.message ?? err) };
      this.onProgress();
      return [];
    }
  }

  // Also used after a restart to rebuild from the files recorded for the session (cache makes it quick).
  async indexFiles(paths: string[], folder = ''): Promise<DocResult[]> {
    this.chunks = [];
    this.files = new Set(paths);
    this.status = { state: 'indexing', folder: folder || this.status.folder, files: paths.length, done: 0, chunks: 0, error: '' };
    this.onProgress();
    const results: DocResult[] = [];
    let firstError = '';
    for (const path of paths) {
      const name = basename(path);
      try {
        const st = await stat(path);
        const cacheKey = createHash('sha1').update(`${path}|${st.mtimeMs}|${st.size}`).digest('hex');
        const cacheFile = join(this.cacheDir, `${cacheKey}.json`);
        let entries: { text: string; vec: Float32Array }[] | null = loadCache(cacheFile);
        if (!entries) {
          const text = await extractText(path, st.size);
          if (!text || text.trim().length < 40) {
            results.push({ path, name, chunks: 0, status: 'skipped', detail: 'no readable text' });
            continue;
          }
          const pieces = chunk(text).slice(0, MAX_CHUNKS_PER_FILE).map((c) => `File: ${name}\n${c}`);
          entries = [];
          for (let i = 0; i < pieces.length; i += BATCH) {
            const batch = pieces.slice(i, i + BATCH);
            const vecs = await embed(batch, 'passage');
            batch.forEach((t, j) => entries!.push({ text: t, vec: vecs[j] }));
          }
          saveCache(cacheFile, entries);
        }
        for (const e of entries) this.chunks.push({ file: path, name, text: e.text, vec: e.vec });
        results.push({ path, name, chunks: entries.length, status: 'indexed', detail: '' });
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        firstError ||= msg;
        results.push({ path, name, chunks: 0, status: 'error', detail: msg.slice(0, 200) });
        if (/Embedding failed/.test(msg) && !this.chunks.length && results.length >= 2) break; // API down: stop early
      } finally {
        this.status.done++;
        this.status.chunks = this.chunks.length;
        this.onProgress();
      }
    }
    this.status.state = this.chunks.length ? 'ready' : 'error';
    this.status.error = this.chunks.length ? '' : firstError || 'no readable files in the folder';
    this.onProgress();
    return results;
  }

  async search(query: string, k = 12): Promise<Hit[]> {
    if (!this.chunks.length) return [];
    const [q] = await embed([query], 'query');
    const scored = this.chunks.map((c) => ({ c, score: dot(q, c.vec) }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k).map(({ c, score }) => ({ path: c.file, name: c.name, score, snippet: c.text.replace(/^File: [^\n]*\n/, '') }));
  }
}

async function scan(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > 4 || out.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(p, depth + 1);
      } else if (e.isFile()) {
        const ext = extname(e.name).toLowerCase();
        if (TEXT_EXT.has(ext) || DOC_EXT.has(ext)) out.push(p);
      }
    }
  };
  await walk(root, 0);
  return out;
}

async function extractText(path: string, size: number): Promise<string> {
  const ext = extname(path).toLowerCase();
  if (TEXT_EXT.has(ext)) {
    if (size > MAX_TEXT_BYTES) throw new Error('file too large');
    return readFile(path, 'utf8');
  }
  if (size > MAX_DOC_BYTES) throw new Error('file too large');
  const buf = await readFile(path);
  if (ext === '.pdf') {
    const { getDocumentProxy, extractText: pdfText } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await pdfText(pdf, { mergePages: true });
    return Array.isArray(text) ? text.join('\n') : text;
  }
  if (ext === '.docx') {
    const mammoth: any = await import('mammoth');
    const { value } = await (mammoth.default ?? mammoth).extractRawText({ buffer: buf });
    return value;
  }
  if (ext === '.ipynb') {
    const nb = JSON.parse(buf.toString('utf8'));
    return (nb.cells ?? []).map((c: any) => (Array.isArray(c.source) ? c.source.join('') : String(c.source ?? ''))).join('\n\n');
  }
  return '';
}

// Paragraph-aware chunks of ~CHUNK_CHARS with a little overlap so ideas aren't cut in half.
export function chunk(text: string): string[] {
  const clean = text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const paras = clean.split(/\n\n+/);
  const out: string[] = [];
  let cur = '';
  for (const p of paras) {
    if (p.length > CHUNK_CHARS) {
      if (cur) out.push(cur), (cur = '');
      for (let i = 0; i < p.length; i += CHUNK_CHARS - CHUNK_OVERLAP) out.push(p.slice(i, i + CHUNK_CHARS));
      continue;
    }
    if (cur.length + p.length + 2 > CHUNK_CHARS) {
      out.push(cur);
      cur = cur.slice(-CHUNK_OVERLAP) + '\n\n' + p;
    } else cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function dot(a: Float32Array, b: Float32Array) {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

// Vectors stored as base64 Float32 (about 4x smaller than JSON numbers).
function saveCache(file: string, entries: { text: string; vec: Float32Array }[]) {
  try {
    writeFileSync(file, JSON.stringify(entries.map((e) => ({ t: e.text, v: Buffer.from(e.vec.buffer, e.vec.byteOffset, e.vec.byteLength).toString('base64') }))));
  } catch {
    /* cache is optional */
  }
}
function loadCache(file: string): { text: string; vec: Float32Array }[] | null {
  if (!existsSync(file)) return null;
  try {
    const rows = JSON.parse(readFileSync(file, 'utf8')) as { t: string; v: string }[];
    return rows.map((r) => {
      const b = Buffer.from(r.v, 'base64');
      return { text: r.t, vec: new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) };
    });
  } catch {
    return null;
  }
}
