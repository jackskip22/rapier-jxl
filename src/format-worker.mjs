// SPDX-License-Identifier: MIT
import {byteView, codecError} from './worker-input.mjs';
import {guard, admitOutputSize} from './admit.mjs';
import {checkSignal, finishEncoding} from './async-job.mjs';
import {formatStill, STILL_FORMAT_ACTIONS, formatBytes, formatPixels, formatOptions} from './format-still.mjs';
import {encodePhotoSteps} from './photo-noise.mjs';
import {encodePhotoSteps as encodeAdvancedPhotoSteps} from './photo-advanced.mjs';
import {encodeHybridSteps, hybridRegions} from './hybrid.mjs';
import {encodeDeltaPaletteSteps} from './delta-palette.mjs';
import {encodeGraphicsSteps} from './graphics.mjs';
import {encodeAnimationAtlasSteps} from './animation-atlas.mjs';
import {admitAnimation} from './animation-frames.mjs';
import {atlasSearchOptions, discoverAtlasSteps} from './atlas-plan.mjs';
import {encodePatchesSteps, encodePatchCompositionSteps} from './patches.mjs';
import {encodeSplinesSteps, splineStroke} from './splines.mjs';
import {encodeChannelsSteps} from './channels.mjs';
import {encodeLayersSteps} from './layers.mjs';
import {withContainer, streamContainer} from './container-stream.mjs';
import {containerBoxHeader, inspectContainer, reframeContainer, frameIndexPayload, withFrameIndex, readFrameIndex, gainMapPayload, withGainMap, readGainMap} from './container-advanced.mjs';
import {withProgressiveContainer, progressiveContainerPlan, streamProgressiveContainer} from './progressive-container.mjs';
import {withMetadata, withCompressedMetadata, readMetadata, readMetadataAsync} from './metadata.mjs';
import {deliveryLayout, withDeliveryOrder, normalizeDelivery} from './delivery.mjs';
import {createPhotoPlanSteps} from './photo-plan.mjs';
import {compressBrotli, decompressBrotli} from './brotli.mjs';

export const FORMAT_ACTIONS = Object.freeze([...STILL_FORMAT_ACTIONS, 'noise', 'hybrid', 'hybridRegions', 'deltaPalette', 'patches', 'patchComposition',
  'splines', 'splineStroke', 'channels', 'layers', 'container',
  'streamContainer', 'inspectContainer', 'reframeContainer', 'progressiveContainer', 'progressivePlan', 'metadata',
  'compressedMetadata', 'readMetadata', 'readCompressedMetadata', 'frameIndex', 'readFrameIndex',
  'frameIndexPayload', 'gainMap', 'readGainMap', 'gainMapPayload', 'boxHeader', 'deliveryLayout', 'deliveryOrder',
  'normalizeDelivery', 'photoPlan', 'brotliCompress', 'brotliDecompress', 'graphics', 'animationAtlas', 'animationAtlasPlan']);

