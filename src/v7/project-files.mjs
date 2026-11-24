// SPDX-License-Identifier: MIT
import {chmod, lstat, mkdir, readFile, readlink, realpath, rename, rm, stat, writeFile} from 'node:fs/promises';
import {cliError} from './cli-error.mjs';
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
    if (normCase(to) === normCase(root)) throw refuse(`${relative(cwd, resolve(cwd, path)) || path}: is the project folder, not a file`,
      'replace the link with a file');
    const rel = relative(root, to);
    if (process.platform === 'win32' && rel.split(/[\\/]/).some(seg => RESERVED_WIN.test(seg) || /[ .]$/.test(seg)))
      throw refuse(`${rel} uses a reserved Windows file name`, 'rename the file or folder');
    lands.push(to);
  }
  return lands;
}

export async function refuseLinks(cwd, paths, refuse) {
  const root = await realpath(cwd);
  for (const file of paths) {
    const path = resolve(root, file);
    if (!within(root, path)) throw refuse(`${file}: outside folder`, 'use a file inside the project');
    let at = root;
    for (const part of relative(root, path).split(sep)) {
      at = join(at, part);
      let info;
      try { info = await lstat(at); }
      catch (error) { if (error.code === 'ENOENT') break; throw error; }
      if (info.isSymbolicLink()) throw refuse(`${file}: symbolic link`, 'replace the link with a plain file or folder');
    }
  }
}

export async function readManifest(cwd, refuse) {
  const [manifestPath] = await insideProject(cwd, ['package.json'], refuse);
  const text = await readIfAny(manifestPath, 'utf8', 'package.json');
  if (text === null) return null;
  let manifest;
  try { manifest = JSON.parse(text.replace(/^\ufeff/, '')); }
  catch (error) { throw refuse(`package.json: invalid JSON (${error.message})`, 'fix package.json'); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
    throw refuse('package.json is not a JSON object', 'correct package.json');
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'scripts']) {
    if (manifest[key] === undefined) continue;
    if (!manifest[key] || typeof manifest[key] !== 'object' || Array.isArray(manifest[key]))
      throw refuse(`package.json: ${key} is not an object`, 'fix package.json');
    for (const [name, value] of Object.entries(manifest[key])) if (typeof value !== 'string')
      throw refuse(`package.json: ${key}.${name} is not a string`, 'fix package.json');
  }
  for (const key of ['name', 'version', 'type']) if (manifest[key] !== undefined && typeof manifest[key] !== 'string')
    throw refuse(`package.json: ${key} is not a string`, 'fix package.json');
  return {text, manifest};
}

export async function atomicWrite(path, data) {
  const mode = await stat(path).then(info => info.mode & 0o777, error => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  await mkdir(dirname(path), {recursive: true});
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  try { await writeFile(tmp, data, {flag: 'wx'}); if (mode !== null) await chmod(tmp, mode); await rename(tmp, path); }
  catch (error) { await rm(tmp, {force: true}).catch(() => {}); throw error; }
}

export const jsonc = text => JSON.parse(text.replace(/^\ufeff/, '').replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (all, string) => string ?? '')
  .replace(/("(?:[^"\\]|\\.)*")|,(\s*[}\]])/g, (all, string, end) => string ?? end));

export async function readIfAny(path, encoding, name = path) {
  try {
    const bytes = await readFile(path);
    if (encoding === undefined) return bytes;
    if (/^utf-?8$/i.test(encoding)) {
      try { return new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes); }
      catch { throw cliError('JXL_INPUT', `${name}: invalid UTF-8`, 'save the file as UTF-8 before running add'); }
    }
    return bytes.toString(encoding);
  }
  catch (error) {
    if (error?.code?.startsWith('JXL_')) throw error;
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw cliError('JXL_IO', `${name}: ${error?.code === 'EISDIR' ? 'a folder, not a file' : error?.code === 'EACCES' || error?.code === 'EPERM' ? 'no permission to read it' : 'could not be read'}`,
      'fix the file, then run add again');
  }
}
export async function refuseReadOnly(path, name = path) {
  let info;
  try { info = await stat(path); } catch (error) { if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return; throw error; }
  if ((info.mode & 0o222) === 0) throw cliError('JXL_IO', `${name}: read-only`, 'make it writable, or add the lines by hand');
}
