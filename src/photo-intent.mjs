// SPDX-License-Identifier: MIT
import {photoDomain, nativePhotoRGB8} from './photo-samples.mjs';
import {fault} from './fault.mjs';

export function photoIntentReader(nativeDecision, {signal, maxPixels} = {}) {
  if (typeof nativeDecision !== 'function') throw fault('JXL_INTERNAL', 'Photo intent needs its native prediction owner.');
  let closed = false;
  const check = () => {
    if (signal?.aborted) throw signal.reason;
    if (closed) throw fault('JXL_INTERNAL', 'The photo intent reader is closed.');
  };
  return {
    read(codec, picture, {exactAllowed = true} = {}) {
      check();
      if (typeof exactAllowed !== 'boolean')
        throw fault('JXL_INTERNAL', 'Photo intent must be admitted before source settlement.');
      if (codec.qualityIntent === undefined) {
        if (codec.quality === 100 && !exactAllowed)
          throw fault('JXL_UNSUPPORTED', 'This producer cannot represent the required exact photo.');
        return {quality: codec.quality, route: codec.quality === 100 ? 'exact' : 'private'};
      }
      const intent = codec.qualityIntent;
      if (!Number.isFinite(intent) || intent < 0 || intent >= 1)
        throw fault('JXL_INTERNAL', 'Photo intent must be admitted before source settlement.');
      const domain = photoDomain(picture, {maxPixels});
      if (nativePhotoRGB8(picture, domain)) {
        const decision = nativeDecision(intent, picture, {exactAllowed, effort: codec.effort});
        check();
        if (decision !== null) {
          if (!decision || !Number.isFinite(decision.quality) || decision.quality < 1 || decision.quality > 100 ||
              (decision.route !== 'exact' && decision.route !== 'photo') ||
              (decision.route === 'exact') !== (decision.quality === 100))
            throw fault('JXL_INTERNAL', 'A native photo prediction must name an applicable coding route.');
          if (decision.route === 'exact' && !exactAllowed)
            throw fault('JXL_UNSUPPORTED', 'This producer cannot represent the required exact photo.');
          return decision;
        }
      }
      if (!exactAllowed)
        throw fault('JXL_UNSUPPORTED', 'This producer has no applicable lossy prediction or exact photo representation.');
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
