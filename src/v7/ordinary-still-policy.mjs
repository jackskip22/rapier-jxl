// SPDX-License-Identifier: MIT
import {photoIntentReader} from '../photo-intent.mjs';
import {lowWebpFacts, lowWebpDecision} from './low-webp-quality.mjs';
import {nativeStillPrediction, filteredStillQuality} from './native-still-prediction.mjs';
import {webpQuality} from './webp-quality.mjs';
import {fault} from '../fault.mjs';
import {profileTransform} from '../icc-transform.mjs';

export function ordinaryStillDecision(intent, picture, {exactAllowed = true, facts: suppliedFacts, effort, filteredStill = false} = {}) {
  if (!exactAllowed) return null;
  const facts = suppliedFacts ?? lowWebpFacts(picture);
  if (!facts.eligible) return null;
  if (facts.screenLike) {
    const quality = webpQuality(intent, picture);
    return {quality, route: quality === 100 ? 'exact' : 'photo', settled: true, facts};
  }
  if (facts.alpha !== false) return {quality: intent * 100, route: 'photo', settled: true, facts};
  const shared = lowWebpDecision(intent, picture, {facts});
  const quality = nativeStillPrediction(intent, facts, shared.quality);
  const lowFilteredQuality = filteredStill ? filteredStillQuality(intent, facts, quality, effort) : undefined;
  return {quality, route: quality === 100 ? 'exact' : 'photo', facts,
    ...(lowFilteredQuality !== undefined && {lowFilteredQuality})};
}

export function ordinaryStillReader(options) {
  const reader = photoIntentReader((intent, picture, capabilities) =>
    ordinaryStillDecision(intent, picture, {...capabilities, filteredStill: true}), options);
  const coding = (codec, decision) => {
    if (codec.qualityIntent === undefined) return codec;
    const {qualityIntent, ...rest} = codec;
    return decision.route === 'exact' ? {...rest, quality: 100}
      : decision.settled ? {...rest, quality: decision.quality} : {...rest, quality: decision.quality, lowWebp: qualityIntent,
        ...(decision.lowFilteredQuality !== undefined && {lowFilteredQuality: decision.lowFilteredQuality})};
  };
  let closed = false;
  const number = codec => {
    if (options?.signal?.aborted) throw options.signal.reason;
    if (closed) throw fault('JXL_INTERNAL', 'The photo intent reader is closed.');
    return coding(codec, {quality: codec.qualityIntent * 100, route: 'photo', settled: true});
  };
  return {
    read(codec, picture, capabilities) {
      if (codec.qualityIntent !== undefined && capabilities?.exactAllowed === false) return number(codec);
      const decision = reader.read(codec, picture, capabilities);
      return decision === null ? null : coding(codec, decision);
    },
    async project(codec, ownedPicture) {
      const projected = await reader.project(ownedPicture);
      if (codec.qualityIntent === undefined || ownedPicture?.icc && !profileTransform(ownedPicture.icc)) return coding(codec, projected);
      return number(codec);
    },
    destroy() { closed = true; reader.destroy(); },
  };
}
