import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const external = ['@omp-desktop/plugin', '@omp-desktop/plugin/*', 'react', 'react/*', 'react-dom', 'react-dom/*', 'zod'];
const common = { absWorkingDir: root, bundle: true, format: 'esm', external, legalComments: 'none', logLevel: 'info' };
await Promise.all([
  build({ ...common, entryPoints: ['src/client.jsx'], outfile: 'dist/client.mjs', platform: 'browser', target: 'es2022', jsx: 'automatic' }),
  build({ ...common, entryPoints: ['src/service.mjs'], outfile: 'dist/service.mjs', platform: 'node', target: 'node22' })
]);
