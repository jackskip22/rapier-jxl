// SPDX-License-Identifier: MIT
import {BitWriter, complete, scaled} from './bits.mjs';
import {admitSize, admitOutputSize, fault, job} from './admit.mjs';
import {encodeChannelsSteps} from './channels.mjs';
import {extraChannelType} from './format-fields.mjs';
import {channelPowers} from './planar-input.mjs';
import {readStill, writeStillFrame, writeStillImageHeader, compositionMetadataKey, copyBits} from './framing.mjs';
import {readTOCPermutation} from './toc-permutation.mjs';
import {JxlBits, skipICC} from './jpeg-coefficients.mjs';
import {authoredPatchEntropy} from './patch-code.mjs';
import {patchObject, patchMode, patchWhole, patchClamp, patchGeometry, patchCoverage, patchTokenCount} from './patch-input.mjs';
import {fileHeader, boxHeader, CODESTREAM} from './container.mjs';

function patchICCSpan(bytes, start) {
  const reader = new JxlBits(bytes); reader.bit = start; skipICC(reader); return reader.bit - start;
}
const patchRead = bytes => readStill(bytes, {iccBits: patchICCSpan, tocPermutation: readTOCPermutation});

function patchFrameSource(source, options, reference) {
  patchObject(source, reference ? 'Patch reference' : 'Patch base');
  if ((source.image === undefined) === (source.bytes === undefined))
    throw fault('JXL_INPUT', 'Each patch source supplies either a planar image or encoded bytes.');
  let still, operation, width, height, upsampling, extras;
  if (source.bytes !== undefined) {
    if (!(source.bytes instanceof Uint8Array) || !source.bytes.length) throw fault('JXL_INPUT', 'An encoded patch source is a nonempty Uint8Array.');
    if (source.options !== undefined) throw fault('JXL_INPUT', 'Encoded patch sources already own their coding options.');
    if (!reference && options.preview !== undefined) throw fault('JXL_INPUT', 'An encoded patch base already owns its preview.');
    still = patchRead(source.bytes);
    if (still.frames.length !== 1) throw fault('JXL_INPUT', 'An encoded patch source is one independent frame.');
    const frame = still.frames[0];
    if (frame.type !== 0 && frame.type !== 3 || frame.x0 || frame.y0 || frame.width !== still.image.width || frame.height !== still.image.height ||
        frame.blending.some(blend => blend.mode !== 0) || frame.flags & 34)
      throw fault('JXL_INPUT', 'A patch source is a full replacement without existing patch or LF reference dependencies.');
    if (reference && frame.passes !== 1) throw fault('JXL_INPUT', 'A saved patch reference has one coding pass.');
    ({width, height} = still.image); upsampling = frame.upsampling; extras = still.image.channelInfo;
  } else {
    patchObject(source.options ?? {}, 'Per-source patch options');
    for (const name of Object.keys(source.options ?? {}))
      if (!['groupSize', 'predictor', 'weightedPredictor', 'upsampling', 'transforms', 'squeeze', 'progressive', 'maxTransformBytes'].includes(name))
        throw fault('JXL_INPUT', 'Per-source options select Modular coding and sampling; image color and channel precision are shared.');
    if (reference && source.options?.progressive) throw fault('JXL_INPUT', 'A saved patch reference has one coding pass.');
    const settings = {...options, ...source.options, preview: reference ? undefined : options.preview,
      progressive: reference ? false : source.options?.progressive ?? options.progressive};
    operation = encodeChannelsSteps(source.image, settings);
    ({width, height} = source.image); upsampling = settings.upsampling ?? 1;
    extras = (source.image.extraChannels ?? []).map(channel => ({kind: extraChannelType(new Map(Object.entries(channel)).get('type')),
      dimShift: channel.dimShift ?? 0, factor: channel.upsampling ?? Math.max(1, upsampling / channelPowers[channel.dimShift ?? 0])}));
  }
  admitSize(width, height);
  if (!reference && upsampling !== 1 && extras.some((channel, i) =>
    (still ? still.frames[0].extraUpsampling[i] : channel.factor) * channelPowers[channel.dimShift] !== upsampling))
    throw fault('JXL_INPUT', 'Patches on an upsampled base require the same total sampling factor for color and every extra channel.');
  return {still, operation, width, height, upsampling, extras};
}

function patchChannelBlend(value, fallback, extras) {
  if (typeof value === 'string') value = {blend: value};
  patchObject(value, 'Patch channel blending');
  const mode = patchMode(value.blend ?? fallback.blend);
  const alpha = patchWhole(value.alpha ?? fallback.alpha ?? 0, Math.max(0, extras.length - 1), 'Patch alpha selector');
  const clamp = patchClamp(value.clamp ?? (mode >= 3 ? fallback.clamp : undefined), mode, 'Patch clamp');
  if (mode >= 4 && extras.length && extras[alpha].kind !== 0)
    throw fault('JXL_INPUT', 'An alpha-dependent patch blend selects an alpha extra channel.');
  return {mode, alpha, clamp};
}

