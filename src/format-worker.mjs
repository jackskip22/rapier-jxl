// SPDX-License-Identifier: MIT
import {byteView, codecError, JPEG_XL_LIMITS} from './worker-input.mjs';
import {checkSignal, finishEncoding} from './async-job.mjs';
import {encodePhotoSteps as advancedPhotoSteps} from './photo-advanced.mjs';
import {encodePhotoSteps as noisePhotoSteps} from './photo-noise.mjs';
import {encodeHybridSteps, hybridRegions} from './hybrid.mjs';
import {encodeDeltaPaletteSteps} from './delta-palette.mjs';
import {encodePatchesSteps} from './patches.mjs';
import {encodeSplinesSteps, splineStroke} from './splines.mjs';
import {encodeChannelsSteps} from './channels.mjs';
import {encodeLayersSteps} from './layers.mjs';
import {encodeProfileSteps} from './icc.mjs';
import {readSource} from './source.mjs';
import {withContainer, streamContainer} from './container-stream.mjs';
import {containerBoxHeader, inspectContainer, reframeContainer, frameIndexPayload, withFrameIndex, readFrameIndex, gainMapPayload, withGainMap, readGainMap} from './container-advanced.mjs';
import {withProgressiveContainer, progressiveContainerPlan, streamProgressiveContainer} from './progressive-container.mjs';
import {withMetadata, withCompressedMetadata, readMetadata, readMetadataAsync} from './metadata.mjs';
import {withOpsin} from './opsin.mjs';
import {deliveryLayout, withDeliveryOrder, normalizeDelivery} from './delivery.mjs';
import {createPhotoPlanSteps} from './photo-plan.mjs';
import {compressBrotli, decompressBrotli} from './brotli.mjs';

export const FORMAT_ACTIONS = Object.freeze(['photo', 'noise', 'hybrid', 'hybridRegions', 'deltaPalette', 'patches',
  'splines', 'splineStroke', 'channels', 'layers', 'profile', 'readSource', 'encodeSource', 'container',
  'streamContainer', 'inspectContainer', 'reframeContainer', 'progressiveContainer', 'progressivePlan', 'metadata',
  'compressedMetadata', 'readMetadata', 'readCompressedMetadata', 'opsin', 'frameIndex', 'readFrameIndex',
  'frameIndexPayload', 'gainMap', 'readGainMap', 'gainMapPayload', 'boxHeader', 'deliveryLayout', 'deliveryOrder',
  'normalizeDelivery', 'photoPlan', 'brotliCompress', 'brotliDecompress']);

function formatBytes(input) {
  const bytes = byteView(input);
  if (!bytes.length || bytes.length > JPEG_XL_LIMITS.bytes) throw codecError('JXL_INPUT', 'The image is empty or exceeds 16 MiB.');
  return bytes;
}
function formatPixels(input) {
  return input instanceof Uint16Array || input instanceof Float32Array ? input : byteView(input);
}
async function collectFormatChunks(source, signal) {
  const chunks = []; let length = 0;
  for await (const bytes of source) {
    checkSignal(signal); length += bytes.length;
    if (length > JPEG_XL_LIMITS.bytes) throw codecError('JXL_SIZE', 'The complete worker result exceeds 16 MiB.');
    chunks.push(bytes);
  }
  const bytes = new Uint8Array(length); let offset = 0;
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
  let plan, outputBytes = 0;
  const admitResult = bytes => {
    outputBytes += bytes.length;
    if (outputBytes > JPEG_XL_LIMITS.bytes) throw codecError('JXL_SIZE', 'The complete worker photo-plan result exceeds 16 MiB.');
  };
  try {
    plan = await finishEncoding(prepared, {signal, progress: progress(0)});
    const images = [];
    for (let i = 0; i < qualities.length; i++) {
      const bytes = await finishEncoding(plan.encodeSteps(qualities[i]), {signal, progress: progress(i + 1)});
      admitResult(bytes); images.push({quality: qualities[i], bytes});
    }
    let target = null;
    if (input.targetBytes !== undefined) {
      const search = plan.encodeTargetSteps(input.targetBytes, input.targetOptions);
      await finishEncoding(search, {signal, progress: progress(qualities.length + 1)});
      target = search.result; admitResult(target.bytes);
    }
    checkSignal(signal);
    onProgress?.(1);
    return {width: plan.width, height: plan.height, planningQuality: plan.planningQuality,
      retainedBytes: plan.retainedBytes, blockCount: plan.blockCount, strategies: plan.strategies, images, target};
  } finally { (plan ?? prepare.plan)?.dispose(); }
}

