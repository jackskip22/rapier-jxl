// SPDX-License-Identifier: MIT
import {BitWriter, LIMITS, complete, part} from './bits.mjs';
import {fault, job, admitSize, admitOutputSize} from './admit.mjs';
import {writeImageHeader, groupLayout, assembleCodestream} from './frame.mjs';
import {leaf, channelTree, writeTree, writeModularHeader, writeChannelHistograms, codeChannel, ALPHABET} from './modular.mjs';
import {buildCode} from './prefix.mjs';
import {prepareICC} from './icc.mjs';
import {prepareColorEncoding, prepareToneMapping} from './color-info.mjs';
import {checkInteger, extraChannelType, prepareExtraChannels, prepareImageFields, prepareUpsamplingWeights, EXTRA_CHANNEL_TYPES} from './format-fields.mjs';
import {channelLosslessCompatible, channelFrameHeader, channelFrameSize, channelLosslessSteps} from './channel-lossless.mjs';

export {EXTRA_CHANNEL_TYPES, LIMITS};
const powers = [1]; for (let i = 1; i <= 32; i++) powers.push(powers[i - 1] * 2);
const upsample = (value, name) => { if (![1, 2, 4, 8].includes(value)) throw fault('JXL_INPUT', name + ' is 1, 2, 4 or 8.'); return value; };
const object = (value, name) => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw fault('JXL_INPUT', name + ' is an object.'); return value; };

function precision(data, options) {
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray || data instanceof Uint16Array || data instanceof Uint32Array || data instanceof Float32Array))
    throw fault('JXL_INPUT', 'Channel samples are unsigned typed arrays or Float32Array.');
  const sampleFormat = options.sampleFormat ?? (data instanceof Float32Array ? 'float32' : 'uint');
  if (!['uint', 'float', 'float16', 'float32'].includes(sampleFormat)) throw fault('JXL_INPUT', 'sampleFormat is uint, float16, float32 or float (raw words).');
  const bitDepth = options.bitDepth ?? (sampleFormat === 'float16' ? 16 : data.BYTES_PER_ELEMENT * 8);
  const exponentBits = sampleFormat === 'uint' ? 0 : options.exponentBits ?? (sampleFormat === 'float16' ? 5 : 8);
  if (sampleFormat === 'uint' && options.exponentBits !== undefined && options.exponentBits !== 0)
    throw fault('JXL_INPUT', 'Integer samples have no exponent bits.');
  if (sampleFormat === 'float16' && (bitDepth !== 16 || exponentBits !== 5) || sampleFormat === 'float32' && (bitDepth !== 32 || exponentBits !== 8))
    throw fault('JXL_INPUT', 'float16 and float32 use their IEEE sample precision; use float for other raw-word layouts.');
  checkInteger(bitDepth, 1, exponentBits ? 32 : 31, 'bitDepth');
  if (exponentBits) {
    checkInteger(exponentBits, 2, 8, 'exponentBits');
    checkInteger(bitDepth - exponentBits - 1, 2, 23, 'Mantissa precision');
  } else if (data instanceof Float32Array) throw fault('JXL_INPUT', 'Float32Array needs floating-point sample metadata.');
  if (data instanceof Float32Array && (bitDepth !== 32 || exponentBits !== 8)) throw fault('JXL_INPUT', 'Float32Array has 32 bits and eight exponent bits.');
  if (bitDepth > data.BYTES_PER_ELEMENT * 8) throw fault('JXL_INPUT', 'The channel array cannot hold the declared precision.');
  const words = data instanceof Float32Array ? new Int32Array(data.buffer, data.byteOffset, data.length) : data;
  const maximum = powers[bitDepth] - 1;
  if (!(data instanceof Float32Array)) for (const value of words) if (value > maximum) throw fault('JXL_INPUT', 'A channel sample exceeds its declared precision.');
  return {data: words, bitDepth, exponentBits, sampleFormat};
}

