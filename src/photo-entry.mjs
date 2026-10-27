// SPDX-License-Identifier: MIT
import {PHOTO_LIMITS} from './bits.mjs';
import {readImage} from './image-source.mjs';
import {encodePhotoSteps, encodePhotoGpuSteps} from './photo.mjs';
import {encodeToScore, encodeToScoreSteps} from './score.mjs';
import {photoV6MeasuredJob} from './photo-v6-search.mjs';
import {preferXYB} from './photo-xyb.mjs';
import {GpuMeasure} from './gpu-reconstruct.mjs';
import {attachVarblocks} from './gpu-varblocks.mjs';
import {gpuJob} from './gpu-drive.mjs';
import {optionalDevice} from './capture-gpu.mjs';
import {imageOptions, imageColor} from './encode-options.mjs';
import {finishEncoding, checkSignal} from './async-job.mjs';
import {job} from './admit.mjs';
import {fault} from './fault.mjs';

export {LIMITS, encodePhoto, encodePhotoSteps, encodePhotoGpuSteps} from './photo.mjs';
export {encodeToScore, encodeToScoreSteps} from './score.mjs';

/** High-quality photographs, or the smallest searched file meeting an explicit perceptual target. */
export async function encode(source, options = {}) {
  const limits = imageOptions(options, PHOTO_LIMITS), image = await readImage(source, false, limits);
  if (options.maxError !== undefined) throw fault('JXL_OPTIONS', 'maxError belongs to the capture encoder.');
  const colorSpace = imageColor(image, options), effort = options.effort === undefined ? 9 : options.effort, quality = options.quality === undefined ? 90 : options.quality;
  if (options.icc !== undefined && (options.colorSpace !== undefined || image.colorSpace !== undefined))
    throw fault('JXL_INPUT', 'An ICC profile supplies the color encoding; omit other color declarations.');
  const settings = {...options, quality, effort, ...(options.icc === undefined ? {colorSpace} : {})}, finish = steps => finishEncoding(steps, {signal: options.signal, progress: options.onProgress});
  checkSignal(options.signal);
  const {data, width, height} = image;
  // Constructing the CPU job validates options before optional GPU work.
  const cpu = encodePhotoSteps(data, width, height, settings);
  if (options.target !== undefined && (colorSpace !== 'srgb' || options.icc !== undefined)) throw fault('JXL_INPUT', 'Perceptual targets require sRGB pixels.');
  const device = options.gpu !== 'cpu' && width * height >= 1 << 20 ? await optionalDevice() : null;
  checkSignal(options.signal);
  if (options.target !== undefined) {
    if (device) {
      try {
        const result = await encodeToScore(data, width, height, {...options, effort, gpu: device,
          onProgress: fraction => { checkSignal(options.signal); options.onProgress?.(fraction); }});
        checkSignal(options.signal); options.onProgress?.(1); return result.bytes;
      } catch (error) { checkSignal(options.signal); if (error.code) throw error; }
    }
    return finish(job((function* () { return (yield* encodeToScoreSteps(data, width, height, {...options, effort})).bytes; })()));
  }
  if (device && quality < 100 && colorSpace === 'srgb' && options.icc === undefined && (data instanceof Uint8Array || data instanceof Uint8ClampedArray) && preferXYB(data, width, height)) {
    let measure;
    try {
      if (effort >= 8) {
        measure = await attachVarblocks(await GpuMeasure.create(device, data, width, height), device);
        return await finish(photoV6MeasuredJob(data, width, height, quality, effort, measure));
      }
      return await finish(gpuJob(encodePhotoGpuSteps(data, width, height, settings), device));
    } catch (error) { checkSignal(options.signal); if (error.code) throw error; }
    finally { measure?.destroy(); }
  }
  return finish(cpu);
}
