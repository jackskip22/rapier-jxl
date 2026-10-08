// SPDX-License-Identifier: MIT
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {brotliCompressSync} from 'node:zlib';
import {encode, LIMITS} from '../src/index.mjs';
import {withMetadata} from '../src/metadata.mjs';
import {borderCase} from './fuzz-cases.mjs';
import {decoder, unpng} from './decoder.mjs';
import {rgbaOf} from './oracles.mjs';
import {integerFixture} from './high-depth-fixtures.mjs';
import {djxlDecoder} from './djxl-decoder.mjs';

const decode = await decoder(), text = value => new TextEncoder().encode(value);
const joinBytes = (...parts) => new Uint8Array(Buffer.concat(parts));
const signature = Uint8Array.from([0, 0, 0, 12, 74, 88, 76, 32, 13, 10, 135, 10]);
function box(type, data, {wide = false, final = false} = {}) {
  const bytes = new Uint8Array(data.length + (wide ? 16 : 8)), view = new DataView(bytes.buffer);
  view.setUint32(0, final ? 0 : wide ? 1 : bytes.length); bytes.set(text(type), 4);
  if (wide) view.setBigUint64(8, BigInt(bytes.length));
  bytes.set(data, wide ? 16 : 8); return bytes;
}
const ftyp = box('ftyp', joinBytes(text('jxl '), new Uint8Array(4), text('jxl ')));
const exif = Uint8Array.from([73, 73, 42, 0, 8, 0, 0, 0, 1, 0, 18, 1, 3, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
const xmp = '<x:xmpmeta xmlns:x="adobe:ns:meta/">λ 🎨</x:xmpmeta>';
const exifBox = data => box('Exif', joinBytes(new Uint8Array(4), data));
const compressed = (type, data) => box('brob', joinBytes(text(type), brotliCompressSync(data)));
const picture = borderCase(9, 7), stream = encode(picture.rgba, picture.width, picture.height);
function partial(index, data, options) {
  const prefix = new Uint8Array(4); new DataView(prefix.buffer).setUint32(0, index);
  return box('jxlp', joinBytes(prefix, data), options);
}
const variants = [
  stream,
  joinBytes(signature, ftyp, box('jxlc', stream, {wide: true})),
  joinBytes(signature, ftyp, box('jxlc', stream, {final: true})),
  joinBytes(signature, box('ftyp', ftyp.subarray(8), {wide: true}), box('test', text('opaque'), {wide: true}),
    partial(0, stream.subarray(0, 1)), partial(1, stream.subarray(1, 2)), partial(0x80000002, stream.subarray(2), {final: true})),
  joinBytes(signature, ftyp, partial(0, stream), partial(0x80000001, new Uint8Array(), {final: true}))
];

test('metadata wraps bare streams and retains existing boxes, source bytes and owned output', () => {
  for (const source of variants) {
    const before = source.slice(), tiff = exif.slice(), tagged = withMetadata(source, {exif: tiff, xmp});
    assert.deepEqual(source, before); assert.deepEqual(tiff, exif);
    const prefix = source[0] === 255 ? joinBytes(signature, ftyp) : source.subarray(0, source[15] === 1 ? 40 : 32);
    const payload = source[0] === 255 ? box('jxlc', source) : source.subarray(prefix.length);
    assert.deepEqual(tagged, joinBytes(prefix, exifBox(exif), box('xml ', text(xmp)), payload));
    const copy = withMetadata(source);
    assert.deepEqual(copy, source); assert.notEqual(copy.buffer, source.buffer);
    copy[0] ^= 255; assert.deepEqual(source, before);
  }
});

test('requested metadata replaces plain and compressed copies while omitted fields and unknown boxes remain exact', () => {
  const oldXml = compressed('xml ', text('<old/>')), unknown = compressed('jumb', text('opaque metadata'));
  const oldExif = compressed('Exif', joinBytes(new Uint8Array(4), exif));
  const source = joinBytes(signature, ftyp, oldExif, oldXml, unknown, exifBox(exif), box('jxlc', stream, {final: true}));
  const oriented = exif.slice(); oriented[18] = 6;
  assert.deepEqual(withMetadata(source, {exif: oriented}), joinBytes(signature, ftyp, exifBox(oriented), oldXml, unknown, box('jxlc', stream, {final: true})));
  assert.deepEqual(withMetadata(source, {exif, xmp: text(xmp)}), joinBytes(signature, ftyp, exifBox(exif), box('xml ', text(xmp)), unknown, box('jxlc', stream, {final: true})));
  assert.deepEqual(withMetadata(source, {xmp: ''}), joinBytes(signature, ftyp, box('xml ', new Uint8Array()), oldExif, unknown, exifBox(exif), box('jxlc', stream, {final: true})));
  assert.deepEqual(withMetadata(source, {exif: null, xmp: null}), joinBytes(signature, ftyp, unknown, box('jxlc', stream, {final: true})));
  assert.deepEqual(withMetadata(stream, {exif: null, xmp: null}), stream);
  const unicode = '\ud800\udc00\ud800λ';
  assert.deepEqual(withMetadata(stream, {xmp: unicode}), joinBytes(signature, ftyp, box('xml ', text(unicode)), box('jxlc', stream)));
});

test('metadata rejects malformed framing and metadata input before producing a file', () => {
  for (const source of [null, [], new Uint8Array(), text('not JPEG XL'), signature,
    joinBytes(signature, box('nope', new Uint8Array(12)), box('jxlc', stream)),
    joinBytes(signature, ftyp), joinBytes(signature, ftyp, box('jxlc', stream), box('jxlc', stream)),
    joinBytes(signature, ftyp, partial(0, stream)), joinBytes(signature, ftyp, partial(0x80000001, stream)),
    joinBytes(signature, ftyp, partial(0x80000000, new Uint8Array())),
    joinBytes(signature, ftyp, box('brob', new Uint8Array(3)), box('jxlc', stream)),
    joinBytes(signature, ftyp, box('jxlc', text('bad'))), variants[1].subarray(0, variants[1].length - 1)])
    assert.throws(() => withMetadata(source, {xmp}), {code: 'JXL_INPUT'});
  for (const size of [7, 15, 2 ** 53]) {
    const bad = box('jxlc', stream, {wide: true}); new DataView(bad.buffer).setBigUint64(8, BigInt(size));
    assert.throws(() => withMetadata(joinBytes(signature, ftyp, bad), {xmp}), {code: 'JXL_INPUT'});
  }
  for (const options of [null, [], 1, {exif: text('Exif\0\0II*\0')}, {exif: exif.subarray(0, 7)}, {xmp: 42}])
    assert.throws(() => withMetadata(stream, options), {code: 'JXL_INPUT'});
  for (const data of [box('jbrd', new Uint8Array()), compressed('jbrd', new Uint8Array())]) {
    const source = joinBytes(signature, ftyp, data, box('jxlc', stream));
    assert.deepEqual(withMetadata(source), source);
    assert.throws(() => withMetadata(source, {xmp}), {code: 'JXL_INPUT'});
    assert.throws(() => withMetadata(source, {exif: null, xmp: null}), {code: 'JXL_INPUT'});
  }
});

test('metadata output accounting includes signature, boxes and UTF-8 bytes', () => {
  const maximum = new Uint8Array(LIMITS.bytes - stream.length - 48);
  assert.equal(withMetadata(stream, {xmp: maximum}).length, LIMITS.bytes);
  assert.throws(() => withMetadata(stream, {xmp: new Uint8Array(maximum.length + 1)}), {code: 'JXL_SIZE'});
  assert.throws(() => withMetadata(stream, {xmp: 'λ'.repeat(LIMITS.bytes / 2)}), {code: 'JXL_SIZE'});
});

test('metadata containers retain exact RGBA through jxl-oxide', {skip: !decode}, () => {
  for (const source of variants) assert.deepEqual(rgbaOf(decode(withMetadata(source, {exif, xmp}))), picture.rgba);
});

test('libjxl extracts the original Exif and XMP and retains ordinary and level-10 samples', {skip: !process.env.JXL_DJXL}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rapier-metadata-')), djxl = process.env.JXL_DJXL;
  const run = (input, output) => {
    const result = spawnSync(djxl, [input, output, '--quiet'], {encoding: 'utf8', timeout: 30000});
    assert.equal(result.status, 0, result.stderr || String(result.error));
  };
  let oracle;
  try {
    for (let i = 0; i < variants.length; i++) {
      const file = join(dir, i + '.jxl'); await writeFile(file, withMetadata(variants[i], {exif, xmp}));
      run(file, file + '.exif'); run(file, file + '.xmp'); run(file, file + '.png');
      assert.deepEqual(new Uint8Array(await readFile(file + '.exif')), exif);
      assert.deepEqual(new Uint8Array(await readFile(file + '.xmp')), text(xmp));
      assert.deepEqual(rgbaOf(unpng(await readFile(file + '.png'))), picture.rgba);
    }
    const p = integerFixture(16, 9, 7), original = encode(p.data, p.width, p.height, p.options), tagged = withMetadata(original, {exif, xmp});
    assert.deepEqual(tagged.subarray(32 + exif.length + 12 + text(xmp).length + 8), original.subarray(32));
    oracle = await djxlDecoder();
    assert.deepEqual(await oracle.decode(tagged, p.width, p.height), await oracle.decode(original, p.width, p.height));
  } finally { if (oracle) await oracle.close(); await rm(dir, {recursive: true, force: true}); }
});
