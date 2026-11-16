// SPDX-License-Identifier: MIT
import {BitWriter, part} from './bits.mjs';
import {writeModularFrameHeader, writeTOC} from './frame.mjs';
import {inspectPixels, shapeFloors, losslessSteps} from './lossless.mjs';
import {readStill} from './framing.mjs';
import {rctSearchSteps} from './rct-search.mjs';

const deepFormat = ({bitDepth, exponentBits}) => exponentBits ? bitDepth === 32 && exponentBits === 8 || bitDepth === 16 && exponentBits === 5 : bitDepth > 8 && bitDepth <= 16;
export function channelLosslessCompatible(config) {
  const first = config.channels[0], deep = deepFormat(first);
  return config.groupSize === 256 && config.predictor < 0 && config.extras.length <= 1 &&
    config.extras.every(channel => channel.kind === 0 && channel.dimShift === 0) &&
    config.channels.every(channel => channel.shift === 0 && (deep
      ? channel.bitDepth === first.bitDepth && channel.exponentBits === first.exponentBits
      : channel.bitDepth === 8 && !channel.exponentBits));
}

export function channelFrameHeader(config) {
  const header = new BitWriter(128);
  writeModularFrameHeader(header, {extraChannels: config.extras.length, shift: 31 - Math.clz32(config.groupSize / 128),
    upsampling: config.upsampling, extraUpsampling: config.extras.map(channel => channel.factor), passes: config.progression?.header});
  return header;
}

export function channelFrameSize(frame) {
  const header = new BitWriter(128), sizes = frame.sections.map(section => section.length);
  header.append(frame.header); writeTOC(header, sizes);
  return header.bitLength / 8 + sizes.reduce((sum, size) => sum + size, 0);
}

export function* channelLosslessSteps(config) {
  const {codedWidth: width, codedHeight: height, colorCount, channels, extras} = config;
  const alpha = extras.length !== 0, deep = deepFormat(channels[0]), format = channels[0];
  const words = deep ? new Int32Array(width * height * 4) : null;
  const data = !deep ? new Uint8Array(width * height * 4) : format.bitDepth === 32 ? new Float32Array(words.buffer) : new Uint16Array(width * height * 4);
  if (deep) {
    const opaque = format.exponentBits ? format.bitDepth === 32 ? 0x3f800000 : 0x3c00 : (1 << format.bitDepth) - 1, out = format.bitDepth === 32 ? words : data;
    for (let i = 0; i < width * height; i++) {
      const p = i * 4;
      out[p] = channels[0].data[i];
      out[p + 1] = channels[colorCount === 3 ? 1 : 0].data[i];
      out[p + 2] = channels[colorCount === 3 ? 2 : 0].data[i];
      out[p + 3] = alpha ? extras[0].data[i] : opaque;
    }
  } else for (let i = 0; i < width * height; i++) {
    const p = i * 4;
    data[p] = channels[0].data[i];
    data[p + 1] = channels[colorCount === 3 ? 1 : 0].data[i];
    data[p + 2] = channels[colorCount === 3 ? 2 : 0].data[i];
    data[p + 3] = alpha ? extras[0].data[i] : 255;
  }
  const samples = deep && {sampleFormat: format.exponentBits ? format.bitDepth === 32 ? 'float32' : 'float16' : 'uint', bitDepth: format.bitDepth,
    exponentBits: format.exponentBits, colorChannels: colorCount, colorSpace: 'srgb', transferFunction: format.exponentBits ? 'linear' : 'srgb', intensityTarget: 255, alphaPremultiplied: false, native8: false};
  let shape;
  shapeFloors.set(data, {colour: colorCount, alpha});
  try { shape = inspectPixels(data, width, height, deep ? {samples} : undefined); }
  finally { shapeFloors.delete(data); }
  const searches = !deep && config.effort >= 7 && shape.colour === 3 && !shape.palette && width * height >= 4096 ? 2 : 1;
  let bytes = yield* part(losslessSteps(data, width, height, deep ? {shape, samples, effort: config.effort} : {shape}), 0, searches);
  if (searches === 2) {
    try {
      const candidate = yield* part(rctSearchSteps(data, width, height, shape), 1, searches);
      if (candidate && candidate.length < bytes.length) bytes = candidate;
    } catch (error) { if (error.code !== 'JXL_SIZE') throw error; }
  }
  const still = readStill(bytes), frame = still.frames[0];
  let at = frame.sectionsAt;
  const sections = frame.sizes.map(size => { const section = still.codestream.subarray(at, at + size); at += size; return section; });
  return {header: channelFrameHeader(config), sections};
}
