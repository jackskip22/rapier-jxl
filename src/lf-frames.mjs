// SPDX-License-Identifier: MIT
import {BitWriter, float16Bits, part} from './bits.mjs';
import {fault, admitOutputSize} from './admit.mjs';
import {assembleCodestream} from './frame.mjs';
import {writeLFFrameHeader, readImageHeader} from './framing.mjs';
import {GRADIENT_PREDICTOR, ALPHABET, leaf, channelTree, writeTree, writeModularHeader, writeChannelHistograms, codeChannel} from './modular.mjs';
import {transformDCT8} from './photo-dct.mjs';
import {varDCTSteps} from './vardct.mjs';
import {buildCode, uintConfig, writeHybrid} from './prefix.mjs';
import {photoLevelContainer} from './photo-crop.mjs';

export function admitLFFrames(value) {
  if (value === undefined || value === false) return 0;
  if (value === true) return 1;
  if (!Number.isInteger(value) || value < 1 || value > 4) throw fault('JXL_INPUT', 'lfFrames is false or one through four low-frequency levels.');
  return value;
}

function halfValue(bits) {
  const exponent = bits >>> 10, mantissa = bits & 1023;
  let value = exponent ? 1024 + mantissa : mantissa, shift = exponent ? exponent - 25 : -24;
  while (shift < 0) { value /= 2; shift++; }
  while (shift > 0) { value *= 2; shift--; }
  return value;
}

function dcImage(image) {
  const width = Math.ceil(image.width / 8), height = Math.ceil(image.height / 8), quantScale = image.quantScale || 1;
  const scales = image.components.map(component => halfValue(float16Bits(component.quant[0] / (255 * 8 * quantScale) * 128)));
  const planes = image.components.map(component => Int32Array.from({length: width * height}, (_, i) =>
    image.strategyData ? component.dc[Math.floor(i / width) * component.stride + i % width] :
      component.coeffs[(Math.floor(i / width) * component.stride + i % width) * 64]));
  let alpha;
  if (image.alpha) {
    alpha = new Int32Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let sum = 0, count = 0;
      for (let dy = y * 8; dy < Math.min(image.height, y * 8 + 8); dy++) for (let dx = x * 8; dx < Math.min(image.width, x * 8 + 8); dx++) {
        sum += image.alpha[(dy * image.width + dx) * 4 + 3]; count++;
      }
      alpha[y * width + x] = Math.round(sum / count);
    }
  }
  return {width, height, scales, planes, alpha};
}

function writePlanes(writer, planes, width, height) {
  const leaves = planes.map(() => leaf(GRADIENT_PREDICTOR)), freqs = leaves.map(() => new Uint32Array(ALPHABET));
  planes.forEach((plane, c) => codeChannel(null, freqs[c], plane, width, height, leaves[c]));
  writeModularHeader(writer, {useGlobalTree: false});
  const ordered = writeTree(writer, channelTree(leaves)), histograms = writeChannelHistograms(writer, ordered, freqs, l => leaves.indexOf(l));
  planes.forEach((plane, c) => codeChannel(writer, histograms[c + 1].code, plane, width, height, leaves[c]));
}

function modularLF(image, level) {
  const {width, height, scales, planes, alpha} = dcImage(image);
  let a = scales[1] * 16777216, b = scales[2] * 16777216;
  while (b) [a, b] = [b, a % b];
  const unit = a / 16777216, yRatio = scales[1] / unit, bRatio = scales[2] / unit;
  if (unit < 1 / 16384) return null;
  const source = [Int32Array.from(planes[1], value => value * yRatio), planes[0], Int32Array.from(planes[2], value => value * bRatio)];
  if (alpha) source.push(alpha);
  const global = new BitWriter(4096);
  global.write(1, 0);
  for (const value of [scales[0], unit, unit]) global.write(16, float16Bits(value));
  global.write(1, 0);
  const dim = 1024, groupsX = Math.ceil(width / dim), groupsY = Math.ceil(height / dim), single = groupsX * groupsY === 1;
  writePlanes(global, single ? source : source.map(() => new Int32Array(0)), single ? width : 0, single ? height : 0);
  const sections = [global.finish()];
  if (!single) {
    for (let i = 0; i <= Math.ceil(width / (8 * dim)) * Math.ceil(height / (8 * dim)); i++) sections.push(new Uint8Array(0));
    for (let gy = 0; gy < groupsY; gy++) for (let gx = 0; gx < groupsX; gx++) {
      const x0 = gx * dim, y0 = gy * dim, w = Math.min(dim, width - x0), h = Math.min(dim, height - y0), writer = new BitWriter(4096);
      writePlanes(writer, source.map(plane => Int32Array.from({length: w * h}, (_, i) => plane[(y0 + Math.floor(i / w)) * width + x0 + i % w])), w, h);
      sections.push(writer.finish());
    }
  }
  const header = new BitWriter(64);
  writeLFFrameHeader(header, {level, shift: 3, extraChannels: alpha ? 1 : 0});
  return assembleCodestream(header, sections);
}

