// SPDX-License-Identifier: MIT
import {BitWriter, LIMITS, complete, part} from './bits.mjs';
import {fault, job, admitSize, admitOutputSize} from './admit.mjs';
import {writeImageHeader, groupLayout, assembleCodestream} from './frame.mjs';
import {leaf, writeTree, writeModularHeader, writeChannelHistograms, ALPHABET} from './modular.mjs';
import {prepareICC} from './icc.mjs';
import {prepareColorEncoding, prepareToneMapping} from './color-info.mjs';
import {checkInteger, prepareExtraChannels, prepareImageFields, prepareUpsamplingWeights, EXTRA_CHANNEL_TYPES} from './format-fields.mjs';
import {channelLosslessCompatible, channelFrameHeader, channelFrameSize, channelLosslessSteps} from './channel-lossless.mjs';
import {admitWeightedPredictor, writePlanarModularHeader} from './weighted-custom.mjs';
import {admitPlanarSqueeze, applyPlanarSqueeze} from './planar-squeeze.mjs';
import {modularPasses} from './modular-progressive.mjs';
import {admitPlanarTransforms, applyPlanarTransforms} from './planar-transforms.mjs';
import {channelPowers, channelUpsampling, requireChannelObject, admitChannelPrecision, admitExtraChannels} from './planar-input.mjs';
import {channelPiece, writePlanarPlanes} from './planar-planes.mjs';

export {EXTRA_CHANNEL_TYPES, LIMITS};

function admitPicture(input, options) {
  requireChannelObject(input, 'Planar image'); requireChannelObject(options, 'Channel options');
  const {width, height, color, extraChannels = []} = input;
  admitSize(width, height);
  if (options.quality !== undefined && options.quality !== 100) throw fault('JXL_INPUT', 'Planar channels keep exact sample words; quality is 100.');
  if (!Array.isArray(color) || color.length !== 1 && color.length !== 3) throw fault('JXL_INPUT', 'color contains one gray plane or three RGB planes.');
  const upsampling = channelUpsampling(options.upsampling ?? 1, 'upsampling');
  const codedWidth = Math.ceil(width / upsampling), codedHeight = Math.ceil(height / upsampling);
  const channels = color.map(data => ({...admitChannelPrecision(data, options), width: codedWidth, height: codedHeight, shift: 0}));
  for (const channel of channels) {
    if (channel.data.length !== codedWidth * codedHeight) throw fault('JXL_INPUT', 'Each color plane contains ceil(width/upsampling) times ceil(height/upsampling) samples.');
    if (channel.bitDepth !== channels[0].bitDepth || channel.exponentBits !== channels[0].exponentBits)
      throw fault('JXL_INPUT', 'Color planes share one sample precision.');
  }
  const extras = admitExtraChannels(extraChannels, width, height, upsampling);
  channels.push(...extras);
  const groupSize = options.groupSize ?? 256;
  if (![128, 256, 512, 1024].includes(groupSize)) throw fault('JXL_INPUT', 'groupSize is 128, 256, 512 or 1024.');
  const predictors = new Map([['zero', 0], ['left', 1], ['top', 2], ['average', 3], ['gradient', 5], ['weighted', 6]]);
  let predictor = new Map(Object.entries(options)).get('predictor') ?? 'auto';
  if (options.weightedPredictor !== undefined) {
    if (predictor !== 'auto' && predictor !== 'weighted') throw fault('JXL_INPUT', 'weightedPredictor requires the weighted predictor.');
    predictor = 'weighted';
  }
  if (predictor !== 'auto' && !predictors.has(predictor)) throw fault('JXL_INPUT', 'predictor is auto, zero, left, top, average, gradient or weighted.');
  const weighted = predictor === 'weighted' ? admitWeightedPredictor(options.weightedPredictor) : null;
  const progression = modularPasses(options.progressive);
  const transformPlan = admitPlanarTransforms(new Map(Object.entries(options)).get('transforms'), color.length, options.maxTransformBytes);
  const squeezeValue = options.squeeze === undefined && progression ? 'default' : options.squeeze;
  const squeezePlan = transformPlan ? null : admitPlanarSqueeze(squeezeValue, channels, groupSize, options.maxTransformBytes);
  const squeezeSource = Array.isArray(squeezeValue) ? squeezeValue.map(step => ({...step})) : squeezeValue;
  const requiredLevel = extras.length > 4 || extras.some(c => c.kind === 4) || channels.some(c => c.bitDepth > 12 || c.exponentBits) ||
    squeezePlan?.count > 256 || squeezePlan?.transforms.length > 8 ? 10 : 5;
  if (options.level !== undefined && options.level !== 5 && options.level !== 10) throw fault('JXL_INPUT', 'JPEG XL level is 5 or 10.');
  if (options.level === 5 && requiredLevel === 10) throw fault('JXL_INPUT', 'These channels require JPEG XL level 10.');
  const metadata = {bitDepth: channels[0].bitDepth, exponentBits: channels[0].exponentBits,
    modular16bit: channels.every(c => c.bitDepth <= 12 && !c.exponentBits), extraChannelData: prepareExtraChannels(extras),
    transformData: prepareUpsamplingWeights(options.upsamplingWeights)};
  if (options.icc !== undefined) {
    if (options.colorSpace !== undefined || options.transferFunction !== undefined)
      throw fault('JXL_INPUT', 'ICC supplies color meaning; omit other color declarations.');
    Object.assign(metadata, prepareICC(options.icc, {level: options.level, compression: options.iccCompression,
      colorSpace: extras.some(channel => channel.kind === 4) ? 'cmyk' : undefined, colorEncoding: options.colorEncoding}));
  } else {
    if (options.colorEncoding?.space === 'xyb' && (options.colorSpace !== undefined || options.transferFunction !== undefined))
      throw fault('JXL_INPUT', 'Original XYB color has implicit color fields; omit colorSpace and transferFunction.');
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
    weighted, squeezePlan, squeezeSource, transformPlan, progression, requestedLevel: options.level,
    predictor: predictor === 'auto' ? -1 : predictors.get(predictor)};
}

