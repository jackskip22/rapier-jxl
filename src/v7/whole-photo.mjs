// SPDX-License-Identifier: MIT
import {wholePhotoSteps} from '../photo-whole-search.mjs';
import {fail} from './primitives.mjs';
import {MEASURED_EFFORT} from '../effort-level.mjs';

export function* wholePhotoOutputSteps(data, width, height, options, outputMeasure) {
  if (options.effort < MEASURED_EFFORT || options.quality >= 100) return yield* wholePhotoSteps(data, width, height, options);
  if (typeof outputMeasure !== 'function')
    throw fail('JXL_INTERNAL', 'A measured whole photo needs its selected actual-output owner.');
  let output = null, closed = false, failed = false;
  try {
    const prepared = outputMeasure({data, width, height, colorSpace: options.colorSpace ?? 'srgb'},
      {signal: options.signal, maxPixels: options.maxPixels}).then(value => {
        if (closed) { value?.destroy(); return null; }
        return output = value;
      });
    prepared.catch(() => {});
    yield {await: prepared, photoOutput: true};
    if (!output) return options.retainFloor ? yield* options.retainFloor(null) : null;
    const measureOutput = function* (bytes, want) {
      const measured = output.measure(bytes, want); measured.catch(() => {});
      return yield {await: measured, photoOutput: true};
    };
    return yield* wholePhotoSteps(data, width, height, {...options, measureOutput});
  } catch (error) { failed = true; throw error; }
  finally {
    closed = true;
    try { output?.destroy(); } catch (error) { if (!failed) throw error; }
    finally { output = null; }
  }
}
