// SPDX-License-Identifier: MIT
import {prepareKernels, ensureKernels, orientBlock, sampleTable, sampleBands} from './kernels.mjs';
import {wasmRequired} from './capture-wasm-error.mjs';
import {check, fail, dimensions, PIXELS} from './v7/primitives.mjs';
import {admitSampleDomain} from './sample-domain.mjs';
import {sRGBWithIntent} from './v7/header-intent.mjs';
import {turn} from './turn.mjs';

const yields = typeof WorkerGlobalScope !== 'function' &&
  (() => { try { return globalThis.process?.getBuiltinModule?.('node:worker_threads')?.isMainThread !== false; } catch { return true; } })();
const turner = signal => {
  let last = -Infinity;
  return async () => {
    if (!yields || performance.now() - last <= 8) return;
    await turn(); check(signal); last = performance.now();
  };
};

export async function orientSamples(picture, {signal} = {}) {
  check(signal);
  const {orientation = 1, width, height, data, ...description} = picture;
  if (!Number.isInteger(orientation) || orientation < 1 || orientation > 8)
    throw fail('JXL_INPUT', 'orientation is an integer from 1 through 8.');
  if (orientation === 1) return {data, width, height, ...description};
  if (description.extraChannels !== undefined)
    throw fail('JXL_UNSUPPORTED', 'Orienting extra channels needs a channel transform.');
  if (!await prepareKernels() || !ensureKernels()) throw wasmRequired();
  check(signal);
  if (orientation <= 4) return {data: await orientInPlace(data, width, height, orientation, signal), width, height, ...description};
  const transpose = orientation >= 5, outWidth = transpose ? height : width, outHeight = transpose ? width : height;
  const out = new data.constructor(data.length), pixelBytes = data.BYTES_PER_ELEMENT * 4;
  const from = new Uint8Array(data.buffer, data.byteOffset, data.byteLength), to = new Uint8Array(out.buffer);
  const pause = turner(signal);
  for (let y = 0; y < height; y += 256) for (let x = 0; x < width; x += 256) {
    check(signal);
    const w = Math.min(256, width - x), h = Math.min(256, height - y);
    const ox = orientation === 2 || orientation === 3 ? width - x - w
      : orientation === 6 || orientation === 7 ? height - y - h : transpose ? y : x;
    const oy = orientation === 3 || orientation === 4 ? height - y - h
      : orientation === 7 || orientation === 8 ? width - x - w : transpose ? x : y;
    orientBlock(from, to, width, outWidth, x, y, w, h, ox, oy, pixelBytes, orientation);
    await pause();
  }
  return {data: out, width: outWidth, height: outHeight, ...description};
}

async function orientInPlace(data, width, height, orientation, signal) {
  const pixelBytes = data.BYTES_PER_ELEMENT * 4, rowBytes = width * pixelBytes;
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const pause = turner(signal);
  if (orientation >= 3) {
    const row = new Uint8Array(rowBytes);
    for (let top = 0, bottom = height - 1; top < bottom; top++, bottom--) {
      const a = top * rowBytes, b = bottom * rowBytes;
      row.set(bytes.subarray(a, a + rowBytes)); bytes.copyWithin(a, b, b + rowBytes); bytes.set(row, b);
      if (!(top & 63)) { check(signal); await pause(); }
    }
  }
  if (orientation <= 3) {
    const band = new Uint8Array(Math.min(256, height) * rowBytes);
    for (let y = 0; y < height; y += 256) {
      check(signal);
      const h = Math.min(256, height - y);
      band.set(bytes.subarray(y * rowBytes, (y + h) * rowBytes));
      for (let x = 0; x < width; x += 256) {
        const w = Math.min(256, width - x);
        orientBlock(band, bytes, width, width, x, 0, w, h, width - x - w, y, pixelBytes, 2);
      }
      await pause();
    }
  }
  return data;
}

