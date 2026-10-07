// SPDX-License-Identifier: MIT
// Source precision and colour metadata are checked through independent decoder APIs.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {encode} from '../src/index.mjs';
import {nativeDecoder} from './native-decoder.mjs';
import {jxlRsDecoder} from './jxl-rs-decoder.mjs';
import {integerFixture, floatFixture, png16Fixture, exrFixture} from './high-depth-fixtures.mjs';

const bytesOf = data => new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
const cases = () => [
  {...integerFixture(10), format: 'uint16', expected: {bitDepth: 10, exponentBits: 0, primaries: 1, transferFunction: 13}},
  {...integerFixture(12), format: 'uint16', options: {bitDepth: 12, colorSpace: 'rec2020', transferFunction: 'pq', intensityTarget: 10000},
    expected: {bitDepth: 12, exponentBits: 0, primaries: 9, transferFunction: 16, intensityTarget: 10000}},
  {...integerFixture(16), format: 'uint16', options: {colorSpace: 'rec2020', transferFunction: 'hlg', intensityTarget: 1000},
    expected: {bitDepth: 16, exponentBits: 0, primaries: 9, transferFunction: 18, intensityTarget: 1000}},
  {...floatFixture({half: true}), format: 'float16', expected: {bitDepth: 16, exponentBits: 5, primaries: 1, transferFunction: 8}},
  {...floatFixture(), format: 'float32', expected: {bitDepth: 32, exponentBits: 8, primaries: 1, transferFunction: 8}},
  {...floatFixture(), format: 'float32', options: {alphaPremultiplied: true},
    expected: {bitDepth: 32, exponentBits: 8, primaries: 1, transferFunction: 8, alphaPremultiplied: true}},
];

async function roundtrip(open, {native = false} = {}) {
  for (const fixture of cases()) {
    const {width, height, data, options, format, expected} = fixture;
    const bytes = encode(data, width, height, options);
    const oracle = await open({format, source: true, metadata: true});
    try {
      const actual = await oracle.decode(bytes, width, height);
      assert.deepEqual(bytesOf(actual), bytesOf(data), `${format}/${expected.bitDepth}: every source bit, including hidden RGB, alpha and signed zero`);
      for (const [name, value] of Object.entries(expected)) assert.equal(oracle.metadata[name], value, `${format}: encoded ${name}`);
      assert.equal(oracle.metadata.usesOriginalProfile, true, 'source colour encoding is retained');
      assert.equal(oracle.metadata.alphaPremultiplied, options.alphaPremultiplied ?? false, 'source alpha association is retained');
      if (native) {
        assert.equal(oracle.metadata.alphaBitDepth, expected.bitDepth, 'alpha has its original sample depth');
        assert.equal(oracle.metadata.alphaExponentBits, expected.exponentBits, 'alpha has its original float encoding');
      }
    } finally { await oracle.close(); }
  }
}

test('10-, 12-, 16-bit and IEEE float source samples and HDR metadata survive native libjxl', async t => {
  if (!process.env.JXL_FUZZ_NATIVE) return t.skip('native libjxl is unavailable (set JXL_FUZZ_NATIVE)');
  await roundtrip(options => nativeDecoder(options), {native: true});
});

test('10-, 12-, 16-bit and IEEE float source samples and HDR metadata survive jxl-rs', async t => {
  const oracle = jxlRsDecoder();
  if (!oracle) return t.skip('jxl-rs is unavailable (set JXL_FUZZ_JXL_RS)');
  await roundtrip(options => oracle.persistent(options));
});

test('every finite binary16 value is exact in independent binary32 output', async t => {
  const data = Uint16Array.from({length: 65536}, (_, word) => word).filter(word => (word & 0x7c00) !== 0x7c00);
  const width = 256, height = data.length / (width * 4);
  // IEEE binary16's mathematical values, independently evaluated in binary32. Powers of two and the
  // 10-bit significand are exact here; applying the sign also preserves negative zero.
  const expected = Float32Array.from(data, word => {
    const exponent = (word >>> 10) & 31, fraction = word & 1023;
    const value = exponent ? (1 + fraction / 1024) * 2 ** (exponent - 15) : fraction / 16777216;
    return word & 0x8000 ? -value : value;
  });
  const encoded = encode(data, width, height, {sampleFormat: 'float16'}), opens = [];
  if (process.env.JXL_FUZZ_NATIVE) opens.push(options => nativeDecoder(options));
  const rust = jxlRsDecoder(); if (rust) opens.push(options => rust.persistent(options));
  if (!opens.length) return t.skip('independent decoders are unavailable');
  for (const open of opens) {
    const oracle = await open({format: 'float32', source: true, metadata: true});
    try {
      assert.equal(Buffer.compare(bytesOf(await oracle.decode(encoded, width, height)), bytesOf(expected)), 0,
        'all finite half values, signed zeros and subnormals have their exact binary32 representations');
      assert.equal(oracle.metadata.bitDepth, 16); assert.equal(oracle.metadata.exponentBits, 5);
    } finally { await oracle.close(); }
  }
});

test('real PNG16 and scanline OpenEXR samples enter the encoder without an 8-bit intermediate', async () => {
  const {readSource} = await import('../src/source.mjs');
  const png = integerFixture(16), sources = [
    {fixture: png, bytes: png16Fixture(png, {primaries: 9, transfer: 16}), bitDepth: 16,
      sampleFormat: 'uint', colorSpace: 'rec2020', transferFunction: 'pq', alphaPremultiplied: false},
  ];
  for (const half of [false, true]) for (const compression of ['none', 'rle', 'zips', 'zip']) {
    const fixture = floatFixture({half, height: 19});
    sources.push({fixture, bytes: exrFixture(fixture, {rec2020: true, compression}), bitDepth: half ? 16 : 32,
      sampleFormat: half ? 'float16' : 'float32', colorSpace: 'rec2020', transferFunction: 'linear', alphaPremultiplied: true});
  }
  for (const {fixture, bytes, ...expected} of sources) {
    const decoded = await readSource(bytes);
    assert.equal(decoded.width, fixture.width); assert.equal(decoded.height, fixture.height);
    assert.deepEqual(bytesOf(decoded.data), bytesOf(fixture.data), 'the file reader retains every original sample bit');
    for (const [name, value] of Object.entries(expected)) assert.equal(decoded[name], value, `file source ${name}`);
    const {data, width, height, ...options} = decoded;
    const encoded = encode(data, width, height, options);
    const format = decoded.sampleFormat === 'uint' ? 'uint16' : decoded.sampleFormat;
    const oracles = [];
    if (process.env.JXL_FUZZ_NATIVE) oracles.push(() => nativeDecoder({format, source: true, metadata: true}));
    const rust = jxlRsDecoder();
    if (rust) oracles.push(() => rust.persistent({format, source: true, metadata: true}));
    for (const open of oracles) {
      const oracle = await open();
      try {
        assert.deepEqual(bytesOf(await oracle.decode(encoded, width, height)), bytesOf(fixture.data), 'independent JXL decode preserves the file source words');
        assert.equal(oracle.metadata.alphaPremultiplied, expected.alphaPremultiplied, 'the file alpha convention survives the JXL header');
        assert.equal(oracle.metadata.primaries, 9, 'file source Rec. 2020 primaries survive the JXL header');
        assert.equal(oracle.metadata.transferFunction, expected.transferFunction === 'pq' ? 16 : 8, 'file source transfer survives the JXL header');
      } finally { await oracle.close(); }
    }
  }
});
