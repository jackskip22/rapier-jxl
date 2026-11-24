// SPDX-License-Identifier: MIT
import {readFile, stat, rm, rmdir, chmod} from 'node:fs/promises';
import {dirname, join, sep} from 'node:path';
import {createHash} from 'node:crypto';
import {insideProject, atomicWrite, readIfAny, refuseReadOnly, refuseLinks} from './project-files.mjs';
import {cliError, cliArgs} from './cli-error.mjs';
import {COMMAND} from './package-name.mjs';
import {PACKAGE_FILES} from './package-manager.mjs';

const recordName = place => place === 'emdash' ? '.rapier-jxl-emdash.json' : place === 'wordpress' ? 'wp-content/plugins/jpegxl/.rapier-jxl-wordpress.json' : '.rapier-jxl-add.json';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const setup = message => cliError('JXL_SETUP', message, 'restore the files recorded by add, then try again');
const read = (path, name) => readIfAny(path, undefined, name);
const digest = bytes => bytes === null ? null : sha(bytes);
const asLeft = (bytes, after) => digest(bytes) === after || bytes !== null && sha(Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')) === after;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const EXTENSIONS = ['js', 'mjs', 'cjs', 'ts', 'mts', 'cts'];
const config = (name, extensions) => extensions.map(ext => name + '.config.' + ext);
const core = ['rapier-jxl-files.mjs'];
const vite = [...core, 'package.json', 'rapier-jxl-vite.mjs', 'rapier-jxl-vite.d.mts', 'rapier-jxl-images.d.ts', 'src/rapier-jxl-images.d.ts'];
const ALLOWED = {
  vite: [...vite, ...config('vite', EXTENSIONS)],
  sveltekit: [...vite, ...config('vite', EXTENSIONS)],
  nuxt: [...vite, ...config('nuxt', EXTENSIONS)],
  webpack: [...core, 'package.json', 'rapier-jxl-webpack.mjs', 'rapier-jxl-webpack.d.mts', ...['webpack', 'rspack'].flatMap(n => config(n, EXTENSIONS))],
  next: [...core, 'rapier-jxl-accept.mjs', 'rapier-jxl-next.mjs', 'rapier-jxl-next-proxy.mjs', 'rapier-jxl-next-loader.mjs', 'package.json', '.gitignore',
    ...['', 'src/'].flatMap(dir => ['proxy', 'middleware'].flatMap(n => ['js', 'mjs', 'ts'].map(ext => dir + n + '.' + ext)))],
  netlify: ['netlify.toml', 'package.json', ...['index.mjs', 'edge.mjs', 'manifest.yml', 'package.json', 'rapier-jxl-files.mjs', 'rapier-jxl-accept.mjs'].map(n => 'netlify/plugins/rapier-jxl/' + n)],
  astro: [...config('astro', ['mjs', 'js', 'ts', 'mts', 'cjs', 'cts']), 'src/jxl/service.mjs', 'src/jxl/service-workers.mjs', 'src/jxl/index.mjs', 'src/jxl/options.mjs',
    'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock'],
  payload: [...['', 'src/'].flatMap(d => config(d + 'payload', EXTENSIONS)),
    ...['jxl/', 'src/jxl/'].flatMap(d => ['index.mjs', 'index.d.mts', 'picture.mjs', 'picture.d.mts', 'accept.mjs'].map(f => d + f)), ...PACKAGE_FILES],
  void: ['package.json', 'routes/api/images/_jxl.mjs', 'routes/api/images/index.mjs', 'routes/api/images/[id].mjs', 'src/jxl-upload.mjs'],
  workers: ['jxl-worker.mjs', 'jxl-space-saver.mjs', 'wrangler.json', 'wrangler.jsonc', 'wrangler.toml', 'package.json'],
  emdash: ['astro.config.mjs', 'wrangler.json', 'wrangler.jsonc', ...PACKAGE_FILES],
};
function placeFiles(place, packaged) {
  if (place !== 'wordpress') return ALLOWED[place] ?? [];
  if (!Array.isArray(packaged) || !packaged.length || packaged.some(file => typeof file !== 'string'
    || /[\\\x00-\x1f\x7f]/.test(file) || file === recordName(place)
    || file.split('/').some(part => !part || part === '.' || part === '..')))
    throw setup('The WordPress package does not describe safe plugin files');
  return [...packaged];
}
const allowed = (files, file) => files.includes(file);
const allowedDir = (files, dir) => typeof dir === 'string' && files.some(file => file.startsWith(dir + '/'));

async function record(cwd, place, packaged) {
  const admitted = placeFiles(place, packaged);
  await refuseLinks(cwd, [recordName(place)], setup);
  const [path] = await insideProject(cwd, [recordName(place)], setup), bytes = await read(path);
  if (bytes === null) return null;
  let value;
  try { value = JSON.parse(bytes); } catch { throw setup('The add record is not JSON'); }
  if (!object(value) || value.place !== place || value.schema !== 1 || !object(value.files) || !Array.isArray(value.dirs)
    || !value.dirs.every(dir => allowedDir(admitted, dir))) throw setup('The add record does not describe this place');
  for (const [file, entry] of Object.entries(value.files)) {
    if (!allowed(admitted, file) || !object(entry) || !(entry.before === null || typeof entry.before === 'string'
      && Buffer.from(entry.before, 'base64').toString('base64') === entry.before)
      || !(entry.after === null || typeof entry.after === 'string' && /^[a-f0-9]{64}$/.test(entry.after))
      || !(entry.mode === null || Number.isInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o777))
      throw setup('The add record names an invalid file');
  }
  if (value.pending) throw setup('An earlier add did not finish installing its dependencies');
  await refuseLinks(cwd, [...Object.keys(value.files), ...value.dirs], setup);
  await insideProject(cwd, [...Object.keys(value.files), ...value.dirs], setup);
  return value;
}

export async function projectEditFiles(cwd, place, {allowedFiles} = {}) {
  const saved = await record(cwd, place, allowedFiles);
  return saved ? Object.keys(saved.files) : null;
}

export async function writeProjectEdits(cwd, place, version, writes, {dryRun = false, install, beforeWrite, allowedFiles} = {}) {
  const admitted = placeFiles(place, allowedFiles), before = await record(cwd, place, admitted);
  const paths = [...new Set([...writes.keys(), ...(install?.files ?? [])])];
  if (paths.some(file => !allowed(admitted, file))) throw setup('The setup names a file outside its place');
  await refuseLinks(cwd, [recordName(place), ...paths], setup);
  const lands = await insideProject(cwd, [recordName(place), ...paths], setup);
  await refuseReadOnly(lands[0], recordName(place));
  const current = new Map(), files = {...before?.files}, dirs = new Set(before?.dirs ?? []);
  for (const [i, file] of paths.entries()) {
    const bytes = await read(lands[i + 1], file); current.set(file, bytes);
    if (writes.has(file)) await refuseReadOnly(lands[i + 1], file);
    if (files[file] && !asLeft(bytes, files[file].after)) throw setup(`${file} changed after add wrote it`);
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
  await refuseLinks(cwd, [...writes.keys()], setup);
  const checked = await insideProject(cwd, [...writes.keys()], setup);
  for (const file of writes.keys()) if (digest(await read(join(cwd, file))) !== digest(current.get(file)))
    throw setup(`${file} changed while add ran`);
  for (const [i, [file, bytes]] of [...writes].entries()) {
    await refuseReadOnly(checked[i], file);
    await atomicWrite(checked[i], bytes);
    if (files[file].mode !== null) await chmod(checked[i], files[file].mode);
  }
}

export async function removeProjectEdits(place, args, {cwd, stdout, allowedFiles}) {
  args = cliArgs(args);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { stdout(`Usage: ${COMMAND} remove ${place} [--dry-run] [--json]`); return; }
  if (args.some(arg => !['--dry-run', '--json'].includes(arg))) throw cliError('JXL_OPTIONS', 'Unknown remove option', `run npx ${COMMAND} remove ${place} --help`);
  const dryRun = args.includes('--dry-run'), saved = await record(cwd, place, allowedFiles);
  if (!saved) throw setup(`There is no add record for ${place}`);
  const paths = Object.keys(saved.files), lands = await insideProject(cwd, [...paths, recordName(place), ...saved.dirs], setup), changes = [];
  for (const [i, file] of paths.entries()) {
    const entry = saved.files[file], bytes = await read(lands[i]), original = entry.before === null ? null : Buffer.from(entry.before, 'base64');
    if (digest(bytes) === digest(original)) {
      if (bytes !== null && entry.mode !== null && ((await stat(lands[i])).mode & 0o777) !== entry.mode) {
        await refuseReadOnly(lands[i], file);
        changes.push({file, action: 'restored', original, index: i, modeOnly: true});
      }
      continue;
    }
    if (!asLeft(bytes, entry.after)) throw setup(`${file} changed after add wrote it; no files were removed`);
    await refuseReadOnly(lands[i], file);
    changes.push({file, action: original === null ? 'removed' : 'restored', original, index: i});
  }
  if (!dryRun) {
    for (const change of changes) {
      const path = lands[change.index], entry = saved.files[change.file];
      if (change.original === null) await rm(path); else { if (!change.modeOnly) await atomicWrite(path, change.original); if (entry.mode !== null) await chmod(path, entry.mode); }
    }
    await rm(lands[paths.length]);
    for (const dir of [...saved.dirs].sort((a, b) => b.length - a.length)) await rmdir(join(cwd, dir)).catch(error => {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
    });
  }
  const result = changes.map(({file, action}) => ({file, action}));
  if (args.includes('--json')) stdout(JSON.stringify({type: 'remove', host: place, dryRun, changes: result}));
  else for (const {file, action} of result) stdout(`${file}: ${dryRun ? 'would be ' : ''}${action}`);
}
