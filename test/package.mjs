// SPDX-License-Identifier: MIT
// Run against a staged repository: the actual npm tarball must carry usable entry points, declarations and references.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, rename, rm, copyFile, access} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {Worker} from 'node:worker_threads';
import {pixelCase} from './fuzz-cases.mjs';
import {integerFixture, png16Fixture, floatFixture} from './high-depth-fixtures.mjs';

const stage = resolve(process.argv[2] || '.');
const scratch = await mkdtemp(join(tmpdir(), 'rapier-jxl-package-'));
after(() => rm(scratch, {recursive: true, force: true}));
const [packed] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], {cwd: stage, encoding: 'utf8'}));
const modules = join(scratch, 'node_modules');
await mkdir(modules);
execFileSync('tar', ['-xzf', join(scratch, packed.filename), '-C', modules]);
const root = join(modules, 'rapier-jxl');
await rename(join(modules, 'package'), root);
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const require = createRequire(pathToFileURL(join(scratch, 'consumer.mjs')));
const entry = name => import(pathToFileURL(require.resolve('rapier-jxl' + name)).href);

test('the npm tarball includes references and a declaration for every executable entry', async () => {
  for (const file of ['llms.txt', 'skills/README.md', 'skills/rapier-jxl-single-file-app/SKILL.md', 'skills/rapier-jxl-photography/SKILL.md', 'docs/reference/API.md', 'docs/reference/ARCHITECTURE.md', 'docs/reference/DECODERS.md', 'docs/ENCODER-COMPARISON.md', 'bench/encoder-sizes.json', '.github/CONTRIBUTING.md']) await access(join(root, file));
  for (const [name, value] of Object.entries(manifest.exports)) {
    if (name === './package.json') continue;
    assert.equal(typeof value.types, 'string', name + ' has no declaration');
    await access(join(root, value.types));
    await entry(name === '.' ? '' : name.slice(1));
  }
  assert.equal(Object.keys(manifest.dependencies || {}).length, 0);
});

test('each named single-file entry loads alone and writes the readable entry bytes', async () => {
  const pixels = pixelCase(0x12345678, 3);
  const jpeg = new Uint8Array(await readFile(new URL('seeds/colour-sequential.jpg', import.meta.url)));
  const names = ['core', 'effort', 'wasm', 'jpeg', 'photo', 'jpeg-ans', 'photo-ans'];
  for (const name of names) {
    const readable = await entry('/' + name);
    const file = require.resolve('rapier-jxl/' + name + '/min');
    const source = await readFile(file);
    // A data URL has no neighbouring modules; the copied entry must be complete, including optional WASM bytes.
    const standalone = await import('data:text/javascript;base64,' + source.toString('base64'));
    const invoke = api => name.startsWith('jpeg') ? api.transcode(jpeg, {effort: 4}).bytes
      : name.startsWith('photo') ? api.encodePhoto(pixels.rgba, pixels.width, pixels.height, {quality: 90, effort: 4})
      : api.encode(pixels.rgba, pixels.width, pixels.height, {quality: 100, colorSpace: 'display-p3', ...(name === 'core' ? {} : {effort: 4})});
    assert.equal(Buffer.compare(invoke(standalone), invoke(readable)), 0, name + ': encoded bytes');
    if (!name.startsWith('jpeg')) for (const fixture of [integerFixture(12), floatFixture({half: true}), floatFixture({special: true})]) {
      const {data, width, height, options} = fixture;
      const encode = api => (api.encode || api.encodePhoto)(data, width, height, {...options, quality: 100, effort: 2});
      assert.equal(Buffer.compare(encode(standalone), encode(readable)), 0, name + ': native sample bytes');
    }
    if (standalone.configureKernels) assert.throws(() => standalone.configureKernels('gpu'), {code: 'JXL_INPUT'});
  }
  const encodeCore = api => api.encode(pixels.rgba, pixels.width, pixels.height);
  assert.equal(Buffer.compare(encodeCore(await entry('')), encodeCore(await entry('/core'))), 0);
  assert.equal(Buffer.compare(encodeCore(await entry('/min')), encodeCore(await entry('/core/min'))), 0);
});

test('the packed optional source import preserves PNG16 sample words and declarations', async () => {
  const fixture = integerFixture(16), {readSource} = await entry('/source');
  const source = await readSource(png16Fixture(fixture, {primaries: 9, transfer: 16}));
  assert.deepEqual(source.data, fixture.data);
  assert.equal(source.colorSpace, 'rec2020'); assert.equal(source.transferFunction, 'pq');
  const {data, width, height, ...options} = source;
  const encoder = await entry('/min');
  assert.ok(encoder.encode(data, width, height, options).length > 0);
});

test('the standalone metadata entry preserves the readable container bytes', async () => {
  const core = await entry('/min'), readable = await entry('/metadata');
  const source = await readFile(require.resolve('rapier-jxl/metadata/min'));
  const standalone = await import('data:text/javascript;base64,' + source.toString('base64'));
  const bytes = core.encode(Uint8Array.of(12, 34, 56, 78), 1, 1);
  const options = {xmp: '<x:xmpmeta xmlns:x="adobe:ns:meta/"/>'};
  assert.deepEqual(standalone.withMetadata(bytes, options), readable.withMetadata(bytes, options));
});

