// SPDX-License-Identifier: MIT
import {BitWriter, part} from './bits.mjs';
import {writeModularFrameHeader, writeTOC} from './frame.mjs';
import {inspectPixels, shapeFloors, losslessSteps} from './lossless.mjs';
import {readStill} from './framing.mjs';
import {rctSearchSteps} from './rct-search.mjs';

export function channelLosslessCompatible(config) {
  return config.groupSize === 256 && config.predictor < 0 && config.extras.length <= 1 &&
    config.extras.every(channel => channel.kind === 0 && channel.dimShift === 0) &&
    config.channels.every(channel => channel.bitDepth === 8 && !channel.exponentBits && channel.shift === 0);
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
  const data = new Uint8Array(width * height * 4), alpha = extras.length !== 0;
  for (let i = 0; i < width * height; i++) {
    const p = i * 4;
    data[p] = channels[0].data[i];
    data[p + 1] = channels[colorCount === 3 ? 1 : 0].data[i];
    data[p + 2] = channels[colorCount === 3 ? 2 : 0].data[i];
    data[p + 3] = alpha ? extras[0].data[i] : 255;
  }
  let shape;
  shapeFloors.set(data, {colour: colorCount, alpha});
  try { shape = inspectPixels(data, width, height); }
  finally { shapeFloors.delete(data); }
  const searches = config.effort >= 7 && shape.colour === 3 && !shape.palette && width * height >= 4096 ? 2 : 1;
  let bytes = yield* part(losslessSteps(data, width, height, {shape}), 0, searches);
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
