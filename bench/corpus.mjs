#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Build the benchmark corpus: download every source named in corpus-sources.json, check its SHA-256, decode it to
// straight RGBA8 and write raw pixels, a canonical PNG and a manifest. Derived images are generated from decoded
// pixels with exact arithmetic and checked by the SHA-256 of their RGBA bytes.
//
//   node bench/corpus.mjs --dir ~/jxl-corpus              download, verify and build (NODE_USE_ENV_PROXY=1 behind a proxy)
//   node bench/corpus.mjs --dir ~/jxl-corpus --groups kodak,ui
//   node bench/corpus.mjs --pin                          fill missing hashes in corpus-sources.json (maintainers)
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync, inflateRawSync} from 'node:zlib';
import {describe, readPng, sha256, writePng} from './image-io.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// Read one member of a ZIP archive held in memory (stored or deflated entries).
export function zipMember(zip, name) {
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('Not a ZIP archive');
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(at + 10), size = zip.readUInt32LE(at + 20), nameLength = zip.readUInt16LE(at + 28);
    const extra = zip.readUInt16LE(at + 30), comment = zip.readUInt16LE(at + 32), local = zip.readUInt32LE(at + 42);
    if (zip.toString('utf8', at + 46, at + 46 + nameLength) === name) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28), body = zip.subarray(start, start + size);
      if (method === 0) return body;
      if (method === 8) return inflateRawSync(body);
      throw new Error('Unsupported ZIP method ' + method + ' for ' + name);
    }
    at += 46 + nameLength + extra + comment;
  }
  throw new Error(name + ' is not in the archive');
}

async function download(url, attempts = 4) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, {headers: {'user-agent': 'rapier-jxl-bench/1.0 (corpus fetch)'}, redirect: 'follow'});
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) { last = error; await new Promise(done => setTimeout(done, 1000 * attempt)); }
  }
  throw new Error('Download failed for ' + url + ': ' + last.message);
}

// Fetch `url` into the cache once; return the cached bytes. A cached file with the wrong hash is fetched again.
async function cached(file, url, expected) {
  if (existsSync(file)) { const bytes = readFileSync(file); if (!expected || sha256(bytes) === expected) return bytes; }
  const bytes = await download(url);
  mkdirSync(dirname(file), {recursive: true}); writeFileSync(file, bytes);
  return bytes;
}

// Derived images. Integer arithmetic and IEEE square roots only, so every engine writes the same bytes.
const DERIVE = {
  // A soft circular alpha. `hidden` keeps the original colour where alpha is zero; otherwise that colour is cleared.
  vignette({width, height, rgba}, {hidden}) {
    const out = new Uint8Array(rgba.length);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4, dx = 2 * x + 1 - width, dy = 2 * y + 1 - height, r = Math.sqrt(dx * dx + dy * dy) / 2;
      const a = r > 200 ? 0 : r > 150 ? Math.round(255 * (200 - r) / 50) : 255;
      if (a || hidden) out.set(rgba.subarray(i, i + 3), i);
      out[i + 3] = a;
    }
    return {width, height, rgba: out};
  },
  // A rounded window with a 12-pixel shadow ramp; the screenshot outside it stays in the hidden colour.
  window({width, height, rgba}) {
    const out = new Uint8Array(rgba), margin = 48, radius = 24, ramp = 12;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const cx = Math.min(Math.max(x, margin + radius), width - 1 - margin - radius), cy = Math.min(Math.max(y, margin + radius), height - 1 - margin - radius);
      const inside = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy)) - radius;  // distance outside the rounded rectangle
      const inBox = x >= margin && x < width - margin && y >= margin && y < height - margin;
      out[(y * width + x) * 4 + 3] = inBox && inside <= 0 ? 255 : inside >= ramp ? 0 : Math.round(96 * (ramp - Math.max(inside, 0)) / ramp);
    }
    return {width, height, rgba: out};
  },
  // Random colour under a blocky alpha mask: the worst case for colour kept below zero alpha.
  noise(_, {width, height}) {
    const out = new Uint8Array(width * height * 4); let seed = 1381;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) >>> 24;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4, bx = x >> 4, by = y >> 4;
      out[i] = next(); out[i + 1] = next(); out[i + 2] = next(); out[i + 3] = (bx * 7 + by * 13 + bx * by) % 3 === 0 ? 0 : 255;
    }
    return {width, height, rgba: out};
  },
};

function parse(argv) {
  const options = {dir: null, sources: join(here, 'corpus-sources.json'), groups: null, pin: false};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') options.dir = resolve(argv[++i]);
    else if (argv[i] === '--sources') options.sources = resolve(argv[++i]);
    else if (argv[i] === '--groups') options.groups = argv[++i].split(',');
    else if (argv[i] === '--pin') options.pin = true;
    else throw new Error('Unknown option ' + argv[i]);
  }
  if (!options.dir && !options.pin) throw new Error('Use --dir DIRECTORY (or --pin)');
  options.dir ??= resolve('jxl-corpus-pin');
  return options;
}