function* planarFrameSteps(config, byteCeiling = Infinity) {
  const {codedWidth: width, codedHeight: height, groupSize: dim, channels, predictor, weighted, squeezePlan, progression, modularTransforms} = config;
  const header = (writer, local = false) => weighted || squeezePlan || modularTransforms
    ? writePlanarModularHeader(writer, {useGlobalTree: !local, weighted, transforms: local ? [] : modularTransforms ?? squeezePlan?.transforms})
    : writeModularHeader(writer, {useGlobalTree: !local});
  const layout = groupLayout(width, height, dim), global = new BitWriter(256), sections = [];
  global.write(1, 1); global.write(1, 1);
  let firstGrouped = config.metaCount ?? 0;
  while (firstGrouped < channels.length && channels[firstGrouped].width <= dim && channels[firstGrouped].height <= dim) firstGrouped++;
  if (firstGrouped) {
    writePlanarPlanes(global, channels.slice(0, firstGrouped).map(channel => ({channel, left: 0, top: 0, width: channel.width, height: channel.height})), predictor,
      () => header(global), weighted, Math.min(4194304, 1024 + Math.floor(width * height * (config.colorCount + config.extras.length) / 16)));
  } else {
    const model = leaf(0), counts = new Uint32Array(ALPHABET); counts[0] = 1;
    const ordered = writeTree(global, model); writeChannelHistograms(global, ordered, [counts]);
    header(global);
  }
  sections.push(global.finish());
  const dcGroups = layout.dcGroupsX * layout.dcGroupsY, groups = layout.groupsX * layout.groupsY;
  let size = sections[0].length;
  if (size > byteCeiling) return null;
  if (!layout.single || progression) {
    const passes = progression?.brackets ?? [{minimum: 0, maximum: 2}];
    const stages = [{count: dcGroups, across: layout.dcGroupsX, extent: dim * 8, minimum: 3, maximum: Infinity},
      ...passes.map(pass => ({count: groups, across: layout.groupsX, extent: dim, ...pass}))];
    let done = 0;
    for (const [stage, {count, across, extent, minimum, maximum}] of stages.entries()) {
      if (stage === 1) sections.push(new Uint8Array(0));
      for (let g = 0; g < count; g++) {
        const pieces = channels.slice(firstGrouped).filter(channel => {
          const shift = Math.min(channel.hshift ?? channel.shift, channel.vshift ?? channel.shift);
          return shift >= minimum && shift <= maximum;
        })
          .map(channel => channelPiece(channel, g % across * extent, Math.floor(g / across) * extent, extent)).filter(p => p.width && p.height);
        const section = new BitWriter(256);
        if (pieces.length) {
          header(section, true);
          writePlanarPlanes(section, pieces, predictor, undefined, weighted,
            Math.min(1048576, 1024 + pieces.reduce((sum, item) => sum + item.width * item.height, 0)));
        }
        const bytes = section.finish(); size += bytes.length;
        if (size > byteCeiling) return null;
        admitOutputSize(size); sections.push(bytes);
        yield ++done / (dcGroups + groups * passes.length);
      }
    }
  } else yield 1;
  return {header: channelFrameHeader(config), sections};
}

