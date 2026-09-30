// SPDX-License-Identifier: MIT
// Only returned codestreams reach the decoders. Native output is bounded by the admitted image dimensions.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {decoder} from './decoder.mjs';

export function rgbaOf(image) {
  const {width, height, channels: c, data: d} = image, out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    out[i * 4] = d[i * c];
    out[i * 4 + 1] = c >= 3 ? d[i * c + 1] : d[i * c];
    out[i * 4 + 2] = c >= 3 ? d[i * c + 2] : d[i * c];
    out[i * 4 + 3] = c === 4 ? d[i * 4 + 3] : c === 2 ? d[i * 2 + 1] : 255;
  }
  return out;
}

export async function oracles() {
  const oxide = await decoder();
  assert.ok(oxide, 'Install jxl-oxide-wasm@0.12.6 to run conformance');
  assert.match(oxide.version, /(?:^|\D)0\.12\.6(?:$|\D)/, 'Conformance requires jxl-oxide 0.12.6');
  const ffmpeg = process.env.JXL_FUZZ_FFMPEG || 'ffmpeg';
  const available = spawnSync(ffmpeg, ['-hide_banner', '-decoders'], {encoding: 'utf8'});
  const native = available.status === 0 && /\blibjxl\b/.test(available.stdout);
  if (process.env.JXL_FUZZ_REQUIRE_NATIVE === '1') assert.ok(native, 'The required native libjxl decoder is unavailable in ffmpeg');
  return {
    names: ['jxl-oxide ' + oxide.version, ...(native ? ['ffmpeg/libjxl'] : [])],
    native,
    decode(bytes, width, height, name, exact) {
      const image = oxide(bytes);
      assert.equal(image.width, width, name + ': oxide width');
      assert.equal(image.height, height, name + ': oxide height');
      const rgba = rgbaOf(image);
      if (exact) assert.deepEqual(rgba, exact, name + ': oxide changed lossless pixels');
      if (native) {
        const output = spawnSync(ffmpeg, ['-v', 'error', '-threads', '1', '-f', 'image2pipe', '-c:v', 'libjxl', '-i', 'pipe:0', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-threads', '1', 'pipe:1'], {
          input: bytes, maxBuffer: width * height * 4 + 65536, timeout: 30000,
        });
        assert.ifError(output.error);
        assert.equal(output.status, 0, name + ': libjxl refused output: ' + output.stderr.toString());
        assert.equal(output.stdout.length, width * height * 4, name + ': libjxl returned incomplete pixels');
        if (exact) assert.deepEqual(new Uint8Array(output.stdout), exact, name + ': libjxl changed lossless pixels');
      }
      return rgba;
    },
  };
}