export async function buildCorpus(options) {
  const document = JSON.parse(readFileSync(options.sources, 'utf8')), manifest = [], decoded = new Map(), pinned = [];
  const expect = (what, actual, expected, item) => {
    if (expected === null || expected === undefined) {
      if (!options.pin) throw new Error(what + ' for ' + item.id + ' has no pinned SHA-256; run with --pin and review the change');
      item.sha256 = actual; pinned.push(item.id + ' ' + actual); return;
    }
    if (actual !== expected) throw new Error(what + ' for ' + item.id + ' has SHA-256 ' + actual + ', expected ' + expected);
  };
  const remember = (group, item, image, extra) => {
    const {width, height, rgba} = image, id = item.id, facts = describe(width, height, rgba);
    decoded.set(id, image);
    mkdirSync(join(options.dir, 'rgba'), {recursive: true}); mkdirSync(join(options.dir, 'png'), {recursive: true});
    writeFileSync(join(options.dir, 'rgba', id + '.rgba'), rgba); writeFileSync(join(options.dir, 'png', id + '.png'), writePng(width, height, rgba));
    manifest.push({id, kind: group, group, width, height, rgbaHash: sha256(rgba), pixels: 'rgba/' + id + '.rgba', png: 'png/' + id + '.png', ...facts, ...extra});
  };
  for (const [group, spec] of Object.entries(document.groups)) {
    if (options.groups && !options.groups.includes(group)) continue;
    if (spec.local) {  // Inputs stored beside the tests.
      const file = resolve(here, '..', spec.local), rows = JSON.parse(readFileSync(file, 'utf8'));
      for (const row of rows) {
        const name = resolve(dirname(file), row.pixels), raw = existsSync(name) ? readFileSync(name) : gunzipSync(readFileSync(name + '.gz'));
        if (sha256(raw) !== row.rgbaHash) throw new Error(row.id + ' pixels do not match their recorded SHA-256');
        remember(group, {id: row.id}, {width: row.width, height: row.height, rgba: new Uint8Array(raw)}, {source: spec.local});
      }
      continue;
    }
    let archive = null;
    if (spec.archive) { archive = await cached(join(options.dir, 'downloads', group, 'archive.zip'), spec.archive.url, spec.archive.sha256); expect('Archive', sha256(archive), spec.archive.sha256, {id: group}); }
    // Downloads run four at a time; decoding follows in the listed order.
    const files = new Array(spec.items.length), pending = spec.items.map((item, k) => [item, k]).filter(([item]) => !item.derive);
    const workers = Array.from({length: 4}, async () => {
      for (let next; (next = pending.shift());) {
        const [item, k] = next;
        files[k] = archive ? zipMember(archive, item.member) : await cached(join(options.dir, 'downloads', group, item.id + '.png'), item.url, item.sha256);
      }
    });
    await Promise.all(workers);
    for (const [k, item] of spec.items.entries()) {
      if (item.derive) {
        const base = decoded.get(item.from) || (item.from && await sourceOf(document, item.from, options, decoded, remember, expect));
        const image = DERIVE[item.derive](base, item);
        expect('Derived pixels', sha256(image.rgba), item.sha256, item);
        remember(group, item, image, {derivedFrom: item.from || null, recipe: item.derive});
        continue;
      }
      expect('Download', sha256(files[k]), item.sha256, item);
      remember(group, item, readPng(files[k]), {source: item.url || spec.archive.url + '#' + item.member, sourceSha256: item.sha256});
    }
  }
  if (options.pin) { writeFileSync(options.sources, JSON.stringify(document, null, 2) + '\n'); console.error('Pinned ' + pinned.length + ' hashes'); }
  writeFileSync(join(options.dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

// A derived image may name a source in a group that was not requested; build that source first.
async function sourceOf(document, id, options, decoded, remember, expect) {
  for (const [group, spec] of Object.entries(document.groups)) {
    const item = spec.items.find(candidate => candidate.id === id && !candidate.derive);
    if (!item) continue;
    const bytes = spec.archive ? zipMember(await cached(join(options.dir, 'downloads', group, 'archive.zip'), spec.archive.url, spec.archive.sha256), item.member)
      : await cached(join(options.dir, 'downloads', group, id + '.png'), item.url, item.sha256);
    expect('Download', sha256(bytes), item.sha256, item);
    const image = readPng(bytes); decoded.set(id, image);
    return image;
  }
  throw new Error('No source image named ' + id);
}

if (process.argv[1] && import.meta.url === new URL('file://' + resolve(process.argv[1])).href) {
  const manifest = await buildCorpus(parse(process.argv.slice(2)));
  const bytes = manifest.reduce((n, row) => n + row.width * row.height * 4, 0);
  console.log(manifest.length + ' images, ' + (bytes / 1e6).toFixed(1) + ' MB of RGBA');
}
