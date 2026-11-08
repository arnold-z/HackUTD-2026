// Bundles the Electron main process (and the smoke test) into dist/.
// node_modules stay external; Electron loads them at runtime.
import { build } from 'esbuild';

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
};

await build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main.js' });
await build({ ...common, entryPoints: ['src/smoke.ts'], outfile: 'dist/smoke.js' });
