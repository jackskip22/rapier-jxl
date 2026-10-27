// SPDX-License-Identifier: MIT
// Public, pinned benchmark tools. Linux x86_64; Node, Python and tar required.
// node bench/capture/setup.mjs /tmp/rapier-capture-tools
import {mkdirSync, readFileSync, writeFileSync, existsSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {readPng, writePng} from '../image-io.mjs';

const out = resolve(process.argv[2] || '/tmp/rapier-capture-tools');
mkdirSync(out, {recursive: true});
const downloads = [
  ['libjxl-v0.12.0.tar.lz', 'https://github.com/libjxl/libjxl/releases/download/v0.12.0/jxl-linux-x86_64-static.tar.lz', '5318a1ea40adad76d023e0c17a03d4627f8282f83cb2b575e69be8e74f1ff456', 'libjxl12', 'lzip'],
  ['libwebp-1.5.0.tar.gz', 'https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.5.0-linux-x86-64.tar.gz', 'f4bf49f85991f50e86a5404d16f15b72a053bb66768ed5cc0f6d042277cc2bb8', 'webp', 'strip'],
  ['oxipng-9.1.5.tar.gz', 'https://github.com/oxipng/oxipng/releases/download/v9.1.5/oxipng-9.1.5-x86_64-unknown-linux-musl.tar.gz', '571e69fcb06a3675fe247998d845619075631b01ac2246e8a88206c723a472e2', 'oxipng', 'strip'],
  ['jsquash-jxl-1.3.0.tgz', 'https://registry.npmjs.org/@jsquash/jxl/-/jxl-1.3.0.tgz', '737c6e4749213a46aab1a2b39aed5bc527e06f0390d3a4e337ed006c349a876b', 'jsquash', 'strip'],
  ['wasm-vips-0.0.19.tgz', 'https://registry.npmjs.org/wasm-vips/-/wasm-vips-0.0.19.tgz', '0bfec00056bc72e2d37b936e4836889885fb61c8f2dbe6d028d340bee4aa5ee1', 'vips', 'strip'],
  ['photo-keong.png', 'https://raw.githubusercontent.com/libjxl/testdata/73695d303670c90e4d506ea89d9901b081385089/external/wesaturate/500px/cvo9xd_keong_macan_srgb8.png', 'eb9189de8004dd0e56c5ccd8312567ae325bcef42861e2bfc86b064f4c4861b6'],
];
const hash = b => createHash('sha256').update(b).digest('hex');
for (const [name, url, expected, directory, kind] of downloads) {
  const file = resolve(out, name);
  if (!existsSync(file)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(url + ': ' + response.status);
    writeFileSync(file, new Uint8Array(await response.arrayBuffer()));
  }
  if (hash(readFileSync(file)) !== expected) throw new Error('SHA-256 mismatch: ' + name);
  if (directory) {
    mkdirSync(resolve(out, directory), {recursive: true});
    if (kind === 'lzip') execFileSync('python3', [resolve(dirname(fileURLToPath(import.meta.url)), 'unlzip.py'), file, resolve(out, directory)]);
    else execFileSync('tar', ['-xf', file, '-C', resolve(out, directory), '--strip-components=1']);
  }
}
const photo = readPng(readFileSync(resolve(out, 'photo-keong.png')));
writeFileSync(resolve(out, 'photo-keong-rgba.png'), writePng(photo.width, photo.height, photo.rgba));
const files = ['jsquash/codec/enc/jxl_enc.js', 'jsquash/codec/enc/jxl_enc.wasm', 'vips/lib/vips-es6.js', 'vips/lib/vips.wasm', 'vips/lib/vips-jxl.wasm'];
const payloads = files.map(file => { const b = readFileSync(resolve(out, file)); return {file, bytes: b.length, gzip: gzipSync(b, {level: 9}).length, sha256: hash(b)}; });
const receipt = {downloads: downloads.map(([file, url, sha256]) => ({file, url, sha256})), payloads,
  photographicInput: {file: 'photo-keong-rgba.png', width: photo.width, height: photo.height, rgbaSha256: hash(photo.rgba),
    note: 'Same decoded RGBA8 bytes as the pinned source, written without ICC/Exif/text metadata. All codecs receive the same sRGB samples and native encoders are not charged for source metadata JS never receives.'},
  packages: {jsquash: '1.3.0', wasmVips: '0.0.19', ...JSON.parse(readFileSync(resolve(out, 'vips/versions.json')))},
  native: {cjxl: execFileSync(resolve(out, 'libjxl12/tools/cjxl'), ['--version'], {encoding: 'utf8'}).trim(),
    cwebp: execFileSync(resolve(out, 'webp/bin/cwebp'), ['-version'], {encoding: 'utf8'}).trim(),
    oxipng: execFileSync(resolve(out, 'oxipng/oxipng'), ['--version'], {encoding: 'utf8'}).trim()},
  note: 'jSquash factory + its single-thread WASM, not decoders or optional multithread builds. Vips includes browser JS + base WASM + JXL side module, with dynamicLibraries restricted to JXL. Gzip level 9 per delivered file.'};
writeFileSync(resolve(out, 'toolchain.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({directory: out, payloads}));
