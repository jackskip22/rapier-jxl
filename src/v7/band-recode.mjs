import {shapeFloors, losslessSteps} from '../lossless.mjs';
import {photoXYBSteps} from '../photo-xyb.mjs';
import {photoV6Steps} from '../photo-v6.mjs';
import {v6Effort} from '../photo-job.mjs';
import {photoCoefficientSteps} from '../photo-dct.mjs';
import {coefficientAnsSteps} from '../coefficient-ans.mjs';
import {V6} from '../photo-v6-settings.mjs';
import {admitSampleFormat} from '../admit-samples.mjs';
import {P3_TRANSFORM, spaceTransform} from '../icc-transform.mjs';
import {fail} from './primitives.mjs';
import {lowPhotoSteps} from './low-photo.mjs';

export function* recodeBand({data, width, height, ...description}, settings, {xyb, alpha, gray}, hdr = null, writer = coefficientAnsSteps, search) {
  const options = {...description, ...settings}, {quality, effort, colorSpace = 'srgb', filter} = options;
  const eight = data instanceof Uint8Array || data instanceof Uint8ClampedArray;
  if (quality < 100 && xyb && !eight) {
    const coded = hdr && (yield* hdr.lossy(data, width, height, quality, effort, admitSampleFormat(data, options)));
    if (!coded) throw fail('JXL_INTERNAL', 'A band could not take the picture\'s XYB coding.');
    return coded;
  }
  if (quality >= 100 || !eight) {
    shapeFloors.set(data, {colour: gray ? 1 : 3, alpha});
    try { return yield* losslessSteps(data, width, height, {...options, fast: effort < 2}); }
    finally { shapeFloors.delete(data); }
  }
  if (xyb && !alpha && !gray && colorSpace === 'srgb') {
    const low = lowPhotoSteps(data, width, height, options);
    if (low) return yield* low;
    return yield* photoV6Steps(data, width, height, quality, v6Effort(effort), writer, search);
  }
  const transform = colorSpace === 'display-p3' ? P3_TRANSFORM : typeof colorSpace === 'object' ? spaceTransform(colorSpace) : undefined;
  const coefficients = yield* (xyb ? photoXYBSteps(data, width, height, quality, {...V6, filter, fast: !transform, ...(transform && {transform, space: colorSpace})})
    : photoCoefficientSteps(data, width, height, quality, colorSpace));
  coefficients.alpha = alpha ? data : null;
  return yield* coefficientAnsSteps(coefficients, effort);
}