function admitPicture(input, options) {
  object(input, 'Planar image'); object(options, 'Channel options');
  const {width, height, color, extraChannels = []} = input;
  admitSize(width, height);
  if (options.quality !== undefined && options.quality !== 100) throw fault('JXL_INPUT', 'Planar channels keep exact sample words; quality is 100.');
  if (!Array.isArray(color) || color.length !== 1 && color.length !== 3) throw fault('JXL_INPUT', 'color contains one gray plane or three RGB planes.');
  if (!Array.isArray(extraChannels) || extraChannels.length > 256) throw fault('JXL_INPUT', 'An image has at most 256 extra channels.');
  const upsampling = upsample(options.upsampling ?? 1, 'upsampling');
  const codedWidth = Math.ceil(width / upsampling), codedHeight = Math.ceil(height / upsampling);
  const channels = color.map(data => ({...precision(data, options), width: codedWidth, height: codedHeight, shift: 0}));
  for (const channel of channels) {
    if (channel.data.length !== codedWidth * codedHeight) throw fault('JXL_INPUT', 'Each color plane contains ceil(width/upsampling) times ceil(height/upsampling) samples.');
    if (channel.bitDepth !== channels[0].bitDepth || channel.exponentBits !== channels[0].exponentBits)
      throw fault('JXL_INPUT', 'Color planes share one sample precision.');
  }
  const extras = extraChannels.map((entry, index) => {
    object(entry, 'Extra channel ' + index);
    const kind = extraChannelType(new Map(Object.entries(entry)).get('type')), dimShift = checkInteger(entry.dimShift ?? 0, 0, 3, 'dimShift');
    if (entry.alphaPremultiplied !== undefined && kind !== 0 || entry.spotColor !== undefined && kind !== 2 || entry.cfaChannel !== undefined && kind !== 5)
      throw fault('JXL_INPUT', 'Alpha, spot and CFA fields belong to their corresponding channel type.');
    const factor = upsample(entry.upsampling ?? Math.max(1, upsampling / powers[dimShift]), 'Extra-channel upsampling');
    const total = factor * powers[dimShift];
    if (total < upsampling || total > 8) throw fault('JXL_INPUT', 'Combined extra-channel upsampling is at least the color factor and at most eight.');
    const name = entry.name ?? '';
    if (typeof name !== 'string' || new TextEncoder().encode(name).length > 1071) throw fault('JXL_INPUT', 'A channel name is at most 1071 UTF-8 bytes.');
    if (entry.alphaPremultiplied !== undefined && typeof entry.alphaPremultiplied !== 'boolean') throw fault('JXL_INPUT', 'alphaPremultiplied is boolean.');
    const spotColor = entry.spotColor ?? [0, 0, 0, 0];
    if (kind === 2 && (!Array.isArray(spotColor) || spotColor.length !== 4 || spotColor.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)))
      throw fault('JXL_INPUT', 'spotColor is four normalized red, green, blue and solidity values.');
    const cfaChannel = kind === 5 ? checkInteger(entry.cfaChannel ?? 1, 0, 274, 'cfaChannel') : 1;
    const channel = {...precision(entry.data, entry), width: Math.ceil(width / total), height: Math.ceil(height / total),
      shift: 31 - Math.clz32(total / upsampling), kind, dimShift, factor, name, alphaPremultiplied: !!entry.alphaPremultiplied, spotColor, cfaChannel};
    if (channel.data.length !== channel.width * channel.height) throw fault('JXL_INPUT', 'Extra channel ' + index + ' has the wrong number of samples.');
    return channel;
  });
  channels.push(...extras);
  const groupSize = options.groupSize ?? 256;
  if (![128, 256, 512, 1024].includes(groupSize)) throw fault('JXL_INPUT', 'groupSize is 128, 256, 512 or 1024.');
  const predictors = new Map([['zero', 0], ['left', 1], ['top', 2], ['average', 3], ['gradient', 5]]);
  const predictor = new Map(Object.entries(options)).get('predictor') ?? 'auto';
  if (predictor !== 'auto' && !predictors.has(predictor)) throw fault('JXL_INPUT', 'predictor is auto, zero, left, top, average or gradient.');
  const requiredLevel = extras.length > 4 || extras.some(c => c.kind === 4) || channels.some(c => c.bitDepth > 12 || c.exponentBits) ? 10 : 5;
  if (options.level !== undefined && options.level !== 5 && options.level !== 10) throw fault('JXL_INPUT', 'JPEG XL level is 5 or 10.');
  if (options.level === 5 && requiredLevel === 10) throw fault('JXL_INPUT', 'These channels require JPEG XL level 10.');
  const metadata = {bitDepth: channels[0].bitDepth, exponentBits: channels[0].exponentBits,
    modular16bit: channels.every(c => c.bitDepth <= 12 && !c.exponentBits), extraChannelData: prepareExtraChannels(extras),
    transformData: prepareUpsamplingWeights(options.upsamplingWeights)};
  if (options.icc !== undefined) {
    if (options.colorEncoding !== undefined || options.colorSpace !== undefined || options.transferFunction !== undefined)
      throw fault('JXL_INPUT', 'ICC supplies color meaning; omit other color declarations.');
    Object.assign(metadata, prepareICC(options.icc, {level: options.level, compression: options.iccCompression,
      colorSpace: extras.some(channel => channel.kind === 4) ? 'cmyk' : undefined}));
  } else {
    Object.assign(metadata, prepareColorEncoding(options.colorEncoding ?? {space: color.length === 1 ? 'gray' : 'rgb'},
      {...options, transferFunction: options.transferFunction ?? (channels[0].exponentBits ? 'linear' : 'srgb')}));
  }
  if (metadata.colorChannels !== color.length) throw fault('JXL_INPUT', 'The declared color encoding and color plane count differ.');
  metadata.intensityTarget = options.intensityTarget ?? (metadata.transferFunction === 'pq' ? 10000 : metadata.transferFunction === 'hlg' ? 1000 : 255);
  if (options.toneMapping !== undefined) Object.assign(metadata, prepareToneMapping(options.toneMapping, metadata.intensityTarget));
  else if (options.intensityTarget !== undefined) Object.assign(metadata, prepareToneMapping({intensityTarget: options.intensityTarget}));
  const level = Math.max(requiredLevel, options.level ?? 5, metadata.level ?? 5);
  const imageFields = prepareImageFields(options);
  if (imageFields) metadata.imageFields = imageFields;
  return {width, height, codedWidth, codedHeight, colorCount: color.length, extras, channels, upsampling, groupSize, metadata, level,
    predictor: predictor === 'auto' ? -1 : predictors.get(predictor)};
}

