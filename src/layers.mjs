// SPDX-License-Identifier: MIT
import {BitWriter, LIMITS, complete} from './bits.mjs';
import {fault, job, admitSize, admitOutputSize} from './admit.mjs';
import {encodeChannelsSteps} from './channels.mjs';
import {prepareICC} from './icc.mjs';
import {readStill, writeStillFrame, writeStillImageHeader, copyBits} from './framing.mjs';
import {fileHeader, boxHeader, CODESTREAM} from './container.mjs';

export {LIMITS};
export const LAYER_BLEND_MODES = Object.freeze({replace: 0, add: 1, blend: 2, muladd: 3, multiply: 4});
const layerModes = new Map(Object.entries(LAYER_BLEND_MODES));
function layerInteger(value, low, high, label) {
  if (!Number.isInteger(value) || value < low || value > high) throw fault('JXL_INPUT', label + ' is an integer from ' + low + ' to ' + high + '.');
  return value;
}
function layerObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fault('JXL_INPUT', label + ' is an object.');
}
function layerBlend(value, fallback, extras) {
  if (typeof value === 'string') value = {blend: value};
  layerObject(value, 'Layer blending');
  const name = value.blend ?? fallback.blend ?? 'replace', mode = layerModes.get(name);
  if (mode === undefined) throw fault('JXL_INPUT', 'Layer blend is replace, add, blend, muladd or multiply.');
  const source = layerInteger(value.source ?? fallback.source ?? 0, 0, 3, 'Reference source');
  const alpha = layerInteger(value.alpha ?? fallback.alpha ?? 0, 0, Math.min(10, Math.max(0, extras - 1)), 'Alpha selector');
  const clamp = value.clamp ?? fallback.clamp ?? false;
  if (typeof clamp !== 'boolean') throw fault('JXL_INPUT', 'Layer clamp is boolean.');
  return {mode, source, alpha, clamp};
}
function layerMetadataKey(still) {
  const w = new BitWriter(128), {image, codestream} = still;
  w.write(3, image.orientation - 1);
  copyBits(w, codestream, image.depthAt, image.modular16At);
  copyBits(w, codestream, image.modular16At + 1, image.toneAt);
  const defaultTone = !image.extra || !!(codestream[image.toneAt >> 3] >> (image.toneAt & 7) & 1);
  w.write(1, defaultTone ? 1 : 0);
  if (!defaultTone) copyBits(w, codestream, image.toneAt + 1, image.extensionsAt);
  copyBits(w, codestream, image.extensionsAt, image.payloadEnd);
  return w.bitLength + ':' + w.finish().join(',');
}
function layerAdmission(input, options) {
  layerObject(input, 'Layered image'); layerObject(options, 'Layer options');
  const {width, height, layers} = input; admitSize(width, height);
  if (!Array.isArray(layers) || !layers.length || layers.length > 256) throw fault('JXL_INPUT', 'A still has one to 256 authored layers.');
  if (options.preview !== undefined && (!options.preview || options.preview.maxDimension !== undefined))
    throw fault('JXL_INPUT', 'A layered still preview is an authored planar image of the finished composition.');
  const iccBits = options.icc === undefined ? undefined : prepareICC(options.icc, {compression: options.iccCompression,
    level: options.level, colorSpace: layers[0].image?.extraChannels?.some(channel => new Map(Object.entries(channel)).get('type') === 'black') ? 'cmyk' : undefined}).iccData.bitLength;
  const admitted = layers.map((layer, index) => {
    layerObject(layer, 'Layer ' + index);
    if ((layer.image === undefined) === (layer.bytes === undefined)) throw fault('JXL_INPUT', 'Each layer supplies either a planar image or encoded bytes.');
    const x0 = layerInteger(layer.x ?? 0, -536870911, 536870911, 'Layer x'), y0 = layerInteger(layer.y ?? 0, -536870911, 536870911, 'Layer y');
    const frameType = layer.referenceOnly ? 2 : layer.skipProgressive ? 3 : 0;
    if (layer.referenceOnly !== undefined && typeof layer.referenceOnly !== 'boolean' || layer.skipProgressive !== undefined && typeof layer.skipProgressive !== 'boolean')
      throw fault('JXL_INPUT', 'referenceOnly and skipProgressive are boolean.');
    if (layer.referenceOnly && layer.skipProgressive || frameType === 2 && (x0 || y0)) throw fault('JXL_INPUT', 'A reference-only frame has no canvas origin or progressive display role.');
    if (index === layers.length - 1 && frameType === 2) throw fault('JXL_INPUT', 'The final layer displays the finished canvas.');
    if (layer.name !== undefined && (typeof layer.name !== 'string' || new TextEncoder().encode(layer.name).length > 1071))
      throw fault('JXL_INPUT', 'A layer name is at most 1071 UTF-8 bytes.');
    const reference = layerInteger(layer.saveAs ?? (index === layers.length - 1 ? 0 : 3), 0, 3, 'Reference destination');
    if (layer.beforeColorTransform !== undefined && typeof layer.beforeColorTransform !== 'boolean') throw fault('JXL_INPUT', 'beforeColorTransform is boolean.');
    let still, operation;
    if (layer.bytes !== undefined) {
      if (!(layer.bytes instanceof Uint8Array) || !layer.bytes.length) throw fault('JXL_INPUT', 'Encoded layer bytes are a nonempty Uint8Array.');
      still = readStill(layer.bytes, {iccBits});
      if (!index && options.preview !== undefined) throw fault('JXL_INPUT', 'The first encoded layer already supplies the global image header; put its preview there.');
    } else {
      layerObject(layer.options ?? {}, 'Per-layer encoding options');
      for (const name of Object.keys(layer.options ?? {})) if (!['groupSize', 'predictor', 'upsampling'].includes(name))
        throw fault('JXL_INPUT', 'Per-layer options are groupSize, predictor and upsampling; image color and precision are shared.');
      operation = encodeChannelsSteps(layer.image, {...options, ...layer.options, preview: index ? undefined : options.preview});
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
    if (!item.still) {
      let step;
      do { step = item.operation.next(); if (!step.done) yield (i + step.value) / layers.length * .9; } while (!step.done);
      item.still = readStill(step.value, {iccBits});
    }
    const {still, layer} = item, key = layerMetadataKey(still);
    if (i && key !== metadata) throw fault('JXL_INPUT', 'All layers share identical channel metadata, color meaning, orientation and transform data.');
    metadata = key; modular16 &&= still.image.modular16; level = Math.max(level, still.level);
    if (still.frames.length !== 1) throw fault('JXL_INPUT', 'Each encoded layer is a single frame; author atlas references and LF pyramids through their dedicated encoders.');
    const frame = still.frames[0];
    compositePixels += frame.width * frame.height;
    if (frame.type !== 0 && frame.type !== 3) throw fault('JXL_INPUT', 'A layer begins with a regular or skip-progressive still frame.');
    const blend = layerBlend(layer, {source: canvasReference}, still.image.extraChannels);
    if (layer.extraBlending !== undefined && (!Array.isArray(layer.extraBlending) || layer.extraBlending.length !== still.image.extraChannels))
      throw fault('JXL_INPUT', 'extraBlending supplies one description per extra channel.');
    let extraBlending = layer.extraBlending?.map(value => layerBlend(value, {...layer, source: blend.source}, still.image.extraChannels));
    const hasAlpha = still.image.channelInfo.some(channel => channel.kind === 0);
    for (const selection of [blend, ...(extraBlending ?? [])]) if (hasAlpha && (selection.mode === 2 || selection.mode === 3) && still.image.channelInfo[selection.alpha]?.kind !== 0)
      throw fault('JXL_INPUT', 'An alpha-dependent blend selects an alpha extra channel.');
    if (blend.mode === 2 && hasAlpha) {
      extraBlending ??= Array.from({length: still.image.extraChannels}, () => ({...blend}));
      extraBlending[blend.alpha] = {...extraBlending[blend.alpha], mode: 2, alpha: blend.alpha, clamp: blend.clamp};
    }
    const full = item.x0 <= 0 && item.y0 <= 0 && item.x0 + frame.width >= width && item.y0 + frame.height >= height;
    if (item.frameType === 2 && !layer.beforeColorTransform && !full) throw fault('JXL_INPUT', 'A reference saved after color conversion covers the full canvas.');
    if (layer.beforeColorTransform && item.frameType !== 2 && (!full || blend.mode !== 0 || i === layers.length - 1))
      throw fault('JXL_INPUT', 'A before-color-transform reference is reference-only or a full, nonfinal replacement.');
    encoded.push({...item, frame, blend, extraBlending, full});
    if (item.frameType !== 2 && i < layers.length - 1) canvasReference = item.reference;
  }
  if (!modular16 || compositePixels > 268435456) level = 10;
  if (config.requestedLevel === 5 && level === 10) throw fault('JXL_INPUT', 'The composite frame area or channel buffers require JPEG XL level 10.');
  const first = encoded[0].still, writer = new BitWriter(256), canvas = {...first.image, width, height}, available = new Set([0]);
  writeStillImageHeader(writer, first, {width, height, modular16});
  if (first.preview) copyBits(writer, first.codestream, first.preview.start * 8, first.preview.end * 8);
  for (let i = 0; i < encoded.length; i++) {
    const item = encoded[i], {layer, blend, extraBlending, frameType, full} = item, last = i === encoded.length - 1;
    if (frameType !== 2) for (const selection of [blend, ...(extraBlending ?? [])])
      if ((selection.mode !== 0 || !full) && !available.has(selection.source)) throw fault('JXL_INPUT', 'A layer reads a reference slot before it is saved.');
    writeStillFrame(writer, item.still, item.frame, {canvas, x0: item.x0, y0: item.y0, frameType, last,
      reference: item.reference, ...blend, extraBlending, beforeColorTransform: layer.beforeColorTransform, name: layer.name});
    if (!last) available.add(item.reference);
    admitOutputSize(Math.ceil(writer.bitLength / 8)); yield .9 + .1 * (i + 1) / encoded.length;
  }
  const bytes = writer.finish();
  if (level !== 10) return bytes;
  const prefix = fileHeader(10), box = boxHeader(CODESTREAM, bytes.length), output = new Uint8Array(prefix.length + box.length + bytes.length);
  admitOutputSize(output.length); output.set(prefix); output.set(box, prefix.length); output.set(bytes, prefix.length + box.length); return output;
}
export function encodeLayers(input, options = {}) { return complete(encodeLayersSteps(input, options)); }
export function encodeLayersSteps(input, options = {}) { return job(layerSteps(layerAdmission(input, options))); }
