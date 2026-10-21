// SPDX-License-Identifier: MIT
// Bounded arithmetic proposals from the two Argon reviews, in isolated source graphs.
// node photo-argon.mjs SOURCE MANIFEST OUT DJXL OXIDE SSIMULACRA2 BUTTERAUGLI
// node photo-argon.mjs --match OUT tail,x,half,quarter
// node photo-argon.mjs --summarize RECEIPT
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {resolve, join, dirname, relative} from 'node:path';
import {readPng, writePng} from './image-io.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const variants = ['base', 'tail', 'x', 'half', 'quarter', 'epf2'];
const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
const command = (tool, args) => execFileSync(tool, args, {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']});

export function summarize(receipt) {
  assert.equal(receipt.complete, true);
  const result = {};
  for (const [stage, allRows] of Object.entries(receipt.observations)) for (const kind of ['photo', 'graphics']) {
    const rows = allRows.filter(row => row.kind === kind);
    for (const variant of variants.slice(1)) {
      const pairs = rows.filter(row => row[variant]);
      if (!pairs.length) continue;
      const ds = pairs.map(row => row[variant].delta);
      result[`${stage}-${kind}-${variant}`] = {pairs: pairs.length,
        meanBytePercent: mean(pairs.map(row => 100 * (row[variant].bytes / row.base.bytes - 1))),
        meanSsimulacra2: mean(ds.map(d => d.ssimulacra2)), meanButteraugli: mean(ds.map(d => d.butteraugli)),
        bothBetter: ds.filter(d => d.ssimulacra2 > 0 && d.butteraugli < 0).length,
        bothWorse: ds.filter(d => d.ssimulacra2 < 0 && d.butteraugli > 0).length,
        ssimulacra2Worse: ds.filter(d => d.ssimulacra2 < 0).length, butteraugliWorse: ds.filter(d => d.butteraugli > 0).length,
        byteIdentical: pairs.filter(row => row[variant].sha256 === row.base.sha256).length,
        maxByteHeadroom: Math.max(...pairs.map(row => row.base.bytes - row[variant].bytes))};
    }
  }
  return result;
}

// A declared synthetic graphics guard, not a photograph or a held-out camera source.
// Every edge is red against white: the current energy ratio is about 1.185, so both
// proposed thresholds change its route. Thin rules, pseudo-text and ramps stress color edges.
function graphicsControl() {
  const width = 500, height = 500, rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let level = 255;
    if (x >= 24 && x < 476 && y >= 24 && y < 72) level = 0;
    if (x >= 24 && x < 80 && y >= 92 && y < 476) level = ((y / 23 | 0) & 1) ? 0 : 96;
    if (x >= 104 && x < 472 && y >= 96 && y < 244) {
      const a = (x - 104) % 19, b = (y - 96) % 23;
      if (a < 2 || (b < 2 && a < 13) || (b >= 10 && b < 12 && a < 11)) level = 0;
    }
    if (x >= 104 && x < 472 && y >= 268 && y < 356) level = ((x - 104) * 255 / 367 | 0);
    if (x >= 104 && x < 472 && y >= 380 && y < 476 && ((x + 3 * y) % 29 < 3 || y % 17 === 0)) level = 0;
    const at = (y * width + x) * 4;
    rgba[at] = 255; rgba[at + 1] = level; rgba[at + 2] = level; rgba[at + 3] = 255;
  }
  return {id: 'saturated-red-graphics', kind: 'graphics', width, height, rgba};
}

function patchOnce(text, old, changed) {
  assert.equal(text.split(old).length, 2, 'Source shape changed: review the experiment before replay.');
  return text.replace(old, changed);
}
const scanImport = "import {ZIGZAG} from './jfif.mjs';\nconst SCAN = ZIGZAG.map(n => ((n & 7) << 3) | (n >> 3));\n";
const xybLoop = `        for (let c = 0; c < 3; c++) for (let k = 0; k < 64; k++) {
          const coefficient = tile[at + c * 64 + k] - (k && c !== 1 ? (c === 0 ? fx : fb) / 84 * tile[at + 64 + k] : 0);
          const value = coefficient * quantScale / components[c].quant[k];
          const threshold = k && c === 1 ? 0.5 + strength * ((k & 7) >= 4 || (k >> 3) >= 4 ? 0.14 : 0.08) : 0.5;
          components[c].coeffs[offset + k] = Math.abs(value) < threshold ? 0 : Math.round(value);
        }`;
const dctLoop = `      for (let c = 0; c < 3; c++) for (let k = 0; k < 64; k++) {
        const value = sums[c * 64 + k] * quantScale / components[c].quant[k];
        const threshold = k && c === 0 ? 0.5 + strength * ((k & 7) >= 4 || (k >> 3) >= 4 ? 0.14 : 0.08) : 0.5;
        components[c].coeffs[offset + k] = Math.abs(value) < threshold ? 0 : Math.round(value);
      }`;
function tailLoop(value) {
  return `
        for (let c = 0; c < 3; c++) {
          const coeffs = components[c].coeffs;
          let last = 63;
          while (last > 0 && coeffs[offset + SCAN[last]] === 0) last--;
          if (last > 4 && Math.abs(coeffs[offset + SCAN[last]]) === 1) {
            let zeros = 0;
            for (let j = last - 1; j > 0 && coeffs[offset + SCAN[j]] === 0; j--) zeros++;
            if (zeros >= 4) {
              const k = SCAN[last], value = ${value};
              if (Math.abs(value) < 0.68) coeffs[offset + k] = 0;
            }
          }
        }`;
}
function mutate(name, original, variant) {
  let text = original;
  if (variant === 'tail' && name === 'photo-xyb.mjs') {
    text = scanImport + patchOnce(text, xybLoop, xybLoop + tailLoop('(tile[at + c * 64 + k] - (c !== 1 ? (c === 0 ? fx : fb) / 84 * tile[at + 64 + k] : 0)) * quantScale / components[c].quant[k]'));
  }
  if (variant === 'tail' && name === 'photo-dct.mjs') text = scanImport + patchOnce(text, dctLoop, dctLoop + tailLoop('sums[c * 64 + k] * quantScale / components[c].quant[k]'));
  if (variant === 'x' && name === 'photo-xyb.mjs') {
    text = scanImport + 'const SCAN_RANK = Uint8Array.from({length: 64}, (_, k) => SCAN.indexOf(k));\n' + text;
    text = patchOnce(text, '[1, 0, 5][c]', '[2.2, 0, 5][c]');
    text = patchOnce(text,
      'const threshold = k && c === 1 ? 0.5 + strength * ((k & 7) >= 4 || (k >> 3) >= 4 ? 0.14 : 0.08) : 0.5;',
      'const threshold = k && c === 1 ? 0.5 + strength * ((k & 7) >= 4 || (k >> 3) >= 4 ? 0.14 : 0.08) : k && SCAN_RANK[k] > 16 ? 0.5 + 0.06 * strength : 0.5;');
  }
  if ((variant === 'half' || variant === 'quarter') && name === 'photo-xyb.mjs') {
    const shift = variant === 'half' ? 1 : 2;
    text = patchOnce(text, 'cb = 256 * blue - y, cr = 256 * r - y', `cb = (256 * blue - y) >> ${shift}, cr = (256 * r - y) >> ${shift}`);
  }
  if (variant === 'epf2' && name === 'photo-xyb.mjs') text = patchOnce(text, '? 20 * distance : 0', '? 40 * distance : 0');
  // This is a scratch copy of the writer. Production frame.mjs belongs to the format owner.
  if (variant === 'epf2' && name === 'frame.mjs') text = patchOnce(text,
    'w.write(2, 1);  // one edge-preserving filter iteration', 'w.write(2, 2);  // experimental two edge-preserving filter iterations');
  return text;
}

async function loadEncoders(out) {
  const encoders = {};
  for (const variant of variants) {
    const root = join(out, 'source', variant);
    const {encodePhoto} = await import(pathToFileURL(join(root, 'photo.mjs')));
    const {preferXYB} = await import(pathToFileURL(join(root, 'photo-xyb.mjs')));
    assert.equal((await import(pathToFileURL(join(root, 'kernels.mjs')))).configureKernels('auto'), 'simd');
    encoders[variant] = {encode: encodePhoto, preferXYB};
  }
  return encoders;
}

async function main() {
  if (process.argv[2] === '--summarize') { console.log(JSON.stringify(summarize(JSON.parse(readFileSync(process.argv[3], 'utf8'))), null, 2)); return; }
  const matching = process.argv[2] === '--match';
  let out, receipt;
  if (matching) {
    out = resolve(process.argv[3]); receipt = JSON.parse(readFileSync(join(out, 'photo-argon.json'), 'utf8'));
    assert.equal(receipt.complete, true); receipt.complete = false;
    receipt.matchedVariants = process.argv[4].split(',');
    assert.ok(receipt.matchedVariants.every(v => variants.includes(v) && v !== 'base'));
  } else {
    const [sourceArg, manifestArg, outArg, djxl, oxide, ssimulacra2, butteraugli] = process.argv.slice(2);
    assert.ok(sourceArg && manifestArg && outArg && djxl && oxide && ssimulacra2 && butteraugli);
    const source = resolve(sourceArg), manifest = resolve(manifestArg); out = resolve(outArg);
    const graph = new Map();
    const visit = path => {
      if (graph.has(path)) return;
      const text = readFileSync(path, 'utf8'); graph.set(path, text);
      for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*)(['"])(\.[^'"]+\.mjs)\1/g)) visit(resolve(dirname(path), m[2]));
    };
    visit(join(source, 'photo.mjs')); visit(join(source, 'kernels.mjs'));
    const sources = {};
    for (const variant of variants) {
      sources[variant] = {};
      for (const [path, original] of graph) {
        const name = relative(source, path); assert.ok(!name.startsWith('..'));
        const target = join(out, 'source', variant, name), text = mutate(name, original, variant);
        mkdirSync(dirname(target), {recursive: true}); writeFileSync(target, text); sources[variant][name] = hash(text);
      }
    }
    const corpus = dirname(manifest), manifestBytes = readFileSync(manifest);
    const photos = JSON.parse(manifestBytes).filter(photo => ['phone-flower-crop', 'photo-keong', 'photo-ria', 'photo-bliznaca'].includes(photo.id))
      .map(photo => ({id: photo.id, kind: 'photo', width: photo.width, height: photo.height,
        pixels: join(corpus, photo.pixels), png: join(corpus, photo.png), rgbaHash: photo.rgbaHash}));
    assert.equal(photos.length, 4);
    const control = graphicsControl(), png = writePng(control.width, control.height, control.rgba);
    writeFileSync(join(out, 'graphics.rgba'), control.rgba); writeFileSync(join(out, 'graphics.png'), png);
    photos.push({id: control.id, kind: control.kind, width: control.width, height: control.height,
      pixels: join(out, 'graphics.rgba'), png: join(out, 'graphics.png'), rgbaHash: hash(control.rgba)});
    for (const photo of photos) {
      const bytes = readFileSync(photo.png), image = readPng(bytes); photo.pngSha256 = hash(bytes);
      assert.equal(image.width, photo.width); assert.equal(image.height, photo.height); assert.equal(hash(image.rgba), photo.rgbaHash);
    }
    const tools = {djxl, oxide, ssimulacra2, butteraugli};
    receipt = {complete: false, node: process.version, sources, manifestSha256: hash(manifestBytes), inputs: photos, tools,
      toolHashes: Object.fromEntries(Object.entries(tools).map(([key, path]) => [key, hash(readFileSync(path))])), runs: [],
      protocol: 'Four fixed real photographs and one declared synthetic saturated red graphics control; qualities 60/75/90, effort 1, SIMD. Isolated source variants, no production edits and no timing claim. Tail removes only a final magnitude-one AC after >=4 zeros when original magnitude<0.68, using actual transposed zigzag, in both photo producers. X changes ramp1->2.2 and both chroma deadzones to 0.5+0.06*strength above scanindex16. Half/quarter apply proposed integer chroma shifts to routing only. EPF2 uses two iterations at40*distance versus current one at20. Equal-byte followup retains highest tested fitting quality after9 local bisection steps inside q+/-8; extends bracket to1 or99.9 only when needed. No monotonicity/global-optimum claim.',
      observations: {screen: [], matched: []}, scores: {}};
  }
  receipt.runs.push({stage: matching ? 'matched' : 'screen', programSha256: hash(readFileSync(fileURLToPath(import.meta.url)))});
  const save = () => writeFileSync(join(out, 'photo-argon.json'), JSON.stringify(receipt, null, 2) + '\n');
  save();
  const encoders = await loadEncoders(out), {djxl, oxide, ssimulacra2, butteraugli} = receipt.tools;
  const stage = matching ? 'matched' : 'screen', selected = matching ? receipt.matchedVariants : variants.slice(1);
  const stageDir = join(out, stage); mkdirSync(stageDir, {recursive: true});
  function score(photo, rgba, bytes, stem) {
    const digest = hash(bytes), key = photo.rgbaHash + ':' + digest;
    if (receipt.scores[key]) return {...receipt.scores[key], reusedDecode: true};
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
    assert.ok(maxDifference <= 1);
    const result = {bytes: bytes.length, sha256: digest, decodedSha256: hash(a.rgba), maxDecoderDifference: maxDifference,
      ssimulacra2: Number(command(ssimulacra2, [photo.png, stem + '.png']).trim()),
      butteraugli: Number(command(butteraugli, [photo.png, stem + '.png']).trim().split(/\s+/)[0])};
    assert.ok(Number.isFinite(result.ssimulacra2) && Number.isFinite(result.butteraugli));
    receipt.scores[key] = result; return result;
  }
  for (const photo of receipt.inputs) {
    const rgba = new Uint8Array(readFileSync(photo.pixels)); assert.equal(hash(rgba), photo.rgbaHash);
    for (const quality of [60, 75, 90]) {
      const row = {id: photo.id, kind: photo.kind, width: photo.width, height: photo.height, quality, inputSha256: photo.rgbaHash};
      const base = encoders.base.encode(rgba, photo.width, photo.height, {quality, effort: 1});
      row.base = {quality, xyb: encoders.base.preferXYB(rgba, photo.width, photo.height), ...score(photo, rgba, base, join(stageDir, `${photo.id}-q${quality}-base`))};
      for (const variant of selected) {
        let q = quality, bytes = encoders[variant].encode(rgba, photo.width, photo.height, {quality, effort: 1}), observations;
        if (matching && hash(bytes) !== row.base.sha256) {
          observations = []; let lower = Math.max(1, quality - 8), upper = Math.min(99.9, quality + 8), best;
          const trial = value => {
            const b = encoders[variant].encode(rgba, photo.width, photo.height, {quality: value, effort: 1}); observations.push({quality: value, bytes: b.length});
            if (b.length <= base.length && (!best || value > best.quality)) best = {quality: value, bytes: b};
            return b.length;
          };
          if (trial(lower) > base.length) { lower = 1; trial(lower); }
          trial(quality);
          if (trial(upper) <= base.length && upper < 99.9) { upper = 99.9; trial(upper); }
          for (let k = 0; k < 9; k++) { const mid = (lower + upper) / 2; if (trial(mid) <= base.length) lower = mid; else upper = mid; }
          assert.ok(best, 'No fitting quality in the tested bracket.'); q = best.quality; bytes = best.bytes;
        }
        row[variant] = {quality: q, xyb: encoders[variant].preferXYB(rgba, photo.width, photo.height),
          ...score(photo, rgba, bytes, join(stageDir, `${photo.id}-q${quality}-${variant}`)), ...(observations ? {observations} : {})};
        row[variant].delta = {bytes: row[variant].bytes - row.base.bytes, ssimulacra2: row[variant].ssimulacra2 - row.base.ssimulacra2,
          butteraugli: row[variant].butteraugli - row.base.butteraugli};
      }
      assert.equal(hash(rgba), photo.rgbaHash); receipt.observations[stage].push(row); save();
      console.log(JSON.stringify({stage, id: photo.id, quality, ...Object.fromEntries(selected.map(v => [v, row[v].delta]))}));
    }
  }
  receipt.complete = true; save(); console.log(JSON.stringify(summarize(receipt), null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
