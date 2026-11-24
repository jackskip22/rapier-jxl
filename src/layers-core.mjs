// SPDX-License-Identifier: MIT
import {LIMITS} from './limits.mjs';
import {BitWriter} from './bits.mjs';
import {fault, job, admitSize, admitOutputSize} from './admit.mjs';
import {prepareICC} from './icc.mjs';
import {readStill, writeStillFrame, writeStillImageHeader, copyBits, compositionMetadataKey} from './framing.mjs';
import {fileHeader, boxHeader, CODESTREAM} from './container.mjs';

export {LIMITS};
export const LAYER_BLEND_MODES = /* @__PURE__ */ Object.freeze({replace: 0, add: 1, blend: 2, muladd: 3, multiply: 4});
const layerModes = new Map(Object.entries(LAYER_BLEND_MODES));
function layerInteger(value, low, high, label) {
  if (!Number.isInteger(value) || value < low || value > high) throw fault('JXL_INPUT', label + ': integer ' + low + '-' + high);
  return value;
}
function layerObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fault('JXL_INPUT', label + ': object');
}
function layerBlend(value, fallback, extras) {
  if (typeof value === 'string') value = {blend: value};
  layerObject(value, 'Layer blending');
  const name = value.blend ?? fallback.blend ?? 'replace', mode = layerModes.get(name);
  if (mode === undefined) throw fault('JXL_INPUT', 'blend: replace/add/blend/muladd/multiply');
  const source = layerInteger(value.source ?? fallback.source ?? 0, 0, 3, 'Reference source');
  const alpha = layerInteger(value.alpha ?? fallback.alpha ?? 0, 0, Math.min(10, Math.max(0, extras - 1)), 'Alpha selector');
  const clamp = value.clamp ?? fallback.clamp ?? false;
  if (typeof clamp !== 'boolean') throw fault('JXL_INPUT', 'clamp: boolean');
  return {mode, source, alpha, clamp};
}
function layerAdmission(input, options, encodeChannels, limits) {
  layerObject(input, 'Layered image'); layerObject(options, 'Layer options');
  const {width, height, layers} = input; admitSize(width, height, limits);
  if (!Array.isArray(layers) || !layers.length || layers.length > 256) throw fault('JXL_INPUT', 'layers: array 1-256');
  if ((typeof __RAPIER_JXL_FORMAT__ === 'undefined' || __RAPIER_JXL_FORMAT__ === true) && options.preview !== undefined && (!options.preview || options.preview.maxDimension !== undefined))
    throw fault('JXL_INPUT', 'preview: planar composition');
  const iccBits = options.icc === undefined ? undefined : prepareICC(options.icc, {compression: options.iccCompression,
    level: options.level, colorSpace: layers[0].image?.extraChannels?.some(channel => new Map(Object.entries(channel)).get('type') === 'black') ? 'cmyk' : undefined}).iccData.bitLength;
  const admitted = layers.map((layer, index) => {
    layerObject(layer, 'Layer ' + index);
    if ((layer.image === undefined) === (layer.bytes === undefined)) throw fault('JXL_INPUT', 'layer: image or bytes');
    const x0 = layerInteger(layer.x ?? 0, -536870911, 536870911, 'Layer x'), y0 = layerInteger(layer.y ?? 0, -536870911, 536870911, 'Layer y');
    const saved = () => layerInteger(layer.saveAs ?? (index === layers.length - 1 ? 0 : 3), 0, 3, 'Reference destination');
    if (typeof __RAPIER_JXL_FORMAT__ !== 'undefined' && __RAPIER_JXL_FORMAT__ !== true) {
      const reference = saved();
      if (!(layer.bytes instanceof Uint8Array) || !layer.bytes.length) throw fault('JXL_INPUT', 'layer.bytes: nonempty Uint8Array');
      return {layer, x0, y0, frameType: 0, reference, still: readStill(layer.bytes, {iccBits})};
    }
    const frameType = layer.referenceOnly ? 2 : layer.skipProgressive ? 3 : 0;
    if (layer.referenceOnly !== undefined && typeof layer.referenceOnly !== 'boolean' || layer.skipProgressive !== undefined && typeof layer.skipProgressive !== 'boolean')
      throw fault('JXL_INPUT', 'referenceOnly/skipProgressive: boolean');
    if (layer.referenceOnly && layer.skipProgressive || frameType === 2 && (x0 || y0)) throw fault('JXL_INPUT', 'referenceOnly: no origin/progressive');
    if (index === layers.length - 1 && frameType === 2) throw fault('JXL_INPUT', 'final layer: display frame');
    if (layer.name !== undefined && (typeof layer.name !== 'string' || new TextEncoder().encode(layer.name).length > 1071))
      throw fault('JXL_INPUT', 'layer.name: max 1071 UTF-8 bytes');
    const reference = saved();
    if (layer.beforeColorTransform !== undefined && typeof layer.beforeColorTransform !== 'boolean') throw fault('JXL_INPUT', 'beforeColorTransform: boolean');
    let still, operation;
    if (layer.bytes !== undefined) {
      if (!(layer.bytes instanceof Uint8Array) || !layer.bytes.length) throw fault('JXL_INPUT', 'layer.bytes: nonempty Uint8Array');
      still = readStill(layer.bytes, {iccBits});
      if (!index && options.preview !== undefined) throw fault('JXL_INPUT', 'preview: first encoded layer');
    } else {
      layerObject(layer.options ?? {}, 'Per-layer encoding options');
      for (const name of Object.keys(layer.options ?? {})) if (!['groupSize', 'predictor', 'upsampling'].includes(name))
        throw fault('JXL_INPUT', 'layer.options: groupSize/predictor/upsampling');
      if (!encodeChannels) throw fault('JXL_INTERNAL', 'layers:channel-encoder');
      operation = encodeChannels(layer.image, {...options, ...layer.options,
        progressive: layer.referenceOnly ? false : options.progressive, preview: index ? undefined : options.preview});
    }
    return {layer, x0, y0, frameType, reference, still, operation};
  });
  return {width, height, layers: admitted, iccBits, requestedLevel: options.level};
}
function* layerSteps(config) {
  const {width, height, layers, iccBits} = config, encoded = [];
  let metadata, modular16 = true, level = 5, canvasReference = 0, compositePixels = 0;
  for (let i = 0; i < layers.length; i++) {
    const item = layers[i];
    if ((typeof __RAPIER_JXL_FORMAT__ === 'undefined' || __RAPIER_JXL_FORMAT__ === true) && !item.still) {
      let step;
      do { step = item.operation.next(); if (!step.done) yield (i + step.value) / layers.length * .9; } while (!step.done);
      item.still = readStill(step.value, {iccBits});
    }
    const {still, layer} = item, key = compositionMetadataKey(still);
    if (i && key !== metadata) throw fault('JXL_INPUT', 'layers: shared channels/color/orientation/transforms');
    metadata = key; modular16 &&= still.image.modular16; level = Math.max(level, still.level);
    if (still.frames.length !== 1) throw fault('JXL_INPUT', 'layer: single frame; use atlas/LF');
    const frame = still.frames[0];
    compositePixels += frame.width * frame.height;
    if (frame.type !== 0 && frame.type !== 3) throw fault('JXL_INPUT', 'layer frame: regular/skip-progressive');
    const blend = layerBlend(layer, {source: canvasReference}, still.image.extraChannels);
    if ((typeof __RAPIER_JXL_FORMAT__ === 'undefined' || __RAPIER_JXL_FORMAT__ === true) && layer.extraBlending !== undefined && (!Array.isArray(layer.extraBlending) || layer.extraBlending.length !== still.image.extraChannels))
      throw fault('JXL_INPUT', 'extraBlending: one per extra channel');
    let extraBlending = (typeof __RAPIER_JXL_FORMAT__ === 'undefined' || __RAPIER_JXL_FORMAT__ === true) ? layer.extraBlending?.map(value => layerBlend(value, {...layer, source: blend.source}, still.image.extraChannels)) : undefined;
    const hasAlpha = still.image.channelInfo.some(channel => channel.kind === 0);
    for (const selection of [blend, ...(extraBlending ?? [])]) if (hasAlpha && (selection.mode === 2 || selection.mode === 3) && still.image.channelInfo[selection.alpha]?.kind !== 0)
      throw fault('JXL_INPUT', 'blend.alpha: alpha extra channel');
    if (blend.mode === 2 && hasAlpha) {
      extraBlending ??= Array.from({length: still.image.extraChannels}, () => ({...blend}));
      extraBlending[blend.alpha] = {...extraBlending[blend.alpha], mode: 2, alpha: blend.alpha, clamp: blend.clamp};
    }
    const full = item.x0 <= 0 && item.y0 <= 0 && item.x0 + frame.width >= width && item.y0 + frame.height >= height;
    if ((typeof __RAPIER_JXL_FORMAT__ === 'undefined' || __RAPIER_JXL_FORMAT__ === true) && item.frameType === 2 && !layer.beforeColorTransform && !full) throw fault('JXL_INPUT', 'reference: full canvas after color');
    if ((typeof __RAPIER_JXL_FORMAT__ === 'undefined' || __RAPIER_JXL_FORMAT__ === true) && layer.beforeColorTransform && item.frameType !== 2 && (!full || blend.mode !== 0 || i === layers.length - 1))
      throw fault('JXL_INPUT', 'beforeColorTransform: reference-only/full nonfinal replacement');
    encoded.push({...item, frame, blend, extraBlending, full});
    if (item.frameType !== 2 && i < layers.length - 1) canvasReference = item.reference;
  }
  if (!modular16 || compositePixels > 268435456) level = 10;
  if (config.requestedLevel === 5 && level === 10) throw fault('JXL_INPUT', 'level: 10 for frame/buffer');
  const first = encoded[0].still, writer = new BitWriter(256), canvas = {...first.image, width, height}, available = new Set([0]), before = new Set();
  writeStillImageHeader(writer, first, {width, height, modular16});
  if ((typeof __RAPIER_JXL_FORMAT__ === 'undefined' || __RAPIER_JXL_FORMAT__ === true) && first.preview) copyBits(writer, first.codestream, first.preview.start * 8, first.preview.end * 8);
  for (let i = 0; i < encoded.length; i++) {
    const item = encoded[i], {layer, blend, extraBlending, frameType, full} = item, last = i === encoded.length - 1;
    const selections = [blend, ...(extraBlending ?? [])];
    const blends = item.x0 || item.y0 || item.frame.width !== width || item.frame.height !== height || selections.some(selection => selection.mode);
    if (frameType !== 2) for (const selection of selections) {
      const slot = selection.mode || !full ? selection.source : 0;
      if (!available.has(slot)) throw fault('JXL_INPUT', 'reference slot: save before read');
      if ((typeof __RAPIER_JXL_FORMAT__ === 'undefined' || __RAPIER_JXL_FORMAT__ === true) && blends && before.has(slot)) throw fault('JXL_INPUT', `layer ${i} slot ${slot}: drop beforeColorTransform or change slot`);
    }
    writeStillFrame(writer, item.still, item.frame, {canvas, x0: item.x0, y0: item.y0, frameType, last,
      reference: item.reference, ...blend, extraBlending, ...((typeof __RAPIER_JXL_FORMAT__ === 'undefined' || __RAPIER_JXL_FORMAT__ === true) && {beforeColorTransform: layer.beforeColorTransform, name: layer.name})});
    if (!last) { available.add(item.reference); if ((typeof __RAPIER_JXL_FORMAT__ === 'undefined' || __RAPIER_JXL_FORMAT__ === true)) before[layer.beforeColorTransform ? 'add' : 'delete'](item.reference); }
    admitOutputSize(Math.ceil(writer.bitLength / 8)); yield .9 + .1 * (i + 1) / encoded.length;
  }
  const bytes = writer.finish();
  if (level !== 10) return bytes;
  const prefix = fileHeader(10), box = boxHeader(CODESTREAM, bytes.length), output = new Uint8Array(prefix.length + box.length + bytes.length);
  admitOutputSize(output.length); output.set(prefix); output.set(box, prefix.length); output.set(bytes, prefix.length + box.length); return output;
}
export function encodeLayersSteps(input, options = {}, encodeChannels = null, limits = LIMITS) { return job(layerSteps(layerAdmission(input, options, encodeChannels, limits))); }
