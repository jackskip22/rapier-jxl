// SPDX-License-Identifier: MIT
// Reproduce the rejected closed-loop chroma experiment without changing production source.
// node photo-cfl.mjs SOURCE CORPUS_MANIFEST OUTPUT_DIR DJXL OXIDE SSIMULACRA2 BUTTERAUGLI
// node photo-cfl.mjs --summarize RECEIPT
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {join, resolve, dirname, relative} from 'node:path';
import {readPng} from './image-io.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function summarize(receipt) {
  assert.equal(receipt.complete, true);
  const summary = {};
  for (const [stage, rows] of Object.entries(receipt.observations)) for (const variant of stage === 'screen' ? ['ac', 'full'] : ['ac']) {
    const deltas = rows.map(row => row[variant].delta), n = deltas.length;
    assert.ok(n > 0);
    summary[stage + '-' + variant] = {pairs: n,
      meanBytes: deltas.reduce((sum, d) => sum + d.bytes, 0) / n,
      meanBytePercent: rows.reduce((sum, row) => sum + 100 * (row[variant].bytes / row.base.bytes - 1), 0) / n,
      meanSsimulacra2: deltas.reduce((sum, d) => sum + d.ssimulacra2, 0) / n,
      meanButteraugli: deltas.reduce((sum, d) => sum + d.butteraugli, 0) / n,
      bothBetter: deltas.filter(d => d.ssimulacra2 > 0 && d.butteraugli < 0).length,
      bothWorse: deltas.filter(d => d.ssimulacra2 < 0 && d.butteraugli > 0).length,
      ssimulacra2Worse: deltas.filter(d => d.ssimulacra2 < 0).length,
      butteraugliWorse: deltas.filter(d => d.butteraugli > 0).length};
  }
  return summary;
}

