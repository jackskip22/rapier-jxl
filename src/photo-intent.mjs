// SPDX-License-Identifier: MIT
import {photoDomain, nativePhotoRGB8} from './photo-samples.mjs';
import {fault} from './fault.mjs';

export function photoIntentReader(nativeDecision, {signal, maxPixels} = {}) {
  if (typeof nativeDecision !== 'function') throw fault('JXL_INTERNAL', 'photo-intent:owner');
  let closed = false;
  const check = () => {
    if (signal?.aborted) throw signal.reason;
    if (closed) throw fault('JXL_INTERNAL', 'photo-intent:closed');
  };
  return {
    read(codec, picture, {exactAllowed = true, jpeg} = {}) {
      check();
      if (typeof exactAllowed !== 'boolean')
        throw fault('JXL_INTERNAL', 'photo-intent:order-1');
      if (codec.qualityIntent === undefined) {
        if (codec.quality === 100 && !exactAllowed)
          throw fault('JXL_UNSUPPORTED', 'exact photo: unsupported');
        return {quality: codec.quality, route: codec.quality === 100 ? 'exact' : 'private'};
      }
      const intent = codec.qualityIntent;
      if (!Number.isFinite(intent) || intent < 0 || intent >= 1)
        throw fault('JXL_INTERNAL', 'photo-intent:order-2');
      const domain = photoDomain(picture, {maxPixels});
      if (nativePhotoRGB8(picture, domain)) {
        const decision = nativeDecision(intent, picture, {exactAllowed, effort: codec.effort, jpeg});
        check();
        if (decision !== null) {
          if (!decision || !Number.isFinite(decision.quality) || decision.quality < 1 || decision.quality > 100 ||
              (decision.route !== 'exact' && decision.route !== 'photo') ||
              (decision.route === 'exact') !== (decision.quality === 100))
            throw fault('JXL_INTERNAL', 'photo-intent:route');
          if (decision.route === 'exact' && !exactAllowed)
            throw fault('JXL_UNSUPPORTED', 'exact photo: unsupported');
          return decision;
        }
      }
      if (!exactAllowed)
        throw fault('JXL_UNSUPPORTED', 'photo route: unsupported');
      return null;
    },
    async project(picture) {
      check();
      photoDomain(picture, {maxPixels});
      return {quality: 100, route: 'exact'};
    },
    destroy() { closed = true; nativeDecision = null; },
  };
}
