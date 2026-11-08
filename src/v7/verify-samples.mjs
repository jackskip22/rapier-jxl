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

export function sampleView(bytes,Type) {
  if (Type === Uint8Array) return bytes;
  const size = Type.BYTES_PER_ELEMENT, length = bytes.length / size;
  const at = (n,fallback) => n === undefined ? fallback : (n = Math.trunc(n) || 0) < 0 ? Math.max(0,length + n) : Math.min(length,n);
  const subarray = (from,to) => {
    from = at(from,0); to = Math.max(from,at(to,length));
    let part = bytes.subarray(from * size,to * size);
    if (part.byteOffset % size) part = part.slice();
    return new Type(part.buffer,part.byteOffset,part.byteLength / size);
  };
  const known = {length,byteLength:bytes.length,byteOffset:0,BYTES_PER_ELEMENT:size,constructor:Type,subarray,then:undefined};
  return new Proxy(new Type(0),{get:(_,key) => Object.hasOwn(known,key) ? known[key]
    : key === Symbol.toStringTag ? Type.name : typeof key === 'symbol' && Symbol.keyFor(key)?.startsWith('rapier-jxl.journal') ? undefined
    : (all => { const value = Reflect.get(all,key); return typeof value === 'function' ? value.bind(all) : value; })(subarray()),
    getPrototypeOf:() => Type.prototype});
}