test('the complete standalone entry and published worker preserve readable encoding results', {timeout: 60000}, async () => {
  const readable = (await entry('/rapier')).createEncoder();
  const moduleBytes = await readFile(require.resolve('rapier-jxl/rapier/min'));
  const standalone = (await import('data:text/javascript;base64,' + moduleBytes.toString('base64'))).createEncoder();
  const workerBytes = await readFile(require.resolve('rapier-jxl/rapier/worker'), 'utf8');
  const worker = new Worker(`const {parentPort} = require('node:worker_threads');
globalThis.postMessage = (...args) => parentPort.postMessage(...args);
${workerBytes}
parentPort.on('message', data => globalThis.onmessage({data}));`, {eval: true});
  let serial = 0;
  const ask = request => new Promise((resolve, reject) => {
    const done = reply => { worker.off('error', fail); resolve(reply); };
    const fail = error => { worker.off('message', done); reject(error); };
    worker.once('message', done); worker.once('error', fail); worker.postMessage({...request, id: ++serial});
  });
  const width = 64, height = 33, data = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) data.set([p & 255, p >> 8, p * 17 & 255, p % 3 ? 255 : 0], p * 4);
  const native = integerFixture(12);
  const cases = [
    {image: {data, width, height}, options: {lossless: true, effort: 2, colorSpace: 'display-p3'}},
    {image: {data, width, height}, options: {photo: true, quality: 90, effort: 1}},
    {image: {data: native.data, width: native.width, height: native.height}, options: {...native.options, lossless: true, effort: 2, colorSpace: 'rec2020', transferFunction: 'pq', intensityTarget: 10000}},
  ];
  try {
    for (const {image, options} of cases) {
      const before = image.data.slice(), expected = await readable.encode(image, options);
      assert.deepEqual(await standalone.encode(image, options), expected);
      const reply = await ask({operation: 'encode', ...image, options});
      assert.equal(reply.id, serial); assert.equal(reply.ok, true, JSON.stringify(reply.error));
      assert.deepEqual(reply.bytes, expected); assert.deepEqual(image.data, before);
    }
    const jpeg = new Uint8Array(await readFile(new URL('seeds/colour-sequential.jpg', import.meta.url)));
    const expected = await readable.transcode({bytes: jpeg});
    assert.deepEqual(await standalone.transcode({bytes: jpeg}), expected);
    const reply = await ask({operation: 'transcode', bytes: jpeg});
    const {id, ok, ...carried} = reply;
    assert.equal(id, serial); assert.equal(ok, true, JSON.stringify(reply.error)); assert.deepEqual(carried, expected);
    const refused = await ask({operation: 'encode', width: 2, height: 1, data: new Uint8Array(4)});
    assert.equal(refused.ok, false); assert.equal(refused.error.code, 'JXL_RGBA');
    const image = {data: Uint8Array.of(91, 32, 11, 0), width: 1, height: 1}, options = {lossless: true, effort: 1};
    const recovered = await ask({operation: 'encode', ...image, options});
    assert.equal(recovered.ok, true); assert.deepEqual(recovered.bytes, await readable.encode(image, options));
  } finally { await worker.terminate(); }
});

test('complete packed entries preserve serial bytes through real parallel groups', {timeout: 60000}, async () => {
  const width = 2048, height = 1280, data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([x & 255, y & 255, (x + y) & 255, x % 37 ? 255 : 0], (y * width + x) * 4);
  const before = createHash('sha256').update(data).digest('hex');
  const options = {lossless: true, effort: 1};
  const expected = await (await entry('/rapier')).createEncoder().encode({data, width, height}, options);
  for (const name of ['/rapier', '/rapier/min', '/rapier/worker']) {
    const worker = new Worker(new URL('rapier-worker.mjs', import.meta.url), {workerData: {file: require.resolve('rapier-jxl' + name), classic: name.endsWith('/worker')}});
    let helpers = 0;
    try {
      const reply = await new Promise((resolve, reject) => {
        worker.once('error', reject);
        worker.on('message', value => value.spawn ? helpers++ : resolve(value));
        worker.postMessage({id: name, operation: 'encode', data, width, height, options});
      });
      assert.equal(reply.id, name); assert.equal(reply.ok, true, JSON.stringify(reply.error));
      assert.ok(helpers >= 2, name + ' must use real helper workers'); assert.deepEqual(reply.bytes, expected, name);
    } finally { await worker.terminate(); }
  }
  assert.equal(createHash('sha256').update(data).digest('hex'), before);
});

test('the published size receipt measures the packed encoder files', async () => {
  const receipt = JSON.parse(await readFile(join(root, 'dist/sizes.json'), 'utf8'));
  const entries = [...receipt.doors, {entry: 'rapier/worker', file: receipt.rapierWorker.file, alone: receipt.rapierWorker}];
  for (const door of entries) {
    const bytes = await readFile(join(root, door.file));
    assert.equal(bytes.length, door.alone.bytes, door.entry);
    assert.equal(gzipSync(bytes, {level: 9}).length, door.alone.gzip, door.entry);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), door.alone.sha256, door.entry);
  }
});

test('a strict TypeScript consumer uses the packed package exports and Blob results', async () => {
  const consumer = join(scratch, 'consumer.mts');
  await copyFile(new URL('types.mts', import.meta.url), consumer);
  const compiler = join(dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin/tsc');
  const check = spawnSync(process.execPath, [compiler, '--noEmit', '--strict', '--exactOptionalPropertyTypes', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', '--lib', 'ES2022,DOM', consumer], {encoding: 'utf8'});
  assert.equal(check.status, 0, (check.stdout || '') + (check.stderr || '') + (check.error || ''));
});
