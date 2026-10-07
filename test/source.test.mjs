// SPDX-License-Identifier: MIT
// Source admission checks cover loss of precision, channel meaning and malformed compressed extents.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import {readSource} from '../src/source.mjs';
import {integerFixture, floatFixture, png16Fixture, pngChunk, exrFixture} from './high-depth-fixtures.mjs';

const bytesOf = data => new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
const inputError = {code: 'JXL_INPUT'};
function rewritePng(bytes, change) {
  const chunks = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset), name = bytes.toString('ascii', offset + 4, offset + 8);
    const data = Buffer.from(bytes.subarray(offset + 8, offset + 8 + length));
    chunks.push(pngChunk(name, change(name, data) ?? data)); offset += length + 12;
  }
  return Buffer.concat([bytes.subarray(0, 8), ...chunks]);
}
function rewriteExr(bytes, name, change) {
  const copy = Buffer.from(bytes);
  for (let offset = 8; copy[offset];) {
    const end = copy.indexOf(0, offset), current = copy.toString('ascii', offset, end), typeEnd = copy.indexOf(0, end + 1);
    const length = copy.readInt32LE(typeEnd + 1), start = typeEnd + 5;
    if (name === current) { change(copy.subarray(start, start + length)); return copy; }
    offset = start + length;
  }
  throw new Error('fixture attribute is missing: ' + name);
}

test('PNG16 preserves sample words through every filter, channel layout and Adam7 edge pass', async () => {
  for (const [width, height] of [[1, 1], [1, 9], [17, 1], [17, 9]]) for (const colorType of [0, 2, 4, 6]) {
    const fixture = integerFixture(16, width, height);
    for (let i = 0; i < fixture.data.length; i += 4) {
      if (colorType < 2 || colorType === 4) fixture.data[i + 1] = fixture.data[i + 2] = fixture.data[i];
      if (colorType === 0 || colorType === 2) fixture.data[i + 3] = 65535;
    }
    for (const interlace of [false, true]) for (const filter of [0, 1, 2, 3, 4]) {
      const actual = await readSource(png16Fixture(fixture, {colorType, interlace, filter}));
      assert.equal(actual.width, width); assert.equal(actual.height, height);
      assert.deepEqual(actual.data, fixture.data, `PNG16 ${width}x${height}, type ${colorType}, filter ${filter}, interlaced ${interlace}`);
      assert.equal(actual.alphaPremultiplied, false);
    }
  }
});

test('PNG16 preserves colour precedence and full-depth transparency keys', async () => {
  const fixture = integerFixture(16), key = Buffer.alloc(6);
  for (let c = 0; c < 3; c++) key.writeUInt16BE(fixture.data[c], c * 2);
  for (let i = 3; i < fixture.data.length; i += 4) fixture.data[i] = i === 3 ? 0 : 65535;
  const metadata = [['tRNS', key], ['sRGB', Buffer.from([1])], ['gAMA', Buffer.from([0, 0, 177, 143])]];
  const actual = await readSource(png16Fixture(fixture, {colorType: 2, metadata}));
  assert.deepEqual(actual.data, fixture.data);
  assert.equal(actual.colorSpace, 'srgb'); assert.equal(actual.transferFunction, 'srgb');
  const cicp = await readSource(png16Fixture(fixture, {metadata: [
    ['cICP', Buffer.from([12, 18, 0, 1])], ['iCCP', Buffer.from('profile\0\0')], ['sRGB', Buffer.from([1])],
  ]}));
  assert.equal(cicp.colorSpace, 'display-p3'); assert.equal(cicp.transferFunction, 'hlg');
  const linear = await readSource(png16Fixture(fixture, {metadata: [['gAMA', Buffer.from([0, 1, 134, 160])]]}));
  assert.equal(linear.transferFunction, 'linear');
  await assert.rejects(readSource(png16Fixture(fixture, {metadata: [['iCCP', Buffer.from('profile\0\0')]]})), inputError);
  await assert.rejects(readSource(png16Fixture(fixture, {metadata: [['gAMA', Buffer.from([0, 0, 177, 143])]]})), inputError);
  await assert.rejects(readSource(png16Fixture(fixture, {metadata: [['cICP', Buffer.from([9, 16, 0, 0])]]})), inputError);
});