function intermediateLF(parent, level, useDCFrame = true) {
  const source = dcImage(parent), {width, height} = source, stride = Math.ceil(width / 8), rows = Math.ceil(height / 8), quantScale = 1024;
  const components = source.planes.map(() => ({h: 1, v: 1, stride, rows, quant: new Int32Array(64).fill(1), coeffs: new Int32Array(stride * rows * 64)}));
  const block = new Float64Array(192), intermediate = new Float64Array(64), sums = new Float64Array(192);
  for (let by = 0; by < rows; by++) for (let bx = 0; bx < stride; bx++) {
    for (let c = 0; c < 3; c++) for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++)
      block[c * 64 + y * 8 + x] = source.planes[c][Math.min(height - 1, by * 8 + y) * width + Math.min(width - 1, bx * 8 + x)] * source.scales[c] / 128 * 255;
    transformDCT8(block, intermediate, sums);
    for (let c = 0; c < 3; c++) for (let k = 0; k < 64; k++) components[c].coeffs[(by * stride + bx) * 64 + k] = Math.round(sums[c * 64 + k] * quantScale);
  }
  const alpha = source.alpha && Uint8Array.from({length: width * height * 4}, (_, i) => i % 4 === 3 ? source.alpha[i >> 2] : 0);
  const xyb = !!parent.xyb, ycbcr = !!parent.ycbcr;
  return {width, height, components, quantScale, xyb, ycbcr, alpha, useDCFrame, modular16bit: false,
    frameHeader: writer => writeLFFrameHeader(writer, {level, modular: false, xyb, ycbcr, extraChannels: alpha ? 1 : 0, flags: useDCFrame ? 160 : 128})};
}

function lfCoding(counts) {
  const config = uintConfig(0), aggregate = counts.aggregate(Array.from({length: counts.contexts}, (_, i) => i));
  const code = buildCode(aggregate.tokens([0], config, 64)), contextMap = new Uint8Array(counts.contexts);
  return {contextMap, histograms: [{config, code}], bits: 0,
    write: (writer, context, value) => writeHybrid(writer, code, config, value)};
}

export function* lfFrameSteps(image, levels) {
  if (!image.xyb && !image.ycbcr) throw fault('JXL_INPUT', 'Low-frequency frame pyramids require XYB or YCbCr photographic pixels.');
  const images = [image];
  for (let level = 1; level < levels; level++) images.push(intermediateLF(images.at(-1), level));
  const modular = image.xyb && modularLF(images.at(-1), levels);
  const frames = [modular || (yield* part(varDCTSteps(intermediateLF(images.at(-1), levels, false), {coding: lfCoding}), 0, levels))];
  yield 1 / levels;
  for (let level = levels - 1; level; level--) frames.push(yield* part(varDCTSteps(images[level], {coding: lfCoding}), levels - level, levels));
  image.useDCFrame = true; image.modular16bit = false;
  return frames;
}

export function prependLFFrames(main, frames) {
  const image = readImageHeader(main), extra = frames.reduce((sum, frame) => sum + frame.length, 0);
  admitOutputSize(main.length + extra);
  const out = new Uint8Array(main.length + extra);
  out.set(main.subarray(0, image.end));
  let at = image.end;
  for (const frame of frames) { out.set(frame, at); at += frame.length; }
  out.set(main.subarray(image.end), at);
  return photoLevelContainer(out, 10);
}