async function main() {
  if (process.argv[2] === '--summarize') {
    console.log(JSON.stringify(summarize(JSON.parse(readFileSync(process.argv[3], 'utf8'))), null, 2));
    return;
  }
  const [sourceArg, manifestArg, outputArg, djxl, oxide, ssimulacra2, butteraugli] = process.argv.slice(2);
  assert.ok(sourceArg && manifestArg && outputArg && djxl && oxide && ssimulacra2 && butteraugli,
    'SOURCE CORPUS_MANIFEST OUTPUT_DIR DJXL OXIDE SSIMULACRA2 BUTTERAUGLI are required.');
  const source = resolve(sourceArg), manifestPath = resolve(manifestArg), corpus = dirname(manifestPath), out = resolve(outputArg);
  const command = (tool, args) => execFileSync(tool, args, {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']});
  const modules = new Map();
  const visit = path => {
    if (modules.has(path)) return;
    const text = readFileSync(path, 'utf8'); modules.set(path, text);
    for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*)(['"])(\.[^'"]+\.mjs)\1/g)) visit(resolve(dirname(path), match[2]));
  };
  visit(join(source, 'photo.mjs')); visit(join(source, 'kernels.mjs'));
  const old = `        for (let c = 0; c < 3; c++) for (let k = 0; k < 64; k++) {
          const coefficient = tile[at + c * 64 + k] - (k && c !== 1 ? (c === 0 ? fx : fb) / 84 * tile[at + 64 + k] : 0);
          const value = coefficient * quantScale / components[c].quant[k];
          const threshold = k && c === 1 ? 0.5 + strength * ((k & 7) >= 4 || (k >> 3) >= 4 ? 0.14 : 0.08) : 0.5;
          components[c].coeffs[offset + k] = Math.abs(value) < threshold ? 0 : Math.round(value);
        }`;
  const changed = correction => `        for (const c of [1, 0, 2]) for (let k = 0; k < 64; k++) {
          const yk = tile[at + 64 + k];
          const yhat = c !== 1 ? components[1].coeffs[offset + k] * components[1].quant[k] / quantScale : yk;
          const prediction = c === 0 ? (k ? fx / 84 * yhat : 0) : c === 2 ? (k ? fb / 84 * yhat : 0) + ${correction} : 0;
          const coefficient = tile[at + c * 64 + k] - prediction;
          const value = coefficient * quantScale / components[c].quant[k];
          const threshold = k && c === 1 ? 0.5 + strength * ((k & 7) >= 4 || (k >> 3) >= 4 ? 0.14 : 0.08) : 0.5;
          components[c].coeffs[offset + k] = Math.abs(value) < threshold ? 0 : Math.round(value);
        }`;
  const sources = {}, encoders = {};
  for (const variant of ['base', 'ac', 'full']) {
    const root = join(out, 'source', variant); mkdirSync(root, {recursive: true}); sources[variant] = {};
    for (const [path, original] of modules) {
      const name = relative(source, path); assert.ok(!name.startsWith('..'));
      let text = original;
      if (name === 'photo-xyb.mjs' && variant !== 'base') {
        assert.equal(text.split(old).length, 2, 'The producer changed: review the experiment before replay.');
        text = text.replace(old, changed(variant === 'full' ? '(yhat - yk)' : '(k ? yhat - yk : 0)'));
      }
      const target = join(root, name); mkdirSync(dirname(target), {recursive: true}); writeFileSync(target, text);
      sources[variant][name] = hash(text);
    }
    encoders[variant] = (await import(pathToFileURL(join(root, 'photo.mjs')))).encodePhoto;
    assert.equal((await import(pathToFileURL(join(root, 'kernels.mjs')))).configureKernels('auto'), 'simd');
  }
  const manifestBytes = readFileSync(manifestPath), photos = JSON.parse(manifestBytes).filter(photo =>
    ['phone-flower-crop', 'photo-keong', 'photo-ria', 'photo-bliznaca'].includes(photo.id));
  assert.equal(photos.length, 4);
  const receipt = {complete: false, node: process.version, sources, corpusSha256: hash(manifestBytes),
    programSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
    toolHashes: Object.fromEntries(Object.entries({djxl, oxide, ssimulacra2, butteraugli}).map(([name, path]) => [name, hash(readFileSync(path))])),
    protocol: 'Four fixed photographs, qualities 60/75/90, effort 1, unchanged routing/filter/quantization. AC variant reconstructs luma before subtracting AC chroma predictions; full also corrects the B-Y DC residual. Matched uses an eight-step quality search inside q +/- 4 and retains the highest tested fitting quality. No timing, monotonicity or global-optimum claim.',
    observations: {screen: [], matched: []}};
  const save = () => writeFileSync(join(out, 'photo-cfl.json'), JSON.stringify(receipt, null, 2) + '\n');
  save();
  function score(photo, rgba, bytes, stem) {
    writeFileSync(stem + '.jxl', bytes);
    command(djxl, [stem + '.jxl', stem + '.png', '--num_threads=1', '--quiet']);
    command(oxide, [stem + '.jxl', '-o', stem + '-oxide.png', '-f', 'png8', '-j', '1', '-q']);
    const a = readPng(readFileSync(stem + '.png')), b = readPng(readFileSync(stem + '-oxide.png'));
    for (const image of [a, b]) { assert.equal(image.width, photo.width); assert.equal(image.height, photo.height); }
    let maxDifference = 0;
    for (let i = 0; i < rgba.length; i++) {
      if (i % 4 === 3) { assert.equal(a.rgba[i], rgba[i]); assert.equal(b.rgba[i], rgba[i]); }
      else maxDifference = Math.max(maxDifference, Math.abs(a.rgba[i] - b.rgba[i]));
    }
    assert.ok(maxDifference <= 1, 'The independent decoder pixels disagree.');
    const reference = join(corpus, photo.png);
    return {bytes: bytes.length, sha256: hash(bytes), decodedSha256: hash(a.rgba), maxDecoderDifference: maxDifference,
      ssimulacra2: Number(command(ssimulacra2, [reference, stem + '.png']).trim()),
      butteraugli: Number(command(butteraugli, [reference, stem + '.png']).trim().split(/\s+/)[0])};
  }
  for (const stage of ['screen', 'matched']) {
    const stageDir = join(out, stage); mkdirSync(stageDir, {recursive: true});
    const variants = stage === 'screen' ? ['base', 'ac', 'full'] : ['base', 'ac'];
    for (const photo of photos) {
      const rgba = new Uint8Array(readFileSync(join(corpus, photo.pixels))); assert.equal(hash(rgba), photo.rgbaHash);
      for (const quality of [60, 75, 90]) {
        const row = {id: photo.id, width: photo.width, height: photo.height, quality, inputSha256: photo.rgbaHash};
        const base = encoders.base(rgba, photo.width, photo.height, {quality, effort: 1});
        for (const variant of variants) {
          let q = quality, bytes = base, observations;
          if (variant !== 'base') {
            if (stage === 'screen') bytes = encoders[variant](rgba, photo.width, photo.height, {quality: q, effort: 1});
            else {
              observations = []; let lower = Math.max(1, quality - 4), upper = Math.min(99, quality + 4), best;
              const trial = value => {
                const b = encoders[variant](rgba, photo.width, photo.height, {quality: value, effort: 1}); observations.push({quality: value, bytes: b.length});
                if (b.length <= base.length && (!best || value > best.quality)) best = {quality: value, bytes: b};
                return b.length;
              };
              trial(lower); trial(quality); trial(upper);
              for (let k = 0; k < 8; k++) { const mid = (lower + upper) / 2; if (trial(mid) <= base.length) lower = mid; else upper = mid; }
              assert.ok(best); q = best.quality; bytes = best.bytes;
            }
          }
          row[variant] = {quality: q, ...score(photo, rgba, bytes, join(stageDir, `${photo.id}-q${quality}-${variant}`)), ...(observations ? {observations} : {})};
        }
        for (const variant of variants.filter(v => v !== 'base')) row[variant].delta = {bytes: row[variant].bytes - row.base.bytes,
          ssimulacra2: row[variant].ssimulacra2 - row.base.ssimulacra2, butteraugli: row[variant].butteraugli - row.base.butteraugli};
        assert.equal(hash(rgba), photo.rgbaHash); receipt.observations[stage].push(row); save();
        console.log(JSON.stringify({stage, id: photo.id, quality, ...Object.fromEntries(variants.filter(v => v !== 'base').map(v => [v, row[v].delta]))}));
      }
    }
  }
  receipt.complete = true; save(); console.log(JSON.stringify(summarize(receipt), null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
