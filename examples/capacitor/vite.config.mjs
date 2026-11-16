import {existsSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vite';
import {MODULES, copyModules} from './prepare-assets.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(process.env.JXL_PACKAGE || resolve(here, '../..'));
for (const name of MODULES) {
  const file = resolve(pkg, 'dist', name);
  if (!existsSync(file)) throw Object.assign(new Error(`Set JXL_PACKAGE to the built package containing ${file}.`), {code: 'JXL_PACKAGE'});
}

// Keep each single-file module intact: bundling both its URL and worker would store it twice.
export default defineConfig({root: here, base: './', build: {
  outDir: 'dist', target: 'esnext', modulePreload: {polyfill: false}, license: {fileName: 'LICENSES.txt'},
  rolldownOptions: {external: ['jpegxl/upload', 'jpegxl/jpeg']}
}, plugins: [{name: 'local-encoder', async writeBundle() { await copyModules({packageDir: pkg, to: resolve(here, 'dist/jpegxl')}); }}]});
