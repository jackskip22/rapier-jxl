// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';
export const SCORE_BAND_ROWS = 256;
const bandSourceRows = (y0, y1, height) => [Math.max(0, Math.floor(y0 / 64) * 64 - 192), Math.min(height, Math.ceil(y1 / 64) * 64 + 192)];

function capacity(width, height) {
  const w = Math.ceil(width / 8) * 8, h = Math.min(Math.ceil(height / 8) * 8, 384), p = w * h, blocks = p / 64;
  const tiles = Math.ceil(w / 64) * Math.ceil(h / 64), sourceBytes = 4 * width * Math.min(height, 640);
  return {sourceBytes, inputBytes: sourceBytes + 4 * p + 76 * blocks + 8 * tiles + 65536,
    outputBytes: 4 * width * Math.min(height, SCORE_BAND_ROWS)};
}

function activeBytes({width, height, y0, y1}) {
  if (!Number.isSafeInteger(y0) || y0 < 0 || y0 >= height || y0 % SCORE_BAND_ROWS || y1 !== Math.min(height, y0 + SCORE_BAND_ROWS))
    throw fault('JXL_INTERNAL', 'photo-band-storage:band');
  return 4 * width * (y1 - y0);
}

const byteView = (view, length, bytes) => view instanceof Uint8Array && view.byteOffset === 0 && view.length === length &&
  view.buffer instanceof ArrayBuffer && view.buffer.byteLength === bytes;

export function scoreBandReply(task, result) {
  if (!result) return false;
  const {inputBytes, outputBytes} = capacity(task.width, task.height), bytes = activeBytes(task);
  const {input, pack, own} = result;
  return input instanceof ArrayBuffer && input.byteLength === inputBytes && byteView(pack, bytes, outputBytes) &&
    byteView(own, bytes, outputBytes) && pack.buffer !== own.buffer && pack.buffer !== input && own.buffer !== input;
}

export function scoreBandTransfers(task) {
  const {input, rows, into, width, height, y0, y1} = task, {inputBytes, outputBytes} = capacity(width, height);
  const [top, end] = bandSourceRows(y0, y1, height), bytes = activeBytes(task);
  if (!(input instanceof ArrayBuffer) || input.byteLength !== inputBytes || task.top !== top ||
      !byteView(rows, (end - top) * width * 4, inputBytes) || rows.buffer !== input ||
      !byteView(into?.package, bytes, outputBytes) || !byteView(into?.native, bytes, outputBytes) ||
      into.package.buffer === into.native.buffer || into.package.buffer === input || into.native.buffer === input)
    throw fault('JXL_INTERNAL', 'photo-band-storage:slabs');
  const check = value => {
    if (ArrayBuffer.isView(value)) {
      if (value.buffer !== input) throw fault('JXL_INTERNAL', 'photo-band-storage:view');
    } else if (value && typeof value === 'object') for (const child of Object.values(value)) check(child);
  };
  check(task.recipe);
  return [input, into.package.buffer, into.native.buffer];
}

export function scoreBandStorage(width, height, count, recipeAt) {
  const {sourceBytes, inputBytes, outputBytes} = capacity(width, height);
  if (![width, height, count, inputBytes, outputBytes].every(n => Number.isSafeInteger(n) && n > 0) || count > Math.ceil(height / SCORE_BAND_ROWS))
    throw fault('JXL_INTERNAL', 'photo-band-storage:geometry');
  const inputs = Array.from({length: count}, () => new ArrayBuffer(inputBytes));
  const outputs = Array.from({length: count + 1}, () => ({pack: new ArrayBuffer(outputBytes), own: new ArrayBuffer(outputBytes)}));
  const pending = new Map(), held = new Map();
  let closed = false;
  const open = () => { if (closed) throw fault('JXL_INTERNAL', 'photo-band-storage:closed'); };
  const entry = task => {
    open();
    const value = pending.get(task);
    if (!value) throw fault('JXL_INTERNAL', 'photo-band-storage:task');
    return value;
  };
  const hold = (task, result) => {
    const pair = entry(task);
    pending.delete(task);
    inputs.push(result.input);
    pair.pack = result.pack.buffer; pair.own = result.own.buffer;
    held.set(result, pair);
    return result;
  };
  return {count, inputBytes, outputBytes,
    take({data, recipe, look, y0, y1}) {
      open();
      const bytes = activeBytes({width, height, y0, y1});
      if (!inputs.length || !outputs.length) throw fault('JXL_INTERNAL', 'photo-band-storage:slots');
      const input = inputs.pop(), pair = outputs.pop();
      try {
        let at = sourceBytes;
        const allocate = (Type, length) => {
          const size = Type.BYTES_PER_ELEMENT;
          if (!Number.isSafeInteger(length) || length < 0 || ![1, 2, 4, 8].includes(size))
            throw fault('JXL_INTERNAL', 'photo-band-storage:type');
          at = Math.ceil(at / size) * size;
          const end = at + length * size;
          if (!Number.isSafeInteger(end) || end > inputBytes) throw fault('JXL_INTERNAL', 'photo-band-storage:overflow');
          const out = new Type(input, at, length); at = end;
          return out;
        };
        const [top, end] = bandSourceRows(y0, y1, height), rows = new Uint8Array(input, 0, (end - top) * width * 4);
        rows.set(data.subarray(top * width * 4, end * width * 4));
        const task = {kind: 'score-band', look, input, rows, recipe: recipeAt(recipe, y0, y1, allocate), top, width, height, y0, y1,
          into: {package: new Uint8Array(pair.pack, 0, bytes), native: new Uint8Array(pair.own, 0, bytes)}};
        pending.set(task, pair);
        return task;
      } catch (error) { inputs.push(input); outputs.push(pair); throw error; }
    },
    receive(task, result) {
      entry(task);
      if (!scoreBandReply(task, result)) throw fault('JXL_INTERNAL', 'photo-band-storage:reply');
      return hold(task, result);
    },
    release(result) {
      open();
      const pair = held.get(result);
      if (!pair) throw fault('JXL_INTERNAL', 'photo-band-storage:output');
      held.delete(result); outputs.push(pair);
    },
    lost(task) {
      const pair = entry(task), bytes = activeBytes(task);
      const input = task.input.byteLength === inputBytes ? task.input : new ArrayBuffer(inputBytes);
      if (pair.pack.byteLength !== outputBytes) pair.pack = new ArrayBuffer(outputBytes);
      if (pair.own.byteLength !== outputBytes) pair.own = new ArrayBuffer(outputBytes);
      return hold(task, {input, pack: new Uint8Array(pair.pack, 0, bytes), own: new Uint8Array(pair.own, 0, bytes)});
    },
    destroy() { closed = true; inputs.length = outputs.length = 0; pending.clear(); held.clear(); },
  };
}