test('PNG admission refuses corruption, animations and compressed extents that disagree with IHDR', async () => {
  const fixture = integerFixture(16), png = png16Fixture(fixture);
  const corrupt = Buffer.from(png); corrupt[corrupt.length - 1] ^= 1;
  await assert.rejects(readSource(corrupt), inputError);
  await assert.rejects(readSource(png.subarray(0, png.length - 3)), inputError);
  const oversized = rewritePng(png, (name, data) => { if (name === 'IHDR') data.writeUInt32BE(16385, 0); });
  await assert.rejects(readSource(oversized), {code: 'JXL_DIMENSIONS'});
  const expected = fixture.height * (fixture.width * 8 + 1);
  for (const length of [expected - 1, expected + 1]) {
    const wrongExtent = rewritePng(png, name => name === 'IDAT' ? deflateSync(Buffer.alloc(length)) : undefined);
    await assert.rejects(readSource(wrongExtent), inputError);
  }
  const unknownFilter = rewritePng(png, name => {
    if (name !== 'IDAT') return;
    const raw = Buffer.alloc(expected); raw[0] = 5; return deflateSync(raw);
  });
  await assert.rejects(readSource(unknownFilter), inputError);
  const animated = png16Fixture(fixture, {metadata: [['acTL', Buffer.from([0, 0, 0, 1, 0, 0, 0, 0])]]});
  await assert.rejects(readSource(animated), inputError);
});

test('OpenEXR retains IEEE payloads and associated alpha for every admitted compression', async () => {
  for (const half of [false, true]) for (const compression of ['none', 'rle', 'zips', 'zip']) {
    const fixture = floatFixture({half, special: true, height: 19});
    const source = exrFixture(fixture, {rec2020: true, compression, whiteLuminance: 1000});
    const actual = await readSource(source);
    assert.deepEqual(bytesOf(actual.data), bytesOf(fixture.data), `${half ? 'HALF' : 'FLOAT'} ${compression}: original IEEE words`);
    assert.equal(actual.alphaPremultiplied, true); assert.equal(actual.colorSpace, 'rec2020');
    assert.equal(actual.transferFunction, 'linear'); assert.equal(actual.intensityTarget, 1000);
  }
});

test('OpenEXR refuses unsupported interpretation and inconsistent block locations', async () => {
  const source = exrFixture(floatFixture({half: true, height: 19}), {compression: 'zip'});
  const changes = [
    ['compression', bytes => { bytes[0] = 4; }],
    ['pixelAspectRatio', bytes => { bytes.writeFloatLE(2); }],
    ['displayWindow', bytes => { bytes.writeInt32LE(1); }],
    ['chromaticities', bytes => { bytes.writeFloatLE(.5); }],
    ['channels', bytes => { bytes.writeInt32LE(2, 2); }],
  ];
  for (const [name, change] of changes) await assert.rejects(readSource(rewriteExr(source, name, change)), inputError);
  const truncated = source.subarray(0, source.length - 1);
  await assert.rejects(readSource(truncated), inputError);
  const tiled = Buffer.from(source); tiled.writeUInt32LE(0x202, 4);
  await assert.rejects(readSource(tiled), inputError);
  let offset = 8;
  while (source[offset]) {
    const end = source.indexOf(0, source.indexOf(0, offset) + 1);
    offset = end + 5 + source.readInt32LE(end + 1);
  }
  const invalidOffset = Buffer.from(source); invalidOffset.writeBigUInt64LE(0xffffffffffffffffn, offset + 1);
  await assert.rejects(readSource(invalidOffset), inputError);
  const overlapping = Buffer.from(source); overlapping.copy(overlapping, offset + 9, offset + 1, offset + 9);
  await assert.rejects(readSource(overlapping), inputError);
});

test('reading owns source bytes before asynchronous decompression', async () => {
  const fixture = integerFixture(16), source = png16Fixture(fixture), pending = readSource(source);
  source.fill(0);
  assert.deepEqual((await pending).data, fixture.data);
  const bytes = png16Fixture(fixture), buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  assert.deepEqual((await readSource(buffer)).data, fixture.data);
  await assert.rejects(readSource(new Uint16Array(4)), inputError);
  await assert.rejects(readSource(new Uint8Array()), inputError);
});

test('invalid deflate data refuses with the public source error code', async () => {
  const png = png16Fixture(integerFixture(16));
  const invalid = rewritePng(png, name => name === 'IDAT' ? Buffer.from([0]) : undefined);
  await assert.rejects(readSource(invalid), inputError);
});

test('detached source buffers refuse with the public source error code', async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), buffer = bytes.buffer;
  structuredClone(bytes, {transfer: [buffer]});
  await assert.rejects(readSource(bytes), inputError);
  await assert.rejects(readSource(buffer), inputError);
});
