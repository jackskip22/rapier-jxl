// SPDX-License-Identifier: MIT
import {lstat, mkdir, readFile, readlink, realpath, rename, rm, writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';

const normCase = p => process.platform === 'win32' ? p.toLowerCase() : p;
const within = (root, path) => { const r = relative(normCase(root), normCase(path)); return r === '' || r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r); };
const RESERVED_WIN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

async function landing(path, links = 0) {
  if (links > 40) throw Object.assign(new Error('Symbolic link loop'), {code: 'ELOOP'});
  try { return await realpath(path); }
  catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
  if ((await lstat(path).catch(() => null))?.isSymbolicLink()) return landing(resolve(dirname(path), await readlink(path)), links + 1);
  const up = dirname(path);
  return up === path ? path : join(await landing(up, links), basename(path));
}

export async function insideProject(cwd, paths, refuse) {
  const root = await realpath(cwd), lands = [];
  for (const path of paths) {
    if (typeof path !== 'string' || path.includes('\0')) throw refuse('A project file path is invalid', 'use a plain relative path inside this folder');
    let to;
    try { to = await landing(resolve(cwd, path)); }
    catch (error) {
      if (error?.code === 'ELOOP') throw refuse(`${relative(cwd, resolve(cwd, path)) || path} has a symbolic link loop`, 'replace the link with a folder or file');
      throw error;
    }
    if (!within(root, to)) throw refuse(`${relative(cwd, resolve(cwd, path)) || path}: outside folder (${to})`,
      'replace symlink or run in target folder');
    const rel = relative(root, to);
    if (process.platform === 'win32' && rel.split(/[\\/]/).some(seg => RESERVED_WIN.test(seg) || /[ .]$/.test(seg)))
      throw refuse(`${rel} uses a reserved Windows file name`, 'rename the file or folder');
    lands.push(to);
  }
  return lands;
}

export async function readManifest(cwd, refuse) {
  const [manifestPath] = await insideProject(cwd, ['package.json'], refuse);
  const text = await readFile(manifestPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (text === null) return null;
  let manifest;
  try { manifest = JSON.parse(text); }
  catch (error) { throw refuse(`package.json: invalid JSON (${error.message})`, 'fix package.json'); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
    throw refuse('package.json is not a JSON object', 'correct package.json');
  return {text, manifest};
}

export async function atomicWrite(path, data) {
  await mkdir(dirname(path), {recursive: true});
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  try { await writeFile(tmp, data, {flag: 'wx'}); await rename(tmp, path); }
  catch (error) { await rm(tmp, {force: true}).catch(() => {}); throw error; }
}
