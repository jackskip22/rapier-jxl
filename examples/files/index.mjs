// SPDX-License-Identifier: MIT
// A picture file to JPEG XL bytes, cached by the source, the options (`read` by its code) and the package version: the one step the Vite,
// webpack, Next.js and Netlify examples share. A JPEG with no `read` is kept exactly (Node has
// no JPEG decoder of its own); a PNG, or any file `read` decodes, is encoded at `fidelity`, at `width` when given:
// `read` is handed the width and may return pixels already at it; wider pixels are resized by rapier-jxl.
import {createHash, randomBytes} from 'node:crypto';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {encode, variants} from 'jpegxl';
import {recompress} from 'jpegxl/jpeg';

export const IMAGE = /\.(jpe?g|png)$/i;
export const JPEG = /\.jpe?g$/i;
export const jxlName = name => name.replace(/\.[^./\\]+$/, '.jxl');
const require = createRequire(import.meta.url), version = require('jpegxl/package.json').version;

/** @param {import('./index.d.ts').JxlFilesOptions} [options] */
export function jxlFiles({fidelity, effort = 3, read, cacheDir} = {}) {
  const pending = new Map(); // cache key -> encode in flight
  const look = fidelity === undefined ? {} : {fidelity};
  async function encodeBytes(source, file, width) {
    if (JPEG.test(file) && !read) return recompress(source, {effort});
    const input = read ? await read(source, file, {width}) : new Blob([source]);
    if (!width || read && input.width <= width) return encode(input, {effort, ...look});
    const [result] = await variants(input, {outputs: [{width, effort, ...look}]});
    return result;
  }
  /** One file's JPEG XL bytes: `width` (pixels) shrinks it to that width (a JPEG without `read` is kept whole);
   * `bytes` are the file's when a bundler holds them already. */
  async function toJxl(file, {width, bytes} = {}) {
    const source = bytes ? new Uint8Array(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength) : new Uint8Array(await readFile(file));
    const key = createHash('sha256').update(JSON.stringify([version, fidelity, effort, read ? String(read) : 0, JPEG.test(file), width ?? 0])).update(source).digest('hex');
    const cached = cacheDir && join(cacheDir, key + '.jxl');
    if (cached) { try { return {key, bytes: new Uint8Array(await readFile(cached))}; } catch {} }
    if (!pending.has(key)) pending.set(key, (async () => {
      const result = await encodeBytes(source, file, width);
      if (cached) {
        await mkdir(cacheDir, {recursive: true});
        const tmp = `${cached}.${randomBytes(6).toString('hex')}.tmp`;
        try { await writeFile(tmp, result.bytes, {flag: 'wx'}); await rename(tmp, cached); }
        catch (error) { await rm(tmp, {force: true}).catch(() => {}); throw error; }
      }
      return {key, bytes: result.bytes, result};
    })().finally(() => pending.delete(key)));
    return pending.get(key);
  }
  return {toJxl};
}
