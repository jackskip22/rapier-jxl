// SPDX-License-Identifier: MIT
// Optional upstream oracle. Setting its path opts in; a broken configured decoder is never a skip.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {nativeDecoder} from './native-decoder.mjs';

export function jxlRsDecoder({executable = process.env.JXL_FUZZ_JXL_RS} = {}) {
  if (!executable) {
    assert.notEqual(process.env.JXL_FUZZ_REQUIRE_JXL_RS, '1', 'The required jxl-rs oracle is unavailable');
    return null;
  }
  const version = spawnSync(executable, ['--version'], {encoding: 'utf8', timeout: 30000, maxBuffer: 4096});
  assert.ifError(version.error);
  assert.equal(version.status, 0, 'jxl-rs version failed: ' + version.stderr);
  assert.match(version.stdout.trim(), /^rapier-jxl-rs-oracle \d+\.\d+\.\d+ [a-f0-9]{40}(?:\+[a-z][a-z0-9-]+)?$/, 'Build the pinned jxl-rs transport with RAPIER_JXL_RS_REVISION');
  return {
    version: version.stdout.trim().replace('rapier-jxl-rs-oracle ', 'jxl-rs '),
    executable,
    decode(bytes, width, height) {
      assert.ok(bytes instanceof Uint8Array && bytes.length > 0 && bytes.length <= 16777216, 'jxl-rs input bounds');
      assert.ok(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= 16384 && height <= 16384 && width * height <= 24000000, 'jxl-rs image bounds');
      const result = spawnSync(executable, ['--decode', String(width), String(height)], {
        input: bytes, timeout: 30000, maxBuffer: width * height * 4 + 65536, killSignal: 'SIGKILL',
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, 'jxl-rs refused output: ' + result.stderr.toString());
      assert.equal(result.stdout.length, width * height * 4, 'jxl-rs returned incomplete pixels');
      return new Uint8Array(result.stdout.buffer, result.stdout.byteOffset, result.stdout.byteLength);
    },
    // Same bounded framing as native libjxl; every request executes the upstream decoder afresh.
    persistent() { return nativeDecoder({executable}); },
  };
}

export function decoderDifference(actual, expected) {
  assert.equal(actual.length, expected.length, 'decoder output length');
  let rgb = 0, alpha = 0, maximum = 0;
  for (let i = 0; i < actual.length; i++) {
    const difference = Math.abs(actual[i] - expected[i]);
    if (!difference) continue;
    if (i % 4 === 3) alpha++; else { rgb++; maximum = Math.max(maximum, difference); }
  }
  return {rgb, alpha, maximum};
}
