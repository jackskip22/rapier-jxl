// SPDX-License-Identifier: MIT
// Reproduce the pinned wasm-vips 4K queue result, including a possible third-encode failure.
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readPng, sha256} from '../image-io.mjs';

const tools = resolve(process.argv[2] || '../bench-tools');
const out = resolve(process.argv[3] || '/tmp/vips-queue.json');
const input = resolve('bench/capture/fixtures/snapdom-opaque-3840x2160.png');
const {rgba, width, height} = readPng(readFileSync(input));
const {default: Vips} = await import(pathToFileURL(resolve(tools, 'vips/lib/vips-node.mjs')));
const vips = await Vips({dynamicLibraries: ['vips-jxl.wasm']});
vips.concurrency(1); vips.Cache.max(0);
const report = {package: 'wasm-vips 0.0.19', node: process.version, width, height, rgbaSHA256: sha256(rgba),
  settings: {Q: 100, effort: 7, lossless: true, keep: 'none', concurrency: 1, cacheMax: 0},
  note: 'Fresh process, four sequential attempts with 10ms event-loop yields; both vips images deleted after each. A failure is preserved, not interpreted as a proven cause. RSS is whole process including input/runtime.', rows: []};
try {
  for (let attempt = 1; attempt <= 4; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    const row = {attempt, rssBefore: process.memoryUsage().rss, vipsMemoryBefore: vips.Stats.mem(), cacheEntriesBefore: vips.Cache.size()};
    const raw = vips.Image.newFromMemory(rgba, width, height, 4, 'uchar');
    const image = raw.copy({interpretation: 'srgb'});
    const start = performance.now();
    try {
      const bytes = image.jxlsaveBuffer({Q: 100, effort: 7, lossless: true, keep: 'none'});
      Object.assign(row, {status: 'measured', ms: performance.now() - start, bytes: bytes.length, sha256: sha256(bytes)});
    } catch (error) {
      Object.assign(row, {status: 'failed', ms: performance.now() - start, error: String(error.message)});
    } finally {
      image.delete(); raw.delete();
    }
    Object.assign(row, {rssAfter: process.memoryUsage().rss, vipsMemoryAfter: vips.Stats.mem(), peakRSSKiB: process.resourceUsage().maxRSS});
    report.rows.push(row);
    writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(row));
    if (row.status !== 'measured') break;
  }
} finally {vips.shutdown();}
process.exit(0);