const CURVES = ['linear', 'srgb', 'pq', 'hlg', 'bt709'];
const xyz = ([x, y]) => [x / y, 1, (1 - x - y) / y];
const det = (a, b, c) => a[0] * (b[1] * c[2] - b[2] * c[1]) - b[0] * (a[1] * c[2] - a[2] * c[1]) + c[0] * (a[1] * b[2] - a[2] * b[1]);
function lumaOf(primaries, white = 'd65') {
  const [r, g, b] = primaries.map(xyz), w = xyz(Array.isArray(white) ? white : {e: [1 / 3, 1 / 3], dci: [.314, .351]}[white] ?? [.3127, .329]);
  const all = det(r, g, b);
  return [det(w, g, b) / all, det(r, w, b) / all, det(r, g, w) / all];
}
export async function sampleResizeConfig(picture, {signal} = {}) {
  if (picture.orientation !== undefined && picture.orientation !== 1)
    throw fail('JXL_INPUT', 'Orient the source before resizing.');
  if (picture.extraChannels !== undefined)
    throw fail('JXL_UNSUPPORTED', 'Resizing extra channels needs a sampling policy.');
  if (picture.icc !== undefined) picture = {...picture, icc: undefined, colorEncoding: undefined, colorSpace: 'srgb', transferFunction: undefined};
  const samples = admitSampleDomain(picture.data, picture), {data} = picture;
  const [named] = sRGBWithIntent(picture);
  if (named !== picture) {
    samples.colorSpace = named.colorSpace; samples.transferFunction = named.transferFunction;
  }
  const format = samples.sampleFormat === 'float32' ? 3 : samples.sampleFormat === 'float16' ? 2 : data.BYTES_PER_ELEMENT === 2 ? 1 : 0;
  const maximum = samples.exponentBits ? 1 : 2 ** samples.bitDepth - 1;
  const e = samples.colorEncoding, curve = e ? e.transferFunction ?? 'srgb' : samples.transferFunction;
  const tf = e?.gamma !== undefined ? Math.round(e.gamma * 1e7) : curve === 'dci' ? 3846154 : CURVES.indexOf(curve);
  const primaries = e ? e.primaries : samples.colorSpace;
  const luma = Array.isArray(primaries) ? lumaOf(primaries, e.whitePoint) : primaries === 'rec2020' ? [.2627, .678, .0593]
    : primaries === 'display-p3' ? [.228974564, .691738522, .079286914] : [.212639006, .715168679, .072192315];
  const gamma = tf === 3 ? 1.2 * Math.pow(1.111, Math.log(samples.intensityTarget / 1000) / Math.LN2) : 1;
  const config = [format, maximum, tf, +samples.alphaPremultiplied, gamma, ...luma];
  if (!await prepareKernels() || !ensureKernels()) throw wasmRequired();
  check(signal);
  const table = format < 2 && !samples.alphaPremultiplied ? sampleTable(maximum, tf) : null;
  const levels = !!table && maximum <= 4095 && gamma === 1;
  return {config,table,levels};
}
export function sampleResizeRows(sourceHeight,height,y) {
  if (height >= sourceHeight) {
    const first = Math.floor(Math.max(0,Math.min(sourceHeight - 1,(y + .5) * sourceHeight / height - .5)));
    return {first,end:Math.min(sourceHeight,first + 2)};
  }
  return {first:Math.floor(y * sourceHeight / height),end:Math.ceil((y + 1) * sourceHeight / height)};
}
export function sampleResizeStep(bands, data, sourceHeight, height, state, out, outY = state.y, limit = bands.outRows) {
  const {y} = state, first = state.row ?? sampleResizeRows(sourceHeight,height,y).first;
  const most = Math.min(sourceHeight,first + bands.sourceRows);
  let y1 = y;
  while (y1 < height && y1 - y < limit && sampleResizeRows(sourceHeight,height,y1).end <= most) y1++;
  if (y1 === y) {
    const sum = bands.run(data, first, most, y, y + 1, out, outY, state.sum, true);
    return {state:{y,row:most,sum},written:0};
  }
  bands.run(data, first, sampleResizeRows(sourceHeight,height,y1 - 1).end, y, y1, out, outY, state.sum, false);
  return {state:{y:y1,row:null,sum:null},written:y1 - y};
}

export async function resizeSamples(picture, width, height, {signal, maxPixels = PIXELS} = {}) {
  dimensions(width, height, maxPixels); check(signal);
  if (width === picture.width && height === picture.height) return picture;
  const {config,table,levels} = await sampleResizeConfig(picture,{signal}), {data} = picture;
  const out = new data.constructor(width * height * 4), pause = turner(signal);
  const bands = sampleBands(picture.width, picture.height, width, height, config, table, levels, data.BYTES_PER_ELEMENT);
  for (let state = {y:0,row:null,sum:null}; state.y < height;) {
    check(signal);
    ({state} = sampleResizeStep(bands, data, picture.height, height, state, out));
    await pause();
  }
  check(signal); return {...picture, data: out, width, height};
}
