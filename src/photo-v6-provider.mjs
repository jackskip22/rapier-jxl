// SPDX-License-Identifier: MIT
import {complete} from './bits.mjs';
import {photoXYBSteps} from './photo-xyb.mjs';
import {v6Image, v6Options} from './photo-v6.mjs';
import {v6For} from './photo-v6-settings.mjs';
import {fixedStrategyImage, lazyStrategyImage, materialize} from './varblock-core.mjs';
import {estimateBytes} from './coefficient-ans.mjs';
import {writeImage, writeImageSteps} from './photo-image-write.mjs';
import {journaling} from './step-journal.mjs';
export {S2_MARGIN} from './photo-whole-policy.mjs';

export function searchTransforms() { return null; }

export function stillPhotoProvider(prepared) {
  const {rgba, width, height} = prepared;
  return {
    width, height,
    base(quality, {filter = 'gaborish', fieldScale, keepPlanes = false} = {}) {
      if (filter === 'plain') return complete(photoXYBSteps(rgba, width, height, quality,
        {...v6For(width, height), ...prepared.color, dctCache: prepared.dctPlain, ...(keepPlanes && {keepPlanes})}));
      return v6Image(prepared, quality, {...(fieldScale !== undefined && {fieldScale}), ...(keepPlanes && {keepPlanes})});
    },
    *image(quality, options) { return this.base(quality, options); },
    blockOptions() { return {deadzone: v6Options(prepared, 75).deadzone, transforms: prepared.transforms ??= searchTransforms(prepared)}; },
    *layout(base, layout, options) {
      if (base.planeRows) return lazyStrategyImage(base, width, height, options, layout);
      const {transforms, ...deviceOptions} = options;
      const exact = yield {varblocks: {kind: 'layout', base, width, height, options: deviceOptions, layout}};
      return fixedStrategyImage(base, width, height, {...options, layout, ...(exact ? {exact} : {})}).image;
    },
    *write(image, effort) { return journaling() ? yield* writeImageSteps(image, effort) : writeImage(image, effort); },
    estimate(image) { return estimateBytes(materialize(image)); },
  };
}
