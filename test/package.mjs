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

test('the published size receipt measures the packed encoder files', async () => {
  const receipt = JSON.parse(await readFile(join(root, 'dist/sizes.json'), 'utf8'));
  for (const door of receipt.doors) {
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
