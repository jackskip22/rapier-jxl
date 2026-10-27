// SPDX-License-Identifier: MIT
import {build, version as esbuildVersion} from 'esbuild';
import {minify} from 'terser';
import {readFile, writeFile, mkdir, readdir, unlink} from 'node:fs/promises';
import {gzipSync, brotliCompressSync, constants} from 'node:zlib';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const license = await readFile('LICENSE', 'utf8'), metricLicense = await readFile('LICENSE.libjxl', 'utf8');
const builds = new Map();
const names = {'index': 'core', 'photo-entry': 'photo', 'photo-noise': 'noise', 'container-stream': 'container'};
for (const [entry, value] of Object.entries(pkg.exports)) {
  if (!value?.default?.startsWith('./src/')) continue;
  const source = value.default.slice(2), stem = source.slice(4, -4), file = `dist/${names[stem] ?? stem}.min.mjs`;
  if (!builds.has(file)) builds.set(file, {source, entry, aliases: [], file, worker: false});
  builds.get(file).aliases.push(entry);
}
for (const name of ['capture', 'photo', 'full']) builds.set(`dist/${name}-worker.js`, {
  source: `src/${name}-worker.mjs`, entry: `./${name}/worker`, aliases: [`./${name}/worker`], file: `dist/${name}-worker.js`, worker: true,
});
await mkdir('dist', {recursive: true});
// Generated output is exactly the current entry set: no old workers or hidden GPU chunks.
const wanted = new Set([...builds.keys()].map(path => path.slice(5)).concat('sizes.json'));
for (const file of await readdir('dist')) if (!wanted.has(file)) await unlink(`dist/${file}`);
const doors = [];
const priority = file => ['dist/capture.min.mjs', 'dist/image.min.mjs', 'dist/capture-worker.js'].indexOf(file);
const ordered = [...builds.values()].sort((a, b) => (priority(a.file) < 0 ? 9 : priority(a.file)) - (priority(b.file) < 0 ? 9 : priority(b.file)));
for (const config of ordered) {
  const bundled = await build({entryPoints: [config.source], bundle: true, format: config.worker ? 'iife' : 'esm',
    platform: 'browser', external: ['node:*'], target: 'es2022', treeShaking: true, splitting: false, write: false, metafile: true, legalComments: 'none', logLevel: 'silent'});
  const notices = license + (Object.keys(bundled.metafile.inputs).includes('src/ssimulacra2.mjs') ? '\n' + metricLicense : '');
  const small = await minify(bundled.outputFiles[0].text, {module: !config.worker, compress: {passes: 2}, mangle: true,
    format: {preamble: '/*!\n' + notices + '\n*/', comments: false}});
  if (!small.code) throw new Error(`Empty build: ${config.file}`);
  if (Object.values(bundled.metafile.outputs).some(output => output.imports.some(item => item.external && !item.path.startsWith('node:')))) throw new Error(`External runtime dependency in ${config.file}`);
  const bytes = Buffer.from(small.code + '\n');
  await writeFile(config.file, bytes);
  doors.push({...config, exports: Object.values(bundled.metafile.outputs).flatMap(output => output.exports),
    modules: Object.keys(bundled.metafile.inputs), alone: {bytes: bytes.length, gzip: gzipSync(bytes, {level: 9}).length,
      brotli: brotliCompressSync(bytes, {params: {[constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT}}).length,
      sha256: createHash('sha256').update(bytes).digest('hex')}});
}
await writeFile('dist/sizes.json', JSON.stringify({package: pkg.name, version: pkg.version, node: process.version,
  esbuild: esbuildVersion, terser: pkg.devDependencies.terser,
  measured: 'Self-contained eager bundles; gzip level 9; Brotli quality 11 text. GPU code is included, with no secondary request. No property-name mangling.', doors}, null, 2) + '\n');
// An incompatible public integration cannot produce a successful build.
execFileSync(process.execPath, ['--test', 'test/integrator-contract.test.mjs', 'test/build-contract.test.mjs'], {stdio: 'inherit'});
execFileSync(process.execPath, ['node_modules/typescript/lib/tsc.js', '--noEmit', '--strict', '--module', 'nodenext', '--target', 'es2022', '--lib', 'es2022,dom', 'test/contract-types.mts'], {stdio: 'inherit'});
console.table(doors.map(({entry, alone}) => ({entry, bytes: alone.bytes, gzip: alone.gzip})));
