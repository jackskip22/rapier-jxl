import {createHash, randomUUID} from 'node:crypto';
import {join, resolve} from 'node:path';
import {mkdir, readFile, readdir, rename, stat, unlink, utimes, writeFile} from 'node:fs/promises';

// Rebuilds are a cache, never the durable original. A missing/evicted entry is regenerated
// from its verified reversible JPEG XL. The cache is outside the public upload namespace.
export function originalFileCache(directory, {maxBytes = 32 * 1024 * 1024, maxFiles = 16} = {}) {
  const root = resolve(directory) + '.rapier-original-cache';
  const path = key => join(root, createHash('sha256').update(key).digest('hex') + '.jpeg');
  async function trim() {
    const files = [];
    for (const name of await readdir(root)) {
      if (!/^[a-f0-9]{64}\.jpeg$/.test(name)) continue;
      const filename = join(root, name), info = await stat(filename).catch(() => null);
      if (info?.isFile()) files.push({filename, size: info.size, time: info.mtimeMs});
    }
    files.sort((a, b) => b.time - a.time || a.filename.localeCompare(b.filename));
    let bytes = 0;
    for (let i = 0; i < files.length; i++) {
      bytes += files[i].size;
      if (i >= maxFiles || bytes > maxBytes) await unlink(files[i].filename).catch(() => {});
    }
  }
  return {
    async get(key, {signal} = {}) {
      signal?.throwIfAborted();
      try {
        const filename = path(key), info = await stat(filename);
        if (!info.isFile() || info.size > maxBytes) return null;
        const bytes = await readFile(filename), now = new Date();
        await utimes(filename, now, now).catch(() => {});
        return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      } catch { signal?.throwIfAborted(); return null; }
    },
    async put(key, bytes, {signal} = {}) {
      signal?.throwIfAborted();
      if (bytes.length > maxBytes || maxFiles < 1) return false;
      const filename = path(key), temporary = filename + '.' + randomUUID() + '.tmp';
      try {
        await mkdir(root, {recursive: true, mode: 0o700});
        await writeFile(temporary, bytes, {flag: 'wx', mode: 0o600});
        await rename(temporary, filename);
        await trim();
        return true;
      } catch { signal?.throwIfAborted(); return false; }
      finally { await unlink(temporary).catch(() => {}); }
    }
  };
}
