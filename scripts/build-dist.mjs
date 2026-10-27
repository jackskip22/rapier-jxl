// SPDX-License-Identifier: MIT
// Rebuild the published bundles from src. esbuild bundles, terser minifies.
// node scripts/build-dist.mjs
import {build} from '/tmp/jxl-build/node_modules/esbuild/lib/main.js';
import {readFileSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {gzipSync} from 'node:zlib';

const require = createRequire('/tmp/jxl-build/package.json');
const {minify} = require('/tmp/jxl-build/node_modules/terser');
const license = readFileSync(new URL('../LICENSE', import.meta.url), 'utf8').replace(/\s+/g, ' ').trim();
const banner = `/*! Rapier JXL 6.1.1 | MIT License ${license} */\n`;
const property = /^(alphabetSize|lengths|codes|simple|treeSelect|splitToken|msb|lsb|contextMap|histograms|predictor|multiplier|context|splitval|property|offset|left|right|channel|acc|pending|at|bitLength|grow|zeroPadToByte|writeU32|append|finish|write|small|large|totals|contexts|tokens|cost|bucketOf|contextOf|nonZero|zeroDensityOffset|thresholds|numDc|numCtxs|freqs|hshift|vshift|residual|component|inPlace|horizontal|beginC|numC|rctType|nbColors|nbDeltas|useGlobalTree|streamId|pieces|rect|minSymbol|minLength|lengthConfig|params|type|leaf|groupsX|groupsY|dcGroupsX|dcGroupsY|single|config|bits|sym|tree|count|parts|lz77|transforms)$/;

async function bundle({entry, outfile, format, footer}) {
  const result = await build({
    entryPoints: [entry], absWorkingDir: new URL('..', import.meta.url).pathname,
    bundle: true, format, platform: 'browser', write: false, legalComments: 'none',
    external: ['./gpu-core.mjs', 'node:zlib'],
    footer: footer ? {js: footer} : undefined,
  });
  const source = result.outputFiles[0].text;
  const min = await minify(source, {
    module: format === 'esm',
    compress: {passes: 2},
    mangle: {properties: {regex: property}},
    format: {comments: false},
  });
  if (!min.code) throw new Error('empty minify ' + outfile);
  writeFileSync(outfile, banner + min.code + (min.code.endsWith('\n') ? '' : '\n'));
  const raw = readFileSync(outfile);
  console.log(outfile, raw.length, gzipSync(raw, {level: 9}).length);
}

const root = new URL('..', import.meta.url).pathname;
await bundle({entry: root + 'scripts/still-boot.mjs', outfile: root + 'dist/rapier-still-worker.js', format: 'iife'});
await bundle({entry: root + 'scripts/full-boot.mjs', outfile: root + 'dist/rapier-worker.js', format: 'iife'});
await bundle({entry: root + 'src/rapier.mjs', outfile: root + 'dist/rapier.min.mjs', format: 'esm'});
await bundle({entry: root + 'src/gpu-core.mjs', outfile: root + 'dist/gpu-core.mjs', format: 'esm'});
await bundle({entry: root + 'src/image.mjs', outfile: root + 'dist/image.min.mjs', format: 'esm'});
await bundle({entry: root + 'src/jpeg.mjs', outfile: root + 'dist/jpeg.min.mjs', format: 'esm'});
