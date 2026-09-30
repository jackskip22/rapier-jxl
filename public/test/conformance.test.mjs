// SPDX-License-Identifier: MIT
// A returned stream must decode; exact pixels and carried coefficients must survive. Malformed JPEGs must not
// invent coefficients. The fixed seed and iteration printed with each failure reproduce the mutation unchanged.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {encode} from '../../index.mjs';
import {transcode} from '../../jpeg.mjs';
import {rng, mutateJPEG, mutationKinds, pixelCase, borderCase, guardJPEGPlanes} from './fuzz-cases.mjs';
import {oracles} from './oracles.mjs';

const seedsURL = new URL('./seeds/', import.meta.url);
const cases = await Promise.all(JSON.parse(await readFile(new URL('cases.json', seedsURL), 'utf8')).map(async seed => ({...seed, data: new Uint8Array(await readFile(new URL(seed.file, seedsURL)))})));
const retainedPixels = await Promise.all(JSON.parse(await readFile(new URL('pixels.json', seedsURL), 'utf8')).map(async item => {
  const bytes = await readFile(new URL(item.file, seedsURL));
  return {...item, rgba: new Uint8Array(item.file.endsWith('.gz') ? gunzipSync(bytes) : bytes)};
}));
const oracle = await oracles();
const seed = Number(process.env.JXL_FUZZ_SEED || 20260930) >>> 0;
const count = (name, fallback) => {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  assert.ok(Number.isSafeInteger(value) && value >= 0, name + ' must be a nonnegative integer');
  return value;
};
const codes = new Set(['JXL_INPUT', 'JXL_DIMENSIONS', 'JXL_SIZE', 'JXL_MEMORY', 'JXL_JPEG']);
async function failure(name, bytes, error, description) {
  if (process.env.JXL_FUZZ_FAILURE_DIR) {
    await mkdir(process.env.JXL_FUZZ_FAILURE_DIR, {recursive: true});
    await writeFile(join(process.env.JXL_FUZZ_FAILURE_DIR, name), bytes);
    await writeFile(join(process.env.JXL_FUZZ_FAILURE_DIR, name + '.json'), JSON.stringify({seed, description, error: String(error), stack: error.stack}, null, 2) + '\n');
  }
  throw new Error(description + ': ' + (error.message || String(error)), {cause: error});
}

// Mutated admitted dimensions are at most 65; JPEG sampling factors are at most four. Even a malformed header
// cannot make the fuzz runner allocate an attacker-sized plane while testing that pre-allocation refusal.
function guardedTranscode(bytes) {
  return guardJPEGPlanes(() => transcode(bytes));
}

test('retained JPEG defects refuse lost coefficients; table reuse preserves the original component', t => {
  let rejected = 0, returned = 0;
  for (const item of cases) {
    if (item.code) { assert.throws(() => guardedTranscode(item.data), {code: item.code}, item.file); rejected++; continue; }
    const output = guardedTranscode(item.data);
    assert.equal(output.width, item.width, item.file); assert.equal(output.height, item.height, item.file);
    const pixels = oracle.decode(output.bytes, item.width, item.height, item.file);
    if (item.same) assert.deepEqual(output.bytes, transcode(cases.find(c => c.file === item.same).data).bytes, item.file + ': same coefficients changed');
    if (item.samePixels) {
      const other = transcode(cases.find(c => c.file === item.samePixels).data);
      assert.deepEqual(pixels, oracle.decode(other.bytes, other.width, other.height, item.samePixels), item.file + ': coded pixels changed');
    }
    returned++;
  }
  t.diagnostic(JSON.stringify({retained: cases.length, rejected, returned, oracles: oracle.names, nativeUnavailable: !oracle.native, jxlRsUnavailable: !oracle.jxlRs, jxlRsDifferences: oracle.jxlRsDifferences}));
});