export async function format(input, {signal, onProgress} = {}) {
  checkSignal(signal);
  if (!input || typeof input !== 'object' || Array.isArray(input) || !FORMAT_ACTIONS.includes(input.action))
    throw codecError('JXL_OPERATION', 'Unknown JPEG XL format action.');
  const options = input.options === undefined ? {} : input.options;
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw codecError('JXL_OPTIONS', 'Format options are an object.');
  if (onProgress !== undefined && typeof onProgress !== 'function') throw codecError('JXL_OPTIONS', 'onProgress is a function.');
  const finish = job => finishEncoding(job, {signal, progress: onProgress});
  let result;
  switch (input.action) {
    case 'photo': return finish(advancedPhotoSteps(formatPixels(input.data), input.width, input.height, options));
    case 'noise': return finish(noisePhotoSteps(formatPixels(input.data), input.width, input.height, options));
    case 'hybrid': return finish(encodeHybridSteps(formatPixels(input.data), input.width, input.height, options));
    case 'hybridRegions': result = hybridRegions(formatPixels(input.data), input.width, input.height); break;
    case 'deltaPalette': return finish(encodeDeltaPaletteSteps(formatPixels(input.data), input.width, input.height, options));
    case 'patches': return finish(encodePatchesSteps(formatPixels(input.data), input.width, input.height, options));
    case 'splines': return finish(encodeSplinesSteps(formatPixels(input.data), input.width, input.height, options));
    case 'splineStroke': result = splineStroke(input.controlPoints, options); break;
    case 'channels': return finish(encodeChannelsSteps(input.image, options));
    case 'layers': return finish(encodeLayersSteps(input.image, options));
    case 'profile': return finish(encodeProfileSteps(formatPixels(input.data), input.width, input.height, options));
    case 'photoPlan': return formatPhotoPlan(input, options, signal, onProgress);
    case 'readSource': result = await readSource(formatBytes(input.bytes)); break;
    case 'encodeSource': {
      const {data, width, height, ...sourceOptions} = await readSource(formatBytes(input.bytes));
      checkSignal(signal);
      return finish(encodeProfileSteps(data, width, height, {...sourceOptions, ...options}));
    }
    case 'container': result = withContainer(formatBytes(input.bytes), {...options, signal}); break;
    case 'streamContainer': {
      if (!Array.isArray(input.chunks)) throw codecError('JXL_INPUT', 'Worker streamContainer takes an array of raw codestream chunks.');
      const chunks = input.chunks.map(byteView);
      if (chunks.reduce((sum, bytes) => sum + bytes.length, 0) > JPEG_XL_LIMITS.bytes) throw codecError('JXL_INPUT', 'Raw codestream chunks exceed 16 MiB.');
      result = await collectFormatChunks(streamContainer(chunks, {...options, signal}), signal); break;
    }
    case 'inspectContainer': result = inspectContainer(formatBytes(input.bytes), options); break;
    case 'reframeContainer': result = reframeContainer(formatBytes(input.bytes), options); break;
    case 'progressiveContainer': result = options.metadata === undefined
      ? withProgressiveContainer(formatBytes(input.bytes), {...options, signal})
      : await collectFormatChunks(streamProgressiveContainer(formatBytes(input.bytes), {...options,
        metadata: {...options.metadata, compress: compressBrotli}, signal}), signal); break;
    case 'progressivePlan': result = progressiveContainerPlan(formatBytes(input.bytes), {...options, signal}); break;
    case 'metadata': result = withMetadata(formatBytes(input.bytes), options); break;
    case 'compressedMetadata': result = await withCompressedMetadata(formatBytes(input.bytes), {...options, compress: compressBrotli}); break;
    case 'readMetadata': result = readMetadata(formatBytes(input.bytes)); break;
    case 'readCompressedMetadata': result = await readMetadataAsync(formatBytes(input.bytes), {...options, decompress: decompressBrotli}); break;
    case 'opsin': result = withOpsin(formatBytes(input.bytes), options); break;
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
  if (result instanceof Uint8Array && result.length > JPEG_XL_LIMITS.bytes) throw codecError('JXL_SIZE', 'The complete worker result exceeds 16 MiB.');
  onProgress?.(1);
  return result;
}
