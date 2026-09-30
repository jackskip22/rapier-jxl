// SPDX-License-Identifier: MIT
// Measure pinned published bytes; never install or execute a downloaded package.
// npm install --no-save terser@5.51.2
// node public/measure-encoders.mjs [cache-directory] [output.json]
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gzipSync, gunzipSync} from 'node:zlib';
import {createRequire} from 'node:module';
import {resolve, join, dirname} from 'node:path';
const require = createRequire(import.meta.url);
const {minify} = require(process.env.RAPIER_TERSER || 'terser');
const manifest = JSON.parse(await readFile(new URL('./encoders.json', import.meta.url), 'utf8'));
const terserVersion = require(process.env.RAPIER_TERSER ? join(dirname(process.env.RAPIER_TERSER), 'package.json') : 'terser/package.json').version;
if (terserVersion !== manifest.terser) throw Error('Use terser@' + manifest.terser + ', received ' + terserVersion);
const cache = resolve(process.argv[2] || '.encoder-size-cache');
await mkdir(cache, {recursive: true});
const sha256 = b => createHash('sha256').update(b).digest('hex');
const gzip = b => gzipSync(b, {level: 9}).length;
function member(archive, name) {
  for (let at = 0; at + 512 <= archive.length;) {
    const header = archive.subarray(at, at + 512);
    const string = (from, length) => header.subarray(from, from + length).toString('utf8').replace(/\0.*$/, '');
    const path = [string(345, 155), string(0, 100)].filter(Boolean).join('/');
    const size = parseInt(string(124, 12).trim() || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0 || at + 512 + size > archive.length) throw Error('Invalid archive');
    if (path === 'package/' + name) return archive.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  throw Error('Archive does not contain ' + name);
}
const entries = [];
for (const entry of manifest.entries) {
  const filename = join(cache, entry.name.replaceAll('/', '-') + '-' + entry.version + '.tgz');
  let bytes = await readFile(filename).catch(() => null);
  if (!bytes) {
    const response = await fetch(entry.tarball);
    if (!response.ok) throw Error(entry.tarball + ': HTTP ' + response.status);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  const [algorithm, wanted] = entry.integrity.split('-');
  if (createHash(algorithm).update(bytes).digest('base64') !== wanted) throw Error('Package integrity mismatch: ' + entry.name);
  await writeFile(filename, bytes);
  const archive = gunzipSync(bytes), files = [];
  for (const path of entry.files) {
    const raw = member(archive, path);
    let min = raw;
    if (/\.[cm]?js$/.test(path)) {
      const result = await minify(raw.toString('utf8'), {module: /\bexport\s/.test(raw.toString('utf8')), compress: {passes: 2}, mangle: true, format: {comments: 'some'}});
      if (!result.code) throw Error('Empty JavaScript after minification: ' + path);
      min = Buffer.from(result.code + '\n');
    }
    files.push({path, bytes: raw.length, gzip: gzip(raw), minified: min.length, minifiedGzip: gzip(min), sha256: sha256(raw)});
  }
  const total = key => files.reduce((sum, f) => sum + f[key], 0);
  entries.push({...entry, files, total: {bytes: total('bytes'), gzip: total('gzip'), minified: total('minified'), minifiedGzip: total('minifiedGzip')}});
}
const receipt = {asOf: manifest.asOf, node: process.version, terser: manifest.terser, scope: manifest.scope,
  method: 'Sum of listed JavaScript and WASM resources. Terser compress passes=2, mangle=true, preserved license comments; WASM unchanged. gzip level9 per resource, summed, not npm archive size. No tree-shaking across resources, WASM optimization or invented rebuild. Factory-only entries omit optional convenience wrappers, workers, threaded variants and decoders; that favors competitors. Capability is documented upstream, not a conformance result from this size survey.', entries};
await writeFile(resolve(process.argv[3] || 'encoder-sizes.json'), JSON.stringify(receipt, null, 2) + '\n');
for (const r of entries) console.log(r.name + '@' + r.version + '\t' + r.total.minified + '\t' + r.total.minifiedGzip + '\t' + r.capability);