function patchCompositionInput(input, options) {
  patchObject(input, 'Patch composition'); patchObject(options, 'Patch composition options');
  if (options.level !== undefined && options.level !== 5 && options.level !== 10) throw fault('JXL_INPUT', 'JPEG XL level is 5 or 10.');
  if (options.preview !== undefined && (!options.preview || options.preview.maxDimension !== undefined))
    throw fault('JXL_INPUT', 'A patch composition preview is an authored planar image of the finished result.');
  const base = patchFrameSource(input.base, options, false), references = new Map();
  if (!Array.isArray(input.references) || !input.references.length || input.references.length > 4)
    throw fault('JXL_INPUT', 'A patch composition supplies one to four reference images.');
  for (const source of input.references) {
    patchObject(source, 'Patch reference');
    const slot = patchWhole(source.slot, 3, 'Reference slot');
    if (references.has(slot)) throw fault('JXL_INPUT', 'Every patch reference uses a distinct slot.');
    references.set(slot, {...patchFrameSource(source, options, true), slot});
  }
  const width = Math.ceil(base.width / base.upsampling), height = Math.ceil(base.height / base.upsampling);
  const referenceLimit = Math.min(16777216, 1024 + Math.floor(width * height / 4)), extras = base.extras;
  const firstAlpha = Math.max(0, extras.findIndex(channel => channel.kind === 0));
  const geometry = patchGeometry(input.patches, width, height, references, position => {
    const defaults = {alpha: firstAlpha}, color = patchChannelBlend(position, defaults, extras);
    if (position.extraBlending !== undefined && (!Array.isArray(position.extraBlending) || position.extraBlending.length !== extras.length))
      throw fault('JXL_INPUT', 'extraBlending has one description for each extra channel.');
    const fallback = {blend: position.blend, alpha: color.alpha, clamp: color.clamp};
    const blending = [color, ...Array.from({length: extras.length}, (_, i) => patchChannelBlend(position.extraBlending?.[i] ?? {}, fallback, extras))];
    if ((color.mode === 4 || color.mode === 5) && extras[color.alpha]?.kind === 0)
      blending[1 + color.alpha] = {...color};
    return {blending};
  }, referenceLimit, references.keys().next().value);
  if (geometry.placements * (extras.length + 1) > referenceLimit * 16)
    throw fault('JXL_INPUT', 'Patch blending information exceeds the destination image\'s decoder budget.');
  patchCoverage(geometry.area, width * height, options.level ?? 10);
  return {base, references, ...geometry, codedPixels: width * height, requestedLevel: options.level,
    extraChannels: extras.length, tokens: patchTokenCount(geometry.groups, extras.length)};
}

function* patchCompositionEncode(config) {
  const {base, references} = config, sources = [...references.values(), base];
  let level = config.requestedLevel ?? 5, modular16 = true, compositePixels = 0;
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    if (!source.still) {
      let step;
      while (!(step = source.operation.next()).done) {
        source.operation.hurry ||= !!(yield scaled(step.value, fraction => .85 * (i + fraction) / sources.length));
      }
      source.still = patchRead(step.value);
    }
    level = Math.max(level, source.still.level); modular16 &&= source.still.image.modular16;
    compositePixels += source.width * source.height;
  }
  const ordinary = base.still, frame = ordinary.frames[0], key = compositionMetadataKey(ordinary);
  for (const reference of references.values()) {
    const source = reference.still;
    if (source.frames.length !== 1 || source.frames[0].passes !== 1 || compositionMetadataKey(source) !== key || source.frames[0].ycbcr !== frame.ycbcr)
      throw fault('JXL_INPUT', 'Patch sources share exact channel/color/transform metadata and the same pre-color-transform domain.');
  }
  if (!modular16 || compositePixels > 268435456) level = 10;
  if (config.requestedLevel === 5 && level === 10) throw fault('JXL_INPUT', 'These patch sources require JPEG XL level 10.');
  patchCoverage(config.area, config.codedPixels, level);
  const steps = authoredPatchEntropy(config); let step;
  while (!(step = steps.next()).done) yield .85 + .05 * step.value;
  const dictionary = step.value, writer = new BitWriter(256), canvas = ordinary.image;
  writeStillImageHeader(writer, ordinary, {...canvas, modular16});
  if (ordinary.preview) copyBits(writer, ordinary.codestream, ordinary.preview.start * 8, ordinary.preview.end * 8);
  let i = 0;
  for (const reference of references.values()) {
    writeStillFrame(writer, reference.still, reference.still.frames[0], {canvas, frameType: 2, last: false,
      reference: reference.slot, beforeColorTransform: true});
    admitOutputSize(Math.ceil(writer.bitLength / 8)); yield .9 + .08 * ++i / references.size;
  }
  writeStillFrame(writer, ordinary, frame, {canvas, last: true, patchDictionary: dictionary});
  const bytes = writer.finish(); admitOutputSize(bytes.length); yield 1;
  if (level !== 10) return bytes;
  const prefix = fileHeader(10), box = boxHeader(CODESTREAM, bytes.length);
  admitOutputSize(prefix.length + box.length + bytes.length);
  const output = new Uint8Array(prefix.length + box.length + bytes.length);
  output.set(prefix); output.set(box, prefix.length); output.set(bytes, prefix.length + box.length); return output;
}

export function encodePatchComposition(input, options = {}) { return complete(encodePatchCompositionSteps(input, options)); }
export function encodePatchCompositionSteps(input, options = {}) { return job(patchCompositionEncode(patchCompositionInput(input, options))); }
