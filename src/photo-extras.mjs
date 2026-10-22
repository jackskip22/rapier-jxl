// SPDX-License-Identifier: MIT
import {fault} from './admit.mjs';
import {admitExtraChannels, channelPowers} from './planar-input.mjs';
import {prepareExtraChannels} from './format-fields.mjs';
import {channelPiece, writePlanarPlanes} from './planar-planes.mjs';
import {writeModularHeader} from './modular.mjs';
import {encodeChannelsSteps} from './channels.mjs';

export function exactPhotoExtraSteps(data, width, height, options, samples) {
  if (!Array.isArray(options.extraChannels)) throw fault('JXL_INPUT', 'Extra channels are an array.');
  const source = data instanceof Float32Array ? new Uint32Array(data.buffer, data.byteOffset, data.length) : data;
  const count = width * height, colorCount = samples.colorChannels ?? 3;
  const color = Array.from({length: colorCount}, (_, c) => source.constructor.from({length: count}, (_, i) => source[i * 4 + c]));
  const opaque = samples.exponentBits ? samples.bitDepth === 32 ? 0x3f800000 : 0x3c00 : channelPowers[samples.bitDepth] - 1;
  let alpha = false;
  for (let i = 3; i < source.length; i += 4) if (source[i] !== opaque) { alpha = true; break; }
  const extraChannels = options.extraChannels.slice();
  if (alpha) extraChannels.unshift({...Object.fromEntries([['type', 'alpha']]), data: source.constructor.from({length: count}, (_, i) => source[i * 4 + 3]),
    bitDepth: samples.bitDepth, sampleFormat: samples.sampleFormat, exponentBits: samples.exponentBits,
    alphaPremultiplied: samples.alphaPremultiplied});
  return encodeChannelsSteps({width, height, color, extraChannels}, {quality: 100,
    bitDepth: samples.bitDepth, sampleFormat: samples.sampleFormat, exponentBits: samples.exponentBits,
    colorSpace: options.icc === undefined ? samples.colorSpace : undefined,
    transferFunction: options.icc === undefined ? samples.transferFunction : undefined,
    intensityTarget: samples.intensityTarget, icc: options.icc, iccCompression: options.iccCompression,
    level: options.level, orientation: options.orientation});
}

export function admitPhotoExtras(data, layout, options) {
  if (options.extraChannels === undefined) return null;
  const channels = admitExtraChannels(options.extraChannels, layout.width, layout.height, layout.factor);
  if (!channels.length) return null;
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray))
    throw fault('JXL_INPUT', 'Photographic color with extra channels uses eight-bit RGBA; other exact color precisions use encodeChannels.');
  let alpha = false;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) { alpha = true; break; }
  if (alpha) {
    if (channels.length === 256) throw fault('JXL_INPUT', 'The RGBA alpha and authored planes together have at most 256 extra channels.');
    const plane = Uint8Array.from({length: data.length / 4}, (_, i) => data[i * 4 + 3]);
    channels.unshift(...admitExtraChannels([{...Object.fromEntries([['type', 'alpha']]), data: plane, upsampling: layout.factor}], layout.width, layout.height, layout.factor));
  }
  if (options.lfFrames !== undefined && options.lfFrames !== false && channels.some(channel => channel.factor !== 1))
    throw fault('JXL_INPUT', 'Frames using a low-frequency frame cannot signal extra-channel spatial upsampling.');
  const requiredLevel = channels.length > 4 || channels.some(channel => channel.kind === 4 || channel.bitDepth > 12 || channel.exponentBits) ? 10 : 5;
  if (options.level !== undefined && options.level !== 5 && options.level !== 10) throw fault('JXL_INPUT', 'JPEG XL level is 5 or 10.');
  if (options.level === 5 && requiredLevel === 10) throw fault('JXL_INPUT', 'These extra channels require JPEG XL level 10.');
  return {channels, metadata: prepareExtraChannels(channels), level: Math.max(options.level ?? 5, requiredLevel),
    modular16bit: channels.every(channel => channel.bitDepth <= 12 && !channel.exponentBits)};
}

export function snapshotPhotoExtras(config) {
  return config && {...config, channels: config.channels.map(channel => ({...channel, data: new channel.data.constructor(channel.data)}))};
}

function paddedPhotoExtras(channels, width, height, factor) {
  return channels.map(channel => {
    const total = channel.factor * channelPowers[channel.dimShift];
    const w = Math.ceil(width * factor / total), h = Math.ceil(height * factor / total);
    if (w === channel.width && h === channel.height) return channel;
    const data = new Int32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
      data[y * w + x] = channel.data[Math.min(y, channel.height - 1) * channel.width + Math.min(x, channel.width - 1)];
    return {...channel, data, width: w, height: h};
  });
}

export function photoExtraStreams(channels) {
  let firstGrouped = 0;
  while (firstGrouped < channels.length && channels[firstGrouped].width <= 256 && channels[firstGrouped].height <= 256) firstGrouped++;
  const write = (writer, pieces) => {
    if (!pieces.length) return;
    writeModularHeader(writer, {useGlobalTree: false});
    writePlanarPlanes(writer, pieces, -1, undefined, undefined, Math.min(1048576,
      1024 + pieces.reduce((sum, item) => sum + item.width * item.height, 0)));
  };
  return {
    count: channels.length, factors: channels.map(channel => channel.factor), channels,
    global(writer) {
      const planes = channels.slice(0, firstGrouped);
      if (!planes.length) planes.push({data: new Int32Array(0), width: 0, height: 0, shift: 0});
      write(writer, planes.map(channel => ({channel, left: 0, top: 0, width: channel.width, height: channel.height})));
    },
    group(writer, x, y, extent, minimum, maximum) {
      write(writer, channels.slice(firstGrouped).filter(channel => channel.shift >= minimum && channel.shift <= maximum)
        .map(channel => channelPiece(channel, x, y, extent)).filter(item => item.width && item.height));
    },
    downsample(nextWidth, nextHeight) {
      const next = channels.map(channel => {
        const w = Math.ceil(nextWidth / channelPowers[channel.shift]), h = Math.ceil(nextHeight / channelPowers[channel.shift]);
        const data = new Int32Array(w * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
          data[y * w + x] = channel.data[Math.min(channel.height - 1, y * 8) * channel.width + Math.min(channel.width - 1, x * 8)];
        return {...channel, data, width: w, height: h};
      });
      return photoExtraStreams(next);
    },
  };
}

export function applyPhotoExtras(image, config, layout) {
  if (!config) return;
  image.auxiliary = photoExtraStreams(paddedPhotoExtras(config.channels, image.width, image.height, layout.factor));
  image.profile = {...image.profile, extraChannelData: config.metadata};
  image.modular16bit = image.modular16bit !== false && config.modular16bit;
  image.level = Math.max(image.level ?? 5, config.level);
}
