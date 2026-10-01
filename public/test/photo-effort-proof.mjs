// SPDX-License-Identifier: MIT
// Replay a photo-effort-benchmark receipt's streams through all three decoders. --inputs relocates pixels by
// ID and hash; --regenerate reconstructs saved streams from the exact source graph, refusing any changed hash.
// node test/photo-effort-proof.mjs --table=/tmp/table.json --work=/tmp/streams --native=/path/native-decoder --rs=/path/rapier_oracle --output=/tmp/proof.json
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {nativeDecoder} from './native-decoder.mjs';
import {decoder} from './decoder.mjs';
import {jxlRsDecoder, decoderDifference} from './jxl-rs-decoder.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(arg => { const [key, ...value] = arg.replace(/^--/, '').split('='); return [key, value.join('=') || true]; }));
for (const name of ['table', 'work', 'native', 'rs', 'output']) assert.equal(typeof args[name], 'string', '--' + name + ' is required');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const receiptBytes = readFileSync(args.table), table = JSON.parse(receiptBytes);
assert.ok(Array.isArray(table.rows) && table.rows.length > 0, 'the measurement receipt must have input rows');
let inputs = null, encodePhoto, source;
if (args.inputs) {
  const rows = JSON.parse(readFileSync(args.inputs));
  assert.ok(Array.isArray(rows) && rows.length > 0);
  inputs = new Map(rows.map(row => [row.id, row]));
  assert.equal(inputs.size, rows.length, 'relocated input IDs must be unique');
}
const verifySource = () => {
  for (const [name, digest] of Object.entries(table.sources)) assert.equal(hash(readFileSync(join(source, name))), digest, name + ': recorded encoder changed');
};
if (args.regenerate) {
  source = resolve(args.source || fileURLToPath(new URL('../../', import.meta.url)));
  verifySource();
  ({encodePhoto} = await import(pathToFileURL(join(source, 'photo.mjs'))));
  mkdirSync(args.work, {recursive: true});
}
const oxide = await decoder(), rust = jxlRsDecoder({executable: args.rs});
assert.ok(oxide && rust, 'jxl-oxide and unmodified jxl-rs must both be available');
const native = await nativeDecoder({executable: args.native});
const rgbaOf = image => {
  const out = new Uint8Array(image.width * image.height * 4);
  for (let i = 0; i < image.width * image.height; i++) {
    for (let c = 0; c < 3; c++) out[i * 4 + c] = image.data[i * image.channels + (image.channels <= 2 ? 0 : c)];
    out[i * 4 + 3] = image.channels === 4 ? image.data[i * 4 + 3] : image.channels === 2 ? image.data[i * 2 + 1] : 255;
  }
  return out;
};
const rows = [];
try {
  for (const row of table.rows) {
    const {id, width, height} = row, input = inputs ? inputs.get(id) : row;
    assert.ok(input, id + ': missing relocated input');
    assert.equal(input.width, width); assert.equal(input.height, height);
    assert.equal(input.rgbaHash, row.rgbaHash, id + ': relocated input hash differs');
    const data = readFileSync(inputs ? resolve(dirname(resolve(args.inputs)), input.pixels) : input.pixels);
    assert.equal(data.length, width * height * 4, id + ': input size');
    assert.equal(hash(data), row.rgbaHash, id + ': input hash');
    const streams = [];
    for (const [column, effort] of [['baseline', 1], ['previous', table.previousEffort], ['candidate', table.effort]]) {
      if (encodePhoto) {
        const regenerated = encodePhoto(data, width, height, {quality: table.quality, effort});
        assert.equal(hash(regenerated), row[column].sha256, id + ': regenerated stream differs');
        writeFileSync(join(args.work, id + '-e' + effort + '.jxl'), regenerated);
      }
      const bytes = readFileSync(join(args.work, id + '-e' + effort + '.jxl'));
      assert.equal(bytes.length, row[column].bytes, id + ': stream size');
      assert.equal(hash(bytes), row[column].sha256, id + ': stream hash');
      const nativePixels = await native.decode(bytes, width, height), image = oxide(bytes);
      assert.equal(image.width, width); assert.equal(image.height, height);
      const decoded = [nativePixels, rgbaOf(image), rust.decode(bytes, width, height)];
      let nativeSse = 0;
      for (let i = 0; i < data.length; i++) {
        if (i % 4 === 3) for (const pixels of decoded) assert.equal(pixels[i], data[i], id + ': exact alpha');
        else nativeSse += (data[i] - nativePixels[i]) * (data[i] - nativePixels[i]);
      }
      if (row[column].rgbSse !== undefined) assert.equal(nativeSse, row[column].rgbSse, id + ': native reconstruction is the measured stream');
      const differences = [[0, 1], [0, 2], [1, 2]].map(([a, b]) => decoderDifference(decoded[a], decoded[b]));
      assert.ok(differences.every(d => !d.alpha && d.maximum <= 1), id + ': decoder RGB disagreement exceeds one level');
      streams.push({effort, sha256: row[column].sha256, rgbSse: nativeSse, differences});
    }
    rows.push({id, rgbaHash: row.rgbaHash, streams});
    console.log(JSON.stringify(rows.at(-1)));
  }
} finally { await native.close(); }
if (encodePhoto) verifySource();
const result = {node: process.version, table: args.table, tableSha256: hash(receiptBytes), sources: table.sources,
  programHash: hash(readFileSync(fileURLToPath(import.meta.url))), regenerated: !!encodePhoto,
  oracles: {native: native.version, oxide: oxide.version, rust: rust.version},
  summary: {pictures: rows.length, streams: rows.length * 3, decoderCalls: rows.length * 9,
    maximumRgbDifference: Math.max(...rows.flatMap(row => row.streams.flatMap(stream => stream.differences.map(d => d.maximum)))), exactAlpha: true}, rows};
writeFileSync(args.output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result.summary));