function piece(channel, x, y, size) {
  const factor = powers[channel.shift], left = Math.floor(x / factor), top = Math.floor(y / factor);
  const width = Math.max(0, Math.min(channel.width - left, size / factor));
  const height = Math.max(0, Math.min(channel.height - top, size / factor));
  return {channel, left, top, width, height};
}

function plane(piece) {
  const {channel, left, top, width, height} = piece, data = new Int32Array(width * height);
  for (let y = 0; y < height; y++) data.set(channel.data.subarray((top + y) * channel.width + left, (top + y) * channel.width + left + width), y * width);
  return data;
}

function selectedPredictor(data, width, height, forced) {
  if (forced >= 0) return forced;
  let selected = 0, cost = Infinity;
  for (const predictor of [0, 1, 2, 3, 5]) {
    const counts = new Uint32Array(ALPHABET), h = Math.min(height, Math.max(1, Math.floor(4096 / width)));
    codeChannel(null, counts, data, width, h, leaf(predictor));
    const code = buildCode(counts);
    let bits = 0; for (let s = 0; s < counts.length; s++) bits += counts[s] * (code.lengths[s] + Math.max(0, s < 224 ? s - 1 : s - 236));
    if (bits < cost) { cost = bits; selected = predictor; }
  }
  return selected;
}

function writePlanes(writer, pieces, predictor, afterModel) {
  if (!pieces.length) return;
  const leaves = [], histograms = Array.from({length: Math.min(pieces.length, 254)}, () => new Uint32Array(ALPHABET));
  pieces.forEach((item, c) => {
    const data = plane(item), model = leaf(selectedPredictor(data, item.width, item.height, predictor)); leaves.push(model);
    codeChannel(null, histograms[Math.min(c, 253)], data, item.width, item.height, model);
  });
  const ordered = writeTree(writer, channelTree(leaves));
  const codes = writeChannelHistograms(writer, ordered, histograms, model => Math.min(leaves.indexOf(model), 253));
  if (afterModel) afterModel();
  pieces.forEach((item, c) => codeChannel(writer, codes[Math.min(c, 253) + 1].code, plane(item), item.width, item.height, leaves[c]));
}

function* planarFrameSteps(config, byteCeiling = Infinity) {
  const {codedWidth: width, codedHeight: height, groupSize: dim, channels, predictor} = config;
  const layout = groupLayout(width, height, dim), global = new BitWriter(256), sections = [];
  global.write(1, 1); global.write(1, 1);
  let firstGrouped = 0;
  while (firstGrouped < channels.length && channels[firstGrouped].width <= dim && channels[firstGrouped].height <= dim) firstGrouped++;
  if (firstGrouped) {
    writePlanes(global, channels.slice(0, firstGrouped).map(channel => ({channel, left: 0, top: 0, width: channel.width, height: channel.height})), predictor,
      () => writeModularHeader(global));
  } else {
    const model = leaf(0), counts = new Uint32Array(ALPHABET); counts[0] = 1;
    const ordered = writeTree(global, model); writeChannelHistograms(global, ordered, [counts]);
    writeModularHeader(global);
  }
  sections.push(global.finish());
  const dcGroups = layout.dcGroupsX * layout.dcGroupsY, groups = layout.groupsX * layout.groupsY;
  let size = sections[0].length;
  if (size > byteCeiling) return null;
  if (!layout.single) {
    for (const [count, across, extent, dc] of [[dcGroups, layout.dcGroupsX, dim * 8, true], [groups, layout.groupsX, dim, false]]) {
      if (!dc) sections.push(new Uint8Array(0));
      for (let g = 0; g < count; g++) {
        const pieces = channels.slice(firstGrouped).filter(channel => dc ? channel.shift >= 3 : channel.shift < 3)
          .map(channel => piece(channel, g % across * extent, Math.floor(g / across) * extent, extent)).filter(p => p.width && p.height);
        const section = new BitWriter(256);
        if (pieces.length) { writeModularHeader(section, {useGlobalTree: false}); writePlanes(section, pieces, predictor); }
        const bytes = section.finish(); size += bytes.length;
        if (size > byteCeiling) return null;
        admitOutputSize(size); sections.push(bytes);
        yield ((dc ? 0 : dcGroups) + g + 1) / (dcGroups + groups);
      }
    }
  } else yield 1;
  return {header: channelFrameHeader(config), sections};
}

