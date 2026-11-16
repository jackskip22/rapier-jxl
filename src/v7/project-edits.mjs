// SPDX-License-Identifier: MIT
import {readFile, stat, rm, rmdir, chmod} from 'node:fs/promises';
import {dirname, join, sep} from 'node:path';
import {createHash} from 'node:crypto';
import {insideProject, atomicWrite} from './project-files.mjs';
import {cliError, cliArgs} from './cli-error.mjs';
import {COMMAND} from './package-name.mjs';
import {PACKAGE_FILES} from './package-manager.mjs';

const recordName = place => place === 'emdash' ? '.rapier-jxl-emdash.json' : '.rapier-jxl-add.json';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const setup = message => cliError('JXL_SETUP', message, 'restore the files recorded by add, then try again');
const read = path => readFile(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const digest = bytes => bytes === null ? null : sha(bytes);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const config = (name, extensions) => extensions.map(ext => name + '.config.' + ext);
const core = ['rapier-jxl-files.mjs'];
const vite = [...core, 'rapier-jxl-vite.mjs', 'rapier-jxl-vite.d.mts', 'rapier-jxl-images.d.ts', 'src/rapier-jxl-images.d.ts'];
const ALLOWED = {
  vite: [...vite, ...config('vite', ['ts', 'mts', 'js', 'mjs'])],
  sveltekit: [...vite, ...config('vite', ['ts', 'mts', 'js', 'mjs'])],
  nuxt: [...vite, ...config('nuxt', ['ts', 'mts', 'js', 'mjs'])],
  webpack: [...core, 'rapier-jxl-webpack.mjs', 'rapier-jxl-webpack.d.mts', ...['webpack', 'rspack'].flatMap(n => config(n, ['js', 'mjs', 'cjs', 'ts']))],
  next: [...core, 'rapier-jxl-next.mjs', 'rapier-jxl-next-proxy.mjs', 'rapier-jxl-next-loader.mjs', 'package.json', '.gitignore',
    ...['', 'src/'].flatMap(dir => ['proxy', 'middleware'].flatMap(n => ['js', 'mjs', 'ts'].map(ext => dir + n + '.' + ext)))],
  netlify: ['netlify.toml', ...['index.mjs', 'edge.mjs', 'manifest.yml', 'package.json', 'rapier-jxl-files.mjs'].map(n => 'netlify/plugins/rapier-jxl/' + n)],
  astro: [...config('astro', ['mjs', 'js', 'ts', 'mts', 'cjs', 'cts']), 'src/jxl/service.mjs', 'src/jxl/service-workers.mjs', 'src/jxl/index.mjs', 'src/jxl/options.mjs',
    'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock'],
  workers: ['jxl-worker.mjs', 'wrangler.json', 'wrangler.jsonc', 'wrangler.toml', 'package.json'],
  emdash: ['astro.config.mjs', 'wrangler.json', 'wrangler.jsonc', ...PACKAGE_FILES],
};
const allowed = (place, file) => Object.hasOwn(ALLOWED, place) && ALLOWED[place].includes(file);
const allowedDir = (place, dir) => typeof dir === 'string' && ALLOWED[place]?.some(file => file.startsWith(dir + '/'));

async function record(cwd, place) {
  const [path] = await insideProject(cwd, [recordName(place)], setup), bytes = await read(path);
  if (bytes === null) return null;
  let value;
  try { value = JSON.parse(bytes); } catch { throw setup('The add record is not JSON'); }
  if (!object(value) || value.place !== place || value.schema !== 1 || !object(value.files) || !Array.isArray(value.dirs)
    || !value.dirs.every(dir => allowedDir(place, dir))) throw setup('The add record does not describe this place');
  for (const [file, entry] of Object.entries(value.files)) {
    if (!allowed(place, file) || !object(entry) || !(entry.before === null || typeof entry.before === 'string'
      && Buffer.from(entry.before, 'base64').toString('base64') === entry.before)
      || !(entry.after === null || typeof entry.after === 'string' && /^[a-f0-9]{64}$/.test(entry.after))
      || !(entry.mode === null || Number.isInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o777))
      throw setup('The add record names an invalid file');
  }
  if (value.pending) throw setup('An earlier add did not finish installing its dependencies');
  await insideProject(cwd, [...Object.keys(value.files), ...value.dirs], setup);
  return value;
}

export async function projectEditFiles(cwd, place) {
  const saved = await record(cwd, place);
  return saved ? Object.keys(saved.files) : null;
}

export async function writeProjectEdits(cwd, place, version, writes, {dryRun = false, install, beforeWrite} = {}) {
  const before = await record(cwd, place);
  const paths = [...new Set([...writes.keys(), ...(install?.files ?? [])])];
  if (paths.some(file => !allowed(place, file))) throw setup('The setup names a file outside its place');
  const lands = await insideProject(cwd, [recordName(place), ...paths], setup);
  const current = new Map(), files = {...before?.files}, dirs = new Set(before?.dirs ?? []);
  for (const [i, file] of paths.entries()) {
    const bytes = await read(lands[i + 1]); current.set(file, bytes);
    if (files[file] && digest(bytes) !== files[file].after) throw setup(`${file} changed after add wrote it`);
    files[file] = {before: files[file] ? files[file].before : (bytes === null ? null : bytes.toString('base64')),
      mode: files[file] ? files[file].mode : (bytes === null ? null : (await stat(lands[i + 1])).mode & 0o777),
      after: writes.has(file) ? sha(writes.get(file)) : digest(bytes)};
    for (let dir = dirname(file); dir !== '.'; dir = dirname(dir)) {
      try { await stat(join(cwd, dir)); } catch (error) { if (error.code === 'ENOENT') dirs.add(dir.split(sep).join('/')); else throw error; }
    }
  }
  if (dryRun) return;
  if (!paths.length) { await beforeWrite?.(); return; }
  const saved = {schema: 1, place, version, files, dirs: [...dirs]};
  const save = pending => atomicWrite(lands[0], JSON.stringify({...saved, ...pending && {pending: true}}, null, 2) + '\n');
  await save(Boolean(install));
  if (install) {
    await install.run();
    await insideProject(cwd, [recordName(place), ...paths], setup);
    for (const file of install.files) files[file].after = digest(await read(join(cwd, file)));
    await save(false);
  }
  await beforeWrite?.();
  const checked = await insideProject(cwd, [...writes.keys()], setup);
  for (const file of writes.keys()) if (digest(await read(join(cwd, file))) !== digest(current.get(file)))
    throw setup(`${file} changed while add ran`);
  for (const [i, [file, bytes]] of [...writes].entries()) {
    await atomicWrite(checked[i], bytes);
    if (files[file].mode !== null) await chmod(checked[i], files[file].mode);
  }
}

export async function removeProjectEdits(place, args, {cwd, stdout}) {
  args = cliArgs(args);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { stdout(`Usage: ${COMMAND} remove ${place} [--dry-run] [--json]`); return; }
  if (args.some(arg => !['--dry-run', '--json'].includes(arg))) throw cliError('JXL_OPTIONS', 'Unknown remove option', `run npx ${COMMAND} remove ${place} --help`);
  const dryRun = args.includes('--dry-run'), saved = await record(cwd, place);
  if (!saved) throw setup(`There is no add record for ${place}`);
  const paths = Object.keys(saved.files), lands = await insideProject(cwd, [...paths, recordName(place), ...saved.dirs], setup), changes = [];
  for (const [i, file] of paths.entries()) {
    const entry = saved.files[file], bytes = await read(lands[i]), original = entry.before === null ? null : Buffer.from(entry.before, 'base64');
    if (digest(bytes) === digest(original)) continue;
    if (digest(bytes) !== entry.after) throw setup(`${file} changed after add wrote it; no files were removed`);
    changes.push({file, action: original === null ? 'removed' : 'restored', original, index: i});
  }
  if (!dryRun) {
    for (const change of changes) {
      const path = lands[change.index], entry = saved.files[change.file];
      if (change.original === null) await rm(path); else { await atomicWrite(path, change.original); if (entry.mode !== null) await chmod(path, entry.mode); }
    }
    for (const dir of [...saved.dirs].sort((a, b) => b.length - a.length)) await rmdir(join(cwd, dir)).catch(error => {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
    });
    await rm(lands[paths.length]);
  }
  const result = changes.map(({file, action}) => ({file, action}));
  if (args.includes('--json')) stdout(JSON.stringify({type: 'remove', host: place, dryRun, changes: result}));
  else for (const {file, action} of result) stdout(`${file}: ${dryRun ? 'would be ' : ''}${action}`);
}
