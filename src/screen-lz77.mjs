// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';
import {BitWriter, packSigned} from './bits.mjs';
import {buildCode, writePrefixCode, uintConfig, hybridToken} from './prefix.mjs';
import {ALPHABET, LZ77, RESIDUAL_CONFIG, leaf} from './modular.mjs';
import {kernelHooks, ensured, missing, declined} from './kernel-hooks.mjs';

const SCREEN_DISTANCE_CONFIG = /* @__PURE__ */ uintConfig(4), SCREEN_HASH_SIZE = 65536;
export const screenLZ77 = 1;

export function screenResiduals(plane, width, height, predictor) {
  const out = new Uint32Array(width * height);
  for (let y = 0, i = 0; y < height; y++)
    for (let x = 0; x < width; x++, i++) {
      let pred = 0;
      if (predictor !== 0) {
        const left = x ? plane[i - 1] : y ? plane[i - width] : 0, top = y ? plane[i - width] : left;
        if (predictor === 1) pred = left;
        else if (predictor === 2) pred = top;
        else if (predictor === 3) pred = ((left + top) / 2) | 0;
        else if (predictor === 5) {
          const tl = x && y ? plane[i - width - 1] : left, g = left + top - tl;
          pred = Math.max(Math.min(left, top), Math.min(Math.max(left, top), g));
        } else throw fault('JXL_INTERNAL', 'screen-lz77:predictor ' + predictor);
      }
      out[i] = packSigned(plane[i] - pred);
    }
  return out;
}

export function screenMatches(values, emit, depth = 4, minLength = 7, state = null, work = Infinity) {
  if (!state) {
    const chain = values.length < SCREEN_HASH_SIZE * (depth - 1);
    state = {i: 0, phase: 0, length: 0, distance: 0, probe: 0, at: -1, span: 0, inserted: 0,
      head: chain ? new Int32Array(SCREEN_HASH_SIZE).fill(-1) : null,
      history: new Int32Array(chain ? values.length : SCREEN_HASH_SIZE * depth).fill(-1)};
  }
  const {head, history} = state;
  const hash = i =>
    (Math.imul(values[i] + 1, 0x1e35a7bd) ^
      Math.imul(values[i + 1] + 1, 0x6c8e9cf5) ^
      Math.imul(values[i + 2] + 1, 0x2c1b3c6d)) >>> 16;
  while (state.i < values.length && work > 0) {
    const i = state.i;
    if (!state.phase) {
      state.length = 0; state.distance = 0; state.probe = 0; state.span = 0;
      if (i + minLength <= values.length) {
        const h = hash(i); state.bucket = h * depth; state.at = head ? head[h] : history[state.bucket]; state.phase = 1;
      } else state.phase = 2;
    }
    if (state.phase === 1) {
      if (state.probe >= depth || state.at < 0) { state.phase = 2; continue; }
      const at = state.at;
      if (!state.span) {
        work--;
        if (values[at] !== values[i] || values[at + 1] !== values[i + 1] || values[at + 2] !== values[i + 2]) {
          state.probe++; state.at = head ? history[at] : history[state.bucket + state.probe]; continue;
        }
        state.span = 3;
      }
      let k = state.span;
      const end = Math.min(values.length - i, k + work);
      while (k < end && values[at + k] === values[i + k]) k++;
      work -= k - state.span; state.span = k;
      if (i + k < values.length && k === end) continue;
      if (k > state.length) { state.length = k; state.distance = i - at; }
      if (i + k === values.length) state.phase = 2;
      else { state.probe++; state.at = head ? history[at] : history[state.bucket + state.probe]; state.span = 0; }
    } else if (state.phase === 2) {
      if (state.length < minLength) { state.length = 0; state.distance = 0; }
      emit(state.length ? 0 : values[i], state.length, state.distance);
      state.inserted = 0; state.phase = 3;
    } else if (state.phase === 3) {
      const count = state.length || 1, end = Math.min(count, state.inserted + work), from = state.inserted;
      for (let k = from; k < end; k++) if (i + k + 2 < values.length) {
        const h = hash(i + k);
        if (head) { history[i + k] = head[h]; head[h] = i + k; }
        else { const first = h * depth; for (let n = depth - 1; n > 0; n--) history[first + n] = history[first + n - 1]; history[first] = i + k; }
      }
      work -= end - from; state.inserted = end;
      if (end === count) { state.i += count; state.phase = 0; }
    }
  }
  return state;
}

export function screenModel(plane, width, height, depth = 4, minLength = 7, predictors = [0, 1, 2, 5]) {
  let best;
  const maxN = width * height;
  for (const predictor of predictors) {
    const pVal = new Int32Array(maxN), pDist = new Int32Array(maxN), freqs = new Uint32Array(ALPHABET), distances = new Uint32Array(64), token = [0, 0, 0];
    let raw = 0, m = 0;
    const count = (config, value, target, base = 0) => {
      hybridToken(config, value, token); target[base + token[0]]++; raw += token[1];
    };
    const emit = (value, length, distance) => {
      if (length) {
        pVal[m] = length - minLength; pDist[m++] = distance;
        count(LZ77.lengthConfig, length - minLength, freqs, LZ77.minSymbol);
        count(SCREEN_DISTANCE_CONFIG, distance === 1 ? 1 : distance + 119, distances);
      } else {
        pVal[m] = value; pDist[m++] = 0;
        count(RESIDUAL_CONFIG, value, freqs);
      }
    };
    if (width && height) {
      if (depth > 0) {
        if (!(kernelHooks.screen ?? ensured().screen ?? missing())(plane, width, height, predictor, depth, emit, minLength)) throw declined('screen');
      } else {
        const res = screenResiduals(plane, width, height, predictor);
        for (let i = 0; i < maxN;) {
          if (res[i] === 0) {
            let end = i + 1;
            while (end < maxN && res[end] === 0) end++;
            if (end - i > minLength) { emit(0, 0, 0); emit(0, end - i - 1, 1); i = end; continue; }
          }
          emit(res[i++], 0, 0);
        }
      }
    }
    const code = buildCode(freqs), distance = buildCode(distances), writer = new BitWriter(256);
    writePrefixCode(writer, code); writePrefixCode(writer, distance);
    let bits = writer.bitLength + raw;
    for (let s = 0; s < freqs.length; s++) if (freqs[s]) bits += freqs[s] * code.lengths[s];
    for (let s = 0; s < distances.length; s++) if (distances[s]) bits += distances[s] * distance.lengths[s];
    if (!best || bits < best.bits) {
      const node = Object.assign(leaf(predictor), {local: 0});
      best = {
        kind: 'index', tree: node, leaves: [node], classes: 1, width, height, minimum: minLength,
        count: m, pieceValue: pVal.subarray(0, m), pieceDistance: pDist.subarray(0, m), pieceContext: new Uint8Array(m),
        leaf: node, code, distances, bits, minLength, get pieces() { return Array.from({length: m * 2}, (_, i) => (i & 1 ? pDist : pVal)[i >> 1]); }
      };
    }
  }
  return best;
}
