// Loads .env from the project root (no dependency) and exposes typed settings.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv() {
  const file = join(ROOT, '.env');
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnv();

const env = (k: string, d = '') => process.env[k] ?? d;

export const config = {
  llmBaseUrl: env('LLM_BASE_URL', 'https://integrate.api.nvidia.com/v1').replace(/\/$/, ''),
  llmModel: env('LLM_MODEL', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning'),
  llmApiKey: env('LLM_API_KEY'),
  spectrumProjectId: env('SPECTRUM_PROJECT_ID'),
  spectrumProjectSecret: env('SPECTRUM_PROJECT_SECRET'),
  userPhone: env('USER_PHONE'),
  stdbUri: env('STDB_URI', 'ws://127.0.0.1:3000'),
  stdbDatabase: env('STDB_DATABASE', 'focusguard'),
  pollMs: Number(env('POLL_MS', '1000')),
  // Set FOCUSGUARD_DRY_RUN_SMS=1 to log alerts instead of texting (useful while testing).
  dryRunSms: env('FOCUSGUARD_DRY_RUN_SMS') === '1',
};
