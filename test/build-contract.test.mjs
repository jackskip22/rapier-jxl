// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, access} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';

let sizes;
try { sizes = JSON.parse(await readFile(new URL('../dist/sizes.json', import.meta.url))); } catch {}
test('every generated module retains its source exports and exact recorded payload', {skip: !sizes?.esbuild}, async () => {
  for (const row of sizes.doors) {
    const file = new URL('../' + row.file, import.meta.url), bytes = await readFile(file);
    assert.equal(bytes.length, row.alone.bytes, row.file);
    assert.equal(gzipSync(bytes, {level: 9}).length, row.alone.gzip, row.file);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), row.alone.sha256, row.file);
    if (!row.worker) {
      const source = await import(new URL('../' + row.source, import.meta.url));
      const bundled = await import(file);
      assert.deepEqual(Object.keys(bundled).sort(), Object.keys(source).sort(), row.file);
    }
  }
});
test('built capture/core/photo match source for exact, lossy, alpha and offset inputs', {skip: !sizes?.esbuild}, async () => {
  const paths = [['capture', 'capture'], ['index', 'core'], ['photo-entry', 'photo']];
  const width = 33, height = 17, data = new Uint8Array(width * height * 4 + 4).subarray(4);
  for (let i = 0; i < data.length; i++) data[i] = i % 4 === 3 ? ((i >> 2) % 5 ? 255 : 0) : (i * 73) & 255;
  for (const [sourceName, buildName] of paths) {
    const source = await import(`../src/${sourceName}.mjs`), built = await import(`../dist/${buildName}.min.mjs`);
    for (const quality of [90, 100]) {
      const options = sourceName === 'capture' ? {maxError: quality === 100 ? 0 : 2, gpu: 'cpu'} : {quality, effort: 7};
      const args = sourceName === 'index' ? [data, width, height, options] : [{data, width, height}, {...options, ...(sourceName === 'photo-entry' ? {gpu: 'cpu'} : {})}];
      assert.deepEqual(await built.encode(...args), await source.encode(...args), `${buildName} ${quality}`);
    }
  }
});
test('all package runtime and declaration exports resolve after building', {skip: !sizes?.esbuild}, async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  for (const [name, target] of Object.entries(pkg.exports)) {
    for (const path of typeof target === 'string' ? [target] : Object.values(target)) {
      await assert.doesNotReject(access(new URL('../' + path, import.meta.url)), `${name}: ${path}`);
    }
  }
});