function* frameSteps(config) {
  if (!channelLosslessCompatible(config)) return yield* planarFrameSteps(config);
  let best, smallest = Infinity, oversized;
  const candidates = [channelLosslessSteps, planarFrameSteps];
  for (let i = 0; i < candidates.length; i++) {
    try {
      const frame = yield* part(candidates[i](config, smallest), i, candidates.length);
      if (!frame) continue;
      const size = channelFrameSize(frame);
      if (size <= smallest) { best = frame; smallest = size; }
    } catch (error) { if (error.code !== 'JXL_SIZE') throw error; oversized = error; }
  }
  if (!best) throw oversized;
  return best;
}

function* channelsSteps(config) {
  let preview;
  if (config.preview) {
    const frame = yield* part(frameSteps(config.preview), 0, 2);
    preview = assembleCodestream(frame.header, frame.sections);
  }
  const frame = yield* part(frameSteps(config), config.preview ? 1 : 0, config.preview ? 2 : 1), header = new BitWriter(256);
  writeImageHeader(header, config.width, config.height, config.colorCount, false, config.metadata);
  if (preview) header.append({bytes: preview, at: preview.length, pending: 0, acc: 0});
  header.append(frame.header);
  return assembleCodestream(header, frame.sections, config.level);
}

function thumbnail(input, options, maximum) {
  checkInteger(maximum, 1, 5440, 'Preview maxDimension');
  const divisor = Math.max(1, Math.max(input.width, input.height) / maximum);
  const width = Math.max(1, Math.floor(input.width / divisor)), height = Math.max(1, Math.floor(input.height / divisor));
  const scale = options.upsampling ?? 1;
  const resize = (data, factor) => {
    const sw = Math.ceil(input.width / factor), sh = Math.ceil(input.height / factor), dw = Math.ceil(width / factor), dh = Math.ceil(height / factor);
    const result = new data.constructor(dw * dh);
    for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) result[y * dw + x] = data[Math.min(sh - 1, Math.floor((y + 0.5) * sh / dh)) * sw + Math.min(sw - 1, Math.floor((x + 0.5) * sw / dw))];
    return result;
  };
  return {width, height, color: input.color.map(data => resize(data, scale)), extraChannels: (input.extraChannels ?? []).map(entry => {
    const factor = powers[entry.dimShift ?? 0] * (entry.upsampling ?? Math.max(1, scale / powers[entry.dimShift ?? 0]));
    return {...entry, data: resize(entry.data, factor)};
  })};
}

export function encodeChannels(image, options = {}) { return complete(encodeChannelsSteps(image, options)); }
export function encodeChannelsSteps(image, options = {}) {
  object(options, 'Channel options');
  const config = admitPicture(image, {...options, preview: undefined});
  if (options.preview !== undefined) {
    object(options.preview, 'preview');
    const input = options.preview.maxDimension !== undefined ? thumbnail(image, options, options.preview.maxDimension) : options.preview;
    const preview = admitPicture(input, {...options, groupSize: 1024, preview: undefined, intrinsicSize: undefined, orientation: 1});
    const a = config.metadata.extraChannelData, b = preview.metadata.extraChannelData;
    const bytes = a.finish(), other = b.finish();
    if (config.colorCount !== preview.colorCount || config.metadata.bitDepth !== preview.metadata.bitDepth || config.metadata.exponentBits !== preview.metadata.exponentBits ||
        a.bitLength !== b.bitLength || bytes.some((value, i) => value !== other[i])) throw fault('JXL_INPUT', 'Preview channels must have the same color count, precision and extra-channel metadata as the main image.');
    config.preview = preview;
    config.metadata.modular16bit &&= preview.metadata.modular16bit;
    config.metadata.imageFields = prepareImageFields({...options, preview: {width: preview.width, height: preview.height}});
  }
  return job(channelsSteps(config));
}
