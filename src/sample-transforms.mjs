// SPDX-License-Identifier: MIT
import {prepareKernels, ensureKernels, orientBlock, sampleTable, sampleFilter, sampleSum, sampleFinish} from './kernels.mjs';
import {wasmRequired} from './capture-wasm-error.mjs';
import {check, fail, dimensions} from './v7/primitives.mjs';
import {admitSampleDomain} from './sample-domain.mjs';
import {exactPow, exactLog} from './exact-math.mjs';
import {sRGBWithIntent} from './v7/header-intent.mjs';

export async function orientSamples(picture, {signal} = {}) {
  check(signal);
  const {orientation = 1, width, height, data, ...description} = picture;
  if (!Number.isInteger(orientation) || orientation < 1 || orientation > 8)
    throw fail('JXL_INPUT', 'orientation is an integer from 1 through 8.');
  if (orientation === 1) return {data, width, height, ...description};
  if (description.extraChannels !== undefined)
    throw fail('JXL_UNSUPPORTED', 'Orienting extra channels needs a channel transform.');
  if (!await prepareKernels() || ensureKernels() !== 'simd') throw wasmRequired();
  check(signal);
  if (orientation <= 4) return {data: await orientInPlace(data, width, height, orientation, signal), width, height, ...description};
  const transpose = orientation >= 5, outWidth = transpose ? height : width, outHeight = transpose ? width : height;
  const out = new data.constructor(data.length), pixelBytes = data.BYTES_PER_ELEMENT * 4;
  const from = new Uint8Array(data.buffer, data.byteOffset, data.byteLength), to = new Uint8Array(out.buffer);
  let lastTurn = performance.now();
  for (let y = 0; y < height; y += 256) for (let x = 0; x < width; x += 256) {
    check(signal);
    const w = Math.min(256, width - x), h = Math.min(256, height - y);
    const ox = orientation === 2 || orientation === 3 ? width - x - w
      : orientation === 6 || orientation === 7 ? height - y - h : transpose ? y : x;
    const oy = orientation === 3 || orientation === 4 ? height - y - h
      : orientation === 7 || orientation === 8 ? width - x - w : transpose ? x : y;
    orientBlock(from, to, width, outWidth, x, y, w, h, ox, oy, pixelBytes, orientation);
    if (performance.now() - lastTurn > 8) {
      await new Promise(resolve => setTimeout(resolve, 0)); check(signal); lastTurn = performance.now();
    }
  }
  return {data: out, width: outWidth, height: outHeight, ...description};
}

async function orientInPlace(data, width, height, orientation, signal) {
  const pixelBytes = data.BYTES_PER_ELEMENT * 4, rowBytes = width * pixelBytes;
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let lastTurn = performance.now();
  const turn = async () => {
    if (performance.now() - lastTurn > 8) { await new Promise(resolve => setTimeout(resolve, 0)); check(signal); lastTurn = performance.now(); }
  };
  if (orientation >= 3) {
    const row = new Uint8Array(rowBytes);
    for (let top = 0, bottom = height - 1; top < bottom; top++, bottom--) {
      const a = top * rowBytes, b = bottom * rowBytes;
      row.set(bytes.subarray(a, a + rowBytes)); bytes.copyWithin(a, b, b + rowBytes); bytes.set(row, b);
      if (!(top & 63)) { check(signal); await turn(); }
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
      await turn();
    }
  }
  return data;
}

export async function sampleResizeConfig(picture, {signal} = {}) {
  if (picture.orientation !== undefined && picture.orientation !== 1)
    throw fail('JXL_INPUT', 'Orient the source before resizing.');
  if (picture.extraChannels !== undefined)
    throw fail('JXL_UNSUPPORTED', 'Resizing extra channels needs a sampling policy.');
  if (picture.icc !== undefined)
    throw fail('JXL_UNSUPPORTED', 'Resize needs a named color space; convert ICC samples first.');
  const samples = admitSampleDomain(picture.data, picture), {data} = picture;
  const [named] = sRGBWithIntent(picture);
  if (named !== picture) {
    samples.colorSpace = named.colorSpace; samples.transferFunction = named.transferFunction;
  }
  const format = samples.sampleFormat === 'float32' ? 3 : samples.sampleFormat === 'float16' ? 2 : data.BYTES_PER_ELEMENT === 2 ? 1 : 0;
  const maximum = samples.exponentBits ? 1 : 2 ** samples.bitDepth - 1;
  const tf = ['linear', 'srgb', 'pq', 'hlg'].indexOf(samples.transferFunction);
  const luma = samples.colorSpace === 'rec2020' ? [.2627, .678, .0593] : samples.colorSpace === 'display-p3'
    ? [.228974564, .691738522, .079286914] : [.212639006, .715168679, .072192315];
  const gamma = tf === 3 ? 1.2 * exactPow(1.111, exactLog(samples.intensityTarget / 1000) / Math.LN2) : 1;
  const config = [format, maximum, tf, +samples.alphaPremultiplied, gamma, ...luma];
  if (!await prepareKernels() || ensureKernels() !== 'simd') throw wasmRequired();
  check(signal);
  const table = format < 2 && !samples.alphaPremultiplied ? sampleTable(maximum, tf) : null;
  const levels = !!table && maximum <= 4095 && gamma === 1;
  return {config,table,levels};
}
export function sampleResizeRows(sourceHeight,height,y) {
  if (height >= sourceHeight) {
    const at = Math.max(0,Math.min(sourceHeight - 1,(y + .5) * sourceHeight / height - .5)), first = Math.floor(at);
    return {first,end:Math.min(sourceHeight,first + 2),fraction:at - first};
  }
  const from = y * sourceHeight / height, to = (y + 1) * sourceHeight / height;
  return {first:Math.floor(from),end:Math.ceil(to),from,to};
}
export const sampleResizeWeight = (range,row) => range.fraction !== undefined
  ? row === range.first ? 1 - range.fraction : range.fraction
  : (Math.min(range.to,row + 1) - Math.max(range.from,row)) / (range.to - range.from);

export async function resizeSamples(picture, width, height, {signal, maxPixels = 40000000} = {}) {
  dimensions(width, height, maxPixels); check(signal);
  if (width === picture.width && height === picture.height) return picture;
  const {config,table,levels} = await sampleResizeConfig(picture,{signal}), {data} = picture;
  const out = new data.constructor(width * height * 4), rows = new Map(), sum = new Float64Array(width * 4);
  let lastTurn = performance.now();
  const add = (y, weight) => {
    if (!weight) return;
    let row = rows.get(y);
    if (!row) {
      row = sampleFilter(data, y, picture.width, width, config, table);
      if (rows.size === 2) rows.delete(rows.keys().next().value);
      rows.set(y, row);
    }
    sampleSum(sum, row, weight);
  };
  const turn = async () => {
    if (performance.now() - lastTurn > 8) { await new Promise(resolve => setTimeout(resolve, 0)); check(signal); lastTurn = performance.now(); }
  };
  for (let y = 0; y < height; y++) {
    check(signal); sum.fill(0);
    const range = sampleResizeRows(picture.height,height,y);
    for (let row = range.first; row < range.end; row++) {
      add(row,sampleResizeWeight(range,row)); await turn();
    }
    sampleFinish(sum, out, y, width, config, levels);
  }
  check(signal); return {...picture, data: out, width, height};
}