test('structure-aware JPEG mutations return decodable streams or documented refusals', async t => {
  const inputs = cases.filter(c => !c.code), random = rng(seed), mutations = count('JXL_FUZZ_JPEGS', 128);
  const tally = Object.fromEntries(mutationKinds.map(kind => [kind, {returned: 0, refused: 0}]));
  for (let iteration = 0; iteration < mutations; iteration++) {
    const input = inputs[Math.floor(random() * inputs.length)], {bytes, kind} = mutateJPEG(input.data, random, iteration);
    const description = `JPEG seed=${seed} iteration=${iteration} source=${input.file} mutation=${kind}`;
    let output;
    try { output = guardedTranscode(bytes); }
    catch (error) {
      if (codes.has(error.code)) { tally[kind].refused++; continue; }
      await failure(`jpeg-${seed}-${iteration}.jpg`, bytes, error, description);
    }
    try { oracle.decode(output.bytes, output.width, output.height, description); tally[kind].returned++; }
    catch (error) { await failure(`jpeg-${seed}-${iteration}.jpg`, bytes, error, description); }
  }
  t.diagnostic(JSON.stringify({seed, jpegMutations: mutations, tally, oracles: oracle.names, nativeUnavailable: !oracle.native, jxlRsUnavailable: !oracle.jxlRs, jxlRsDifferences: oracle.jxlRsDifferences}));
});

test('mutated pixel cases keep exact pixels and produce conformant lossless and lossy streams', async t => {
  const mutations = count('JXL_FUZZ_PIXELS', 24);
  let streams = 0;
  // The optional photographic and effort doors participate whenever they are present in this repository.
  let photo, effort;
  try { ({encodePhoto: photo} = await import('../../photo.mjs')); }
  catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
  try { ({encode: effort} = await import('../../effort.mjs')); }
  catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
  const inputs = [...retainedPixels, ...Array.from({length: mutations}, (_, iteration) => ({seed, iteration}))];
  for (const input of inputs) {
    const {iteration} = input, {rgba, width, height, quality, kind} = input.rgba ? input : pixelCase(input.seed, iteration);
    const description = `pixels seed=${input.seed} iteration=${iteration} ${width}x${height} ${kind}`;
    try {
      oracle.decode(encode(rgba, width, height), width, height, description + ' lossless', rgba); streams++;
      for (const q of input.qualities || [quality]) {
        oracle.decode(encode(rgba, width, height, {quality: q}), width, height, description + ` quality=${q}`, q === 100 ? rgba : undefined); streams++;
      }
      if (photo) {
        const opaque = Uint8Array.from(rgba); for (let i = 3; i < opaque.length; i += 4) opaque[i] = 255;
        oracle.decode(photo(opaque, width, height, {quality: 90}), width, height, description + ' photo quality=90'); streams++;
      }
      if (effort) for (const level of [2, 3]) { oracle.decode(effort(rgba, width, height, {effort: level}), width, height, description + ` effort=${level}`, rgba); streams++; }
    } catch (error) { await failure(`pixels-${input.seed}-${iteration}.rgba`, rgba, error, description); }
  }
  t.diagnostic(JSON.stringify({seed, retainedPixels: retainedPixels.length, pixelMutations: mutations, streams, photo: Boolean(photo), effort: Boolean(effort), oracles: oracle.names, nativeUnavailable: !oracle.native, jxlRsUnavailable: !oracle.jxlRs, jxlRsDifferences: oracle.jxlRsDifferences}));
});

// Pictures the weighted predictor takes at efforts 2 and 3 in every channel layout, one group and several.
test('the effort door\'s rungs keep grey, grey and alpha, colour and RGBA pictures exact', async t => {
  let effort;
  try { ({encode: effort} = await import('../../effort.mjs')); }
  catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
  if (!effort) return t.skip('no effort door in this repository');
  let streams = 0;
  for (const [width, height] of [[200, 100], [300, 200]]) {
    const {rgba} = borderCase(width, height), grey = Uint8Array.from(rgba), greyAlpha = Uint8Array.from(rgba), withAlpha = Uint8Array.from(rgba);
    for (let i = 0; i < rgba.length; i += 4) {
      grey[i + 1] = grey[i + 2] = greyAlpha[i + 1] = greyAlpha[i + 2] = rgba[i];
      greyAlpha[i + 3] = rgba[i + 1]; withAlpha[i + 3] = rgba[i + 2];
    }
    for (const [kind, pixels] of Object.entries({colour: rgba, grey, 'grey and alpha': greyAlpha, rgba: withAlpha}))
      for (const level of [2, 3]) { oracle.decode(effort(pixels, width, height, {effort: level}), width, height, `${kind} ${width}x${height} effort=${level}`, pixels); streams++; }
  }
  t.diagnostic(JSON.stringify({streams, oracles: oracle.names, nativeUnavailable: !oracle.native}));
});