function* frameSteps(config) {
  if (config.transformPlan) {
    const prepared = yield* part(applyPlanarTransforms(config.channels, config.transformPlan, config.metadata.bitDepth, config.weighted), 0, 3);
    const squeezePlan = admitPlanarSqueeze(config.squeezeSource, prepared.channels, config.groupSize, config.transformPlan.memoryLimit, prepared.metaCount);
    const squeezed = squeezePlan ? yield* part(applyPlanarSqueeze(prepared.channels, squeezePlan), 1, 3) : prepared;
    const modularTransforms = [...prepared.transforms, ...(squeezePlan?.transforms ?? [])];
    if (modularTransforms.length > 273) throw fault('JXL_INPUT', 'The complete Modular recipe has at most 273 transforms.');
    if (prepared.wide || squeezed.wide) config.metadata.modular16bit = false;
    if (prepared.wide || squeezed.wide || prepared.maximumChannels > 256 || squeezePlan?.count > 256 || modularTransforms.length > 8) {
      if (config.requestedLevel === 5) throw fault('JXL_INPUT', 'This Modular transform recipe requires JPEG XL level 10.');
      config.level = 10;
    }
    return yield* part(planarFrameSteps({...config, channels: squeezed.channels, squeezePlan, modularTransforms,
      metaCount: squeezePlan?.metaCount ?? prepared.metaCount}), 2, 3);
  }
  if (config.squeezePlan) {
    const transformed = yield* part(applyPlanarSqueeze(config.channels, config.squeezePlan), 0, 2);
    if (transformed.wide) {
      if (config.requestedLevel === 5) throw fault('JXL_INPUT', 'These Squeeze residuals require JPEG XL level 10.');
      config.metadata.modular16bit = false; config.level = 10;
    }
    return yield* part(planarFrameSteps({...config, channels: transformed.channels}), 1, 2);
  }
  if (config.weighted || config.progression) return yield* planarFrameSteps(config);
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
  if (config.preview) {
    config.metadata.modular16bit &&= config.preview.metadata.modular16bit;
    config.level = Math.max(config.level, config.preview.level);
  }
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
    const factor = channelPowers[entry.dimShift ?? 0] * (entry.upsampling ?? Math.max(1, scale / channelPowers[entry.dimShift ?? 0]));
    return {...entry, data: resize(entry.data, factor)};
  })};
}

export function encodeChannels(image, options = {}) { return complete(encodeChannelsSteps(image, options)); }
export function encodeChannelsSteps(image, options = {}) {
  requireChannelObject(options, 'Channel options');
  const config = admitPicture(image, {...options, preview: undefined});
  if (options.preview !== undefined) {
    requireChannelObject(options.preview, 'preview');
    const input = options.preview.maxDimension !== undefined ? thumbnail(image, options, options.preview.maxDimension) : options.preview;
    const preview = admitPicture(input, {...options, groupSize: 1024, progressive: false, preview: undefined, intrinsicSize: undefined, orientation: 1});
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