async function collectFormatChunks(source, signal) {
  const chunks = []; let length = 0;
  for await (const bytes of source) {
    checkSignal(signal); length += bytes.length;
    admitOutputSize(length);
    chunks.push(bytes);
  }
  const bytes = guard(() => new Uint8Array(length)); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

async function formatPhotoPlan(input, options, signal, onProgress) {
  const qualities = input.qualities ?? (input.targetBytes === undefined ? [options.quality ?? 90] : []);
  if (!Array.isArray(qualities) || qualities.length > 32 || qualities.some(q => !Number.isFinite(q) || q < 1 || q >= 100) ||
      !qualities.length && input.targetBytes === undefined)
    throw codecError('JXL_INPUT', 'A worker photo plan takes up to 32 qualities from one through less than 100, or a byte target.');
  const stages = 1 + qualities.length + (input.targetBytes === undefined ? 0 : 1);
  const prepare = createPhotoPlanSteps(formatPixels(input.data), input.width, input.height, options);
  const prepared = {[Symbol.iterator]: () => prepare, get bytes() { return prepare.plan; }};
  const progress = stage => fraction => { const value = (stage + fraction) / stages; if (value < 1) onProgress?.(value); };
  let plan;
  try {
    plan = await finishEncoding(prepared, {signal, progress: progress(0)});
    const images = [];
    for (let i = 0; i < qualities.length; i++) {
      const bytes = await finishEncoding(plan.encodeSteps(qualities[i]), {signal, progress: progress(i + 1)});
      images.push({quality: qualities[i], bytes});
    }
    let target = null;
    if (input.targetBytes !== undefined) {
      const search = plan.encodeTargetSteps(input.targetBytes, input.targetOptions);
      await finishEncoding(search, {signal, progress: progress(qualities.length + 1)});
      target = search.result;
    }
    checkSignal(signal);
    onProgress?.(1);
    return {width: plan.width, height: plan.height, planningQuality: plan.planningQuality,
      retainedBytes: plan.retainedBytes, blockCount: plan.blockCount, strategies: plan.strategies, images, target};
  } finally { (plan ?? prepare.plan)?.dispose(); }
}

async function formatAnimationAtlasPlan(animation, options, signal, onProgress) {
  const admitted = admitAnimation(animation, {}), search = atlasSearchOptions(options);
  if (!admitted.samples.native8) throw codecError('JXL_INPUT', 'Atlas discovery uses straight RGBA8 samples.');
  let plan = null;
  const iterator = (function* () { plan = yield* discoverAtlasSteps(admitted, search); })();
  return finishEncoding({[Symbol.iterator]: () => iterator, get bytes() { return plan; }}, {signal, progress: onProgress});
}

export async function format(input, {signal, onProgress} = {}) {
  checkSignal(signal);
  const options = formatOptions(input, onProgress);
  if (STILL_FORMAT_ACTIONS.includes(input.action)) return formatStill(input, {signal, onProgress}, encodeAdvancedPhotoSteps);
  if (!FORMAT_ACTIONS.includes(input.action))
    throw codecError('JXL_OPERATION', 'Unknown JPEG XL format action.');
  const finish = job => finishEncoding(job, {signal, progress: onProgress});
  let result;
  switch (input.action) {
    case 'noise': return finish(encodePhotoSteps(formatPixels(input.data), input.width, input.height, options));
    case 'hybrid': return finish(encodeHybridSteps(formatPixels(input.data), input.width, input.height, options));
    case 'hybridRegions': result = hybridRegions(formatPixels(input.data), input.width, input.height); break;
    case 'deltaPalette': return finish(encodeDeltaPaletteSteps(formatPixels(input.data), input.width, input.height, options));
    case 'graphics': return finish(encodeGraphicsSteps(formatPixels(input.data), input.width, input.height, options));
    case 'animationAtlas': return finish(encodeAnimationAtlasSteps(input.animation, options));
    case 'animationAtlasPlan': return formatAnimationAtlasPlan(input.animation, options, signal, onProgress);
    case 'patches': return finish(encodePatchesSteps(formatPixels(input.data), input.width, input.height, options));
    case 'patchComposition': return finish(encodePatchCompositionSteps(input.image, options));
    case 'splines': return finish(encodeSplinesSteps(formatPixels(input.data), input.width, input.height, options));
    case 'splineStroke': result = splineStroke(input.controlPoints, options); break;
    case 'channels': return finish(encodeChannelsSteps(input.image, options));
    case 'layers': return finish(encodeLayersSteps(input.image, options));
    case 'photoPlan': return formatPhotoPlan(input, options, signal, onProgress);
    case 'container': result = withContainer(formatBytes(input.bytes), {...options, signal}); break;
    case 'streamContainer': {
      if (!Array.isArray(input.chunks)) throw codecError('JXL_INPUT', 'Worker streamContainer takes an array of raw codestream chunks.');
      const chunks = input.chunks.map(byteView);
      result = await collectFormatChunks(streamContainer(chunks, {...options, signal}), signal); break;
    }
    case 'inspectContainer': result = inspectContainer(formatBytes(input.bytes), options); break;
    case 'reframeContainer': result = reframeContainer(formatBytes(input.bytes), options); break;
    case 'progressiveContainer': result = options.metadata === undefined
      ? withProgressiveContainer(formatBytes(input.bytes), {...options, signal})
      : await collectFormatChunks(streamProgressiveContainer(formatBytes(input.bytes), {...options,
        metadata: options.metadata, signal}), signal); break;
    case 'progressivePlan': result = progressiveContainerPlan(formatBytes(input.bytes), {...options, signal}); break;
    case 'metadata': result = withMetadata(formatBytes(input.bytes), options); break;
    case 'compressedMetadata': result = await withCompressedMetadata(formatBytes(input.bytes), options); break;
    case 'readMetadata': result = readMetadata(formatBytes(input.bytes)); break;
    case 'readCompressedMetadata': result = await readMetadataAsync(formatBytes(input.bytes), options); break;
    case 'frameIndex': result = withFrameIndex(formatBytes(input.bytes), input.index, options); break;
    case 'readFrameIndex': result = readFrameIndex(formatBytes(input.bytes), options); break;
    case 'frameIndexPayload': result = frameIndexPayload(input.index, options); break;
    case 'gainMap': result = withGainMap(formatBytes(input.bytes), input.bundle, options); break;
    case 'readGainMap': result = readGainMap(formatBytes(input.bytes), options); break;
    case 'gainMapPayload': result = gainMapPayload(input.bundle, options); break;
    case 'boxHeader': result = containerBoxHeader(input.boxType, input.bodyByteLength, options); break;
    case 'deliveryLayout': result = deliveryLayout(formatBytes(input.bytes), options); break;
    case 'deliveryOrder': result = withDeliveryOrder(formatBytes(input.bytes), options); break;
    case 'normalizeDelivery': result = normalizeDelivery(formatBytes(input.bytes), options); break;
    case 'brotliCompress': result = compressBrotli(byteView(input.bytes), options); break;
    case 'brotliDecompress': result = decompressBrotli(byteView(input.bytes), options); break;
  }
  checkSignal(signal);
  onProgress?.(1);
  return result;
}
