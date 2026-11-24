// SPDX-License-Identifier: MIT
import {BitWriter} from './bits.mjs';
import {fault} from './admit.mjs';
import {readFrames, writeRetimedHeader, writeRetimedFrame, copyBits} from './framing.mjs';

function shared({codestream, image}) {
  const w = new BitWriter(256);
  copyBits(w, codestream, 0, image.animationAt);
  copyBits(w, codestream, image.depthAt, image.modular16At);
  copyBits(w, codestream, image.modular16At + 1, image.payloadEnd);
  return w.bitLength + ':' + w.finish().join(',');
}

function growable() {
  for (let most = 2 ** 34; ; most /= 2) {
    try { return new ArrayBuffer(0, {maxByteLength: most}); }
    catch (error) { if (!(error instanceof RangeError) || most <= 2 ** 26) throw fault('JXL_MEMORY', 'video: output buffer'); }
  }
}

export function windowJoin(loops) {
  let buffer = null, at = 0, key, clock, modular16At = -1, total = 0, given = 0;
  const append = bytes => {
    if (at + bytes.length > buffer.maxByteLength) throw fault('JXL_MEMORY', 'video: output past the host buffer limit');
    buffer.resize(at + bytes.length);
    new Uint8Array(buffer).set(bytes, at); at += bytes.length;
  };
  return {
    add(bytes, last) {
      const window = readFrames(bytes, {}), {codestream, image, frames} = window;
      if (window.level !== 5) throw fault('JXL_INTERNAL', 'animation-join:level');
      const {numerator, denominator} = image.animation, w = new BitWriter(bytes.length + 64 + 8 * frames.length);
      if (!buffer) {
        buffer = growable(); key = shared(window); clock = {numerator, denominator};
        modular16At = writeRetimedHeader(w, codestream, image, {numerator, denominator, loops}, image.modular16);
        if (!image.modular16) modular16At = -1;
      } else if (shared(window) !== key) throw fault('JXL_INPUT', 'video: transparency or colors change after its first frames; pass decoded frames');
      if (!image.modular16 && modular16At >= 0) {
        const byte = modular16At >> 3;
        if (byte < at) new Uint8Array(buffer)[byte] &= ~(1 << (modular16At & 7));
        modular16At = -1;
      }
      const same = numerator === clock.numerator && denominator === clock.denominator;
      frames.forEach((frame, f) => {
        let duration = frame.duration;
        if (!same && duration) {
          total += duration * denominator / numerator * clock.numerator / clock.denominator;
          duration = Math.max(1, Math.round(total) - given);
        } else total += duration;
        given += duration;
        if (duration > 0xFFFFFFFE) throw fault('JXL_INTERNAL', 'animation-join:duration');
        writeRetimedFrame(w, codestream, frame, image, {duration, last: last && f === frames.length - 1});
      });
      append(w.finish());
    },
    finish() {
      const fixed = typeof buffer.transferToFixedLength === 'function' ? buffer.transferToFixedLength(at) : buffer;
      return new Uint8Array(fixed, 0, at);
    }};
}
