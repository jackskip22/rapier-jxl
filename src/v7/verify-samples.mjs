// SPDX-License-Identifier: MIT
import {typedName} from './bytes.mjs';
import {fail} from './primitives.mjs';

export function admitSampleKind(data, description = {}) {
  const kind = typedName.call(data), bytes = kind === 'Uint8Array' || kind === 'Uint8ClampedArray';
  const wide = kind === 'Uint16Array', half = kind === 'Float16Array', float = kind === 'Float32Array';
  const format = description.sampleFormat ?? (float ? 'float32' : half ? 'float16' : 'uint');
  const compatible = format === 'uint' ? bytes || wide : format === 'float16' ? wide || half : format === 'float32' && float;
  if (!compatible) throw fail('JXL_INPUT', 'Use uint with integer arrays, float16 with half-float storage or Uint16Array bits, or float32 with Float32Array.');
  const depth = description.bitDepth ?? (float ? 32 : wide || half ? 16 : 8);
  const validDepth = format === 'float32' ? depth === 32 : format === 'float16' ? depth === 16 : wide ? [10, 12, 16].includes(depth) : depth === 8;
  if (!validDepth) throw fail('JXL_INPUT', 'Bit depth: 8 for bytes; 10, 12 or 16 for Uint16Array; 16 or 32 for floats.');
  return kind;
}
