// SPDX-License-Identifier: MIT
import {photoIntentReader} from '../photo-intent.mjs';
import {lowIntentFacts, lowIntentDecision, lowPhotoReading, p3StillQuality} from './low-intent-quality.mjs';
import {nativeStillPrediction, filteredStillQuality, alphaStillQuality, ALPHA_OPAQUE, NATIVE_STILL_CALIBRATION} from './native-still-prediction.mjs';
import {qualityForIntent, smallReading} from './intent-quality.mjs';
import {fault} from '../fault.mjs';
import {admitSampleFormat, statedSpace} from '../admit-samples.mjs';
const statedPicture = picture => {
  if (!picture || picture.icc !== undefined || picture.orientation !== undefined || picture.extraChannels !== undefined) return false;
  try { return !!statedSpace(admitSampleFormat(picture.data, picture)); } catch { return false; }
};
import {measuredLook} from '../photo-quality-table.mjs';
import {MEASURED_EFFORT} from '../effort-level.mjs';
import {profileTransform} from '../icc-transform.mjs';
import {largePhoto} from '../photo-low-settings.mjs';
import {needsStillWindow, ordinaryStillWindow} from './ordinary-still-window.mjs';

export function ordinaryStillDecision(intent, picture, {exactAllowed = true, facts: suppliedFacts, effort, filteredStill = false, wide = false, jpeg} = {}) {
  if (!exactAllowed) return null;
  const read = suppliedFacts ?? lowIntentFacts(picture, {wide});
  if (!read.eligible) return null;
  const recast = read.soft === true && read.palette && read.smooth !== true && !read.screenLike && intent < NATIVE_STILL_CALIBRATION.exactIntent &&
    effort >= 1 && effort < MEASURED_EFFORT;
  const facts = recast ? {...read, palette: false} : read;
  if (facts.screenLike) {
    const quality = Math.min(100, qualityForIntent(intent, picture) + (facts.smooth && effort >= 1 && effort < MEASURED_EFFORT ? smoothScreenLift(intent) : 0));
    return {quality, route: quality === 100 ? 'exact' : 'photo', settled: true, facts};
  }
  if (facts.alpha !== false) {
    if (effort >= MEASURED_EFFORT) return {quality: intent * 100, route: 'photo', facts};
    const opaque = facts.visibleShare >= ALPHA_OPAQUE.share && facts.shorterSide < ALPHA_OPAQUE.side
      ? nativeStillPrediction(intent, {...facts, alpha: false}, lowIntentDecision(intent, picture, {facts}).quality, {effort, jpeg}) : null;
    return {quality: alphaStillQuality(intent, facts, opaque), route: 'photo', facts};
  }
  if (facts.smooth === true && effort >= 1) return {quality: 100, route: 'exact', facts};
  const shared = lowIntentDecision(intent, picture, {facts});
  const predicted = nativeStillPrediction(intent, facts, shared.quality, {effort: wide && effort < MEASURED_EFFORT ? 1 : effort, jpeg});
  const reading = wide && predicted < 100 ? lowPhotoReading(intent, picture, predicted) : predicted;
  const quality = wide && predicted < 100 && intent <= 0.92 && smallReading(intent, facts.shorterSide) === Infinity
    ? Math.max(1, p3StillQuality(intent, reading, largePhoto(facts.width, facts.height))) : reading;
  const lowFilteredQuality = filteredStill ? filteredStillQuality(intent, facts, quality, effort, jpeg) : undefined;
  return {quality, route: quality === 100 ? 'exact' : 'photo', facts,
    ...(lowFilteredQuality !== undefined && {lowFilteredQuality})};
}

const smoothScreenLift = q => 3 * Math.max(0, Math.min(1, (0.6 - q) / 0.1)) + 3 * Math.max(0, Math.min(1, (q - 0.85) / 0.07));

export function ordinaryStillReader(options) {
  const filteredStill = options?.filteredStill !== false;
  let pending = null;
  const reader = photoIntentReader((intent, picture, capabilities) => {
    const decision = ordinaryStillDecision(intent, picture, {...capabilities, filteredStill});
    if (filteredStill && needsStillWindow(decision, capabilities.effort, intent)) { pending = decision; return null; }
    return decision;
  }, options);
  const coding = (codec, decision) => {
    if (codec.qualityIntent === undefined) return codec;
    const {qualityIntent, ...rest} = codec;
    return decision.route === 'exact' ? {...rest, quality: 100}
      : decision.settled ? {...rest, quality: decision.quality} : {...rest, quality: decision.quality, lowIntent: qualityIntent,
        ...(decision.lowFilteredQuality !== undefined && {lowFilteredQuality: decision.lowFilteredQuality})};
  };
  let closed = false;
  const number = codec => {
    if (options?.signal?.aborted) throw options.signal.reason;
    if (closed) throw fault('JXL_INTERNAL', "Invalid image result; report the input and options.");
    return coding(codec, {quality: codec.qualityIntent * 100, route: 'photo', settled: true});
  };
  return {
    read(codec, picture, capabilities) {
      pending = null;
      if (codec.qualityIntent !== undefined && capabilities?.exactAllowed === false) {
        const decision = codec.effort < MEASURED_EFFORT ? reader.read(codec, picture, {...capabilities, exactAllowed: true}) : null;
        return decision?.facts && decision.facts.alpha !== false && decision.route === 'photo' ? coding(codec, decision) : number(codec);
      }
      const decision = reader.read(codec, picture, capabilities);
      return decision === null ? null : coding(codec, decision);
    },
    async project(codec, ownedPicture, {jpeg} = {}) {
      const native = pending; pending = null;
      const projected = await reader.project(ownedPicture);
      if (native) {
        const decision = await ordinaryStillWindow(codec.qualityIntent, ownedPicture, native, codec.effort, options?.signal);
        if (closed) throw fault('JXL_INTERNAL', 'The photo intent reader is closed.');
        return coding(codec, decision);
      }
      if (codec.qualityIntent === undefined || ownedPicture?.icc && !profileTransform(ownedPicture.icc)) return coding(codec, projected);
      if (ownedPicture?.colorSpace === 'display-p3') {
        const decision = ordinaryStillDecision(codec.qualityIntent, ownedPicture, {effort: codec.effort, filteredStill, wide: true, jpeg});
        if (decision) return coding(codec, decision);
      }
      if (statedPicture(ownedPicture)) {
        const {data, width, height} = ownedPicture, facts = lowIntentFacts({data, width, height});
        const decision = facts.eligible && !facts.screenLike && ordinaryStillDecision(codec.qualityIntent, ownedPicture, {effort: codec.effort, filteredStill: true, jpeg, facts});
        if (decision) return coding(codec, decision);
      }
      return number(codec);
    },
    destroy() { closed = true; pending = null; reader.destroy(); },
  };
}

export function predictedFacts(codec) {
  const intent = codec?.lowIntent;
  if (intent === undefined || !(intent > 0.92) || !(codec.quality < 100) || !((codec.effort ?? 0) < MEASURED_EFFORT)) return null;
  return {kept: 'lossy', measurements: [{metric: 'ssimulacra2', domain: 'predicted', floor: measuredLook(intent)}]};
}
