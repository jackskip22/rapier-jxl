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
import {measuredLook, usesRegionalCalibration, landsAtEffort, landSteps} from '../photo-quality-table.mjs';
import {MEASURED_EFFORT} from '../effort-level.mjs';
import {profileTransform} from '../icc-transform.mjs';
import {largePhoto} from '../photo-low-settings.mjs';
import {filteredQuality} from '../photo-low.mjs';
import {UPLOAD_HIGH} from '../photo-v6-settings.mjs';
import {needsStillWindow, needsWideWindow, ownedStillWindow, ordinaryStillWindow, ordinaryStillWindowNow, earlierStillWindow, stillFloor, stillFloorSync,
  windowsReady, releaseWindows, windowsNow, stillWindowNow, retainedStillWindow, stillFloorNow} from './ordinary-still-window.mjs';
import {qualityLanding} from '../model-weights.mjs';

const MODEL_LEAST = 20, MODEL_ROOM = 3, MODEL_SIDE = 1280;

export function ordinaryStillDecision(intent, picture, {exactAllowed = true, facts: suppliedFacts, effort, filteredStill = false, wide = false, jpeg, shared: sharedLow = true} = {}) {
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
  const commonLow = sharedLow && sharesLowPicture(intent, facts, effort, {filteredStill, wide});
  const predictionEffort = wide && effort < MEASURED_EFFORT ? 1 : commonLow ? 3 : effort;
  const predicted = nativeStillPrediction(intent, facts, shared.quality, {effort: predictionEffort, jpeg});
  const reading = wide && predicted < 100 ? lowPhotoReading(intent, picture, predicted) : predicted;
  const curve = wide && predicted < 100 && intent <= 0.92 && smallReading(intent, facts.shorterSide) === Infinity
    ? Math.max(1, p3StillQuality(intent, reading, largePhoto(facts.width, facts.height), Math.max(facts.width, facts.height))) : reading;
  const filtered = q => filteredStill ? filteredStillQuality(intent, facts, q, commonLow ? 3 : effort, jpeg) : undefined;
  if (landsAtEffort(effort) && commonLow && curve < 100 && facts.blocks) {
    const start = Math.max(MODEL_LEAST, Math.min(98.5, Math.round(qualityLanding(intent, false, 3, facts).quality * 100) / 100));
    return {quality: Math.min(NATIVE_STILL_CALIBRATION.maximumLossy, Math.round((start + 0.5) * 100) / 100),
      lowFilteredQuality: start, calibratedWindow: true, landSteps: landSteps(effort), route: 'photo', facts};
  }
  const windowed = usesRegionalCalibration(intent, effort) || ownedStillWindow({route: 'photo', quality: curve, facts}, effort, intent);
  const model = !wide && sharedLow && filteredStill && curve < 100 && effort >= 1 && effort < MEASURED_EFFORT && windowed &&
    Math.max(facts.width, facts.height) <= MODEL_SIDE &&
    facts.blocks && facts.shorterSide >= 256 && !facts.palette && facts.preferXYB
    ? Math.max(MODEL_LEAST, commonLow && curve >= 80 ? 80 : 0, Math.round(qualityLanding(intent, false, 3, facts).quality * 100) / 100) : Infinity;
  const quality = model < curve - MODEL_ROOM ? model : curve, lowFilteredQuality = filtered(quality);
  return {quality, route: quality === 100 ? 'exact' : 'photo', facts,
    ...(quality < curve - 0.011 && {today: {quality: curve, lowFilteredQuality: filtered(curve)}}),
    ...(lowFilteredQuality !== undefined && {lowFilteredQuality})};
}

const sharesLowPicture = (intent, facts, effort, {filteredStill, wide}) => usesRegionalCalibration(intent, effort) && filteredStill && !wide &&
  effort >= 1 && effort < MEASURED_EFFORT && facts.shorterSide >= 256 && !facts.palette && facts.preferXYB;

const smoothScreenLift = q => 3 * Math.max(0, Math.min(1, (0.6 - q) / 0.1)) + 3 * Math.max(0, Math.min(1, (q - 0.85) / 0.07));

export const lowerOf = (reading, earlier) => {
  const lower = (a, b) => a < b - 0.011 ? a : b;
  const {lowFilteredQuality: filtered, today: _, ...rest} = reading;
  const quality = lower(reading.quality, earlier.quality);
  const lifted = reading.quality > earlier.quality + 0.011;
  const low = earlier.lowFilteredQuality === undefined ? undefined
    : filtered !== undefined ? lifted ? earlier.lowFilteredQuality : lower(filtered, earlier.lowFilteredQuality)
    : earlier.lowFilteredQuality < quality - 0.51 ? earlier.lowFilteredQuality : undefined;
  return {...rest, quality, ...(low !== undefined && {lowFilteredQuality: low})};
};

export function earlierStill(intent, picture, capabilities, decision) {
  const {effort} = capabilities, facts = decision.facts;
  const at = e => ordinaryStillDecision(intent, picture, {...capabilities, effort: e, filteredStill: true, shared: false, facts});
  const first = effort > 1 && sharesLowPicture(intent, facts, effort, {filteredStill: true, wide: false}) ? at(1) : null;
  return {earlier: at(effort), first};
}

const firstOwned = (first, intent) => !!first && ownedStillWindow(first, 1, intent);
export const firstStill = async (intent, picture, first, signal) =>
  firstOwned(first, intent) ? earlierStillWindow(intent, picture, first, 1, signal) : first;

const atMost = (a, b) => a <= b + 0.011;
export const lowerOfEarlier = (reading, earlier, first) => {
  const own = lowerOf(reading, earlier), low = first && lowerOf(reading, first);
  const filtered = low && atMost(low.lowFilteredQuality ?? filteredQuality(low.quality), own.lowFilteredQuality ?? filteredQuality(own.quality, false));
  const pick = low && atMost(low.quality, own.quality) && filtered ? low : own;
  const kept = earlier.lowFilteredQuality !== undefined && own.lowFilteredQuality === undefined && {...own, lowFilteredQuality: earlier.lowFilteredQuality};
  return low ? bothPictures(acrossStep(pick, [own, kept, low]), own, low) : acrossStep(pick, [own, kept]);
};

const bothPictures = (pick, own, low) => {
  const facts = pick.facts;
  if (!facts || !largePhoto(facts.width, facts.height) || (own.lowFilteredQuality === undefined) === (low.lowFilteredQuality === undefined)) return pick;
  const [filtered, plain] = own.lowFilteredQuality !== undefined ? [own, low] : [low, own];
  if (Math.abs(filtered.quality - plain.quality) > 1) return pick;
  return {...pick, quality: plain.quality, lowFilteredQuality: filtered.lowFilteredQuality, lowBoth: true};
};

const gaborishOf = d => d.lowFilteredQuality ?? (d.quality >= 80 ? filteredQuality(d.quality) : undefined);
const acrossStep = (pick, candidates) => {
  const g = gaborishOf(pick);
  if (!(g < UPLOAD_HIGH)) return pick;
  const other = Math.min(...candidates.filter(Boolean).map(gaborishOf).filter(q => q >= UPLOAD_HIGH && q - g <= 1));
  return other < Infinity ? {...pick, lowFilteredOther: other} : pick;
};

export const needsFloor = (decision, effort, intent) => {
  const f = decision?.facts;
  return !!f && usesRegionalCalibration(intent, effort) && effort >= 1 && effort < MEASURED_EFFORT && decision.route === 'photo' && !decision.settled &&
    decision.quality < NATIVE_STILL_CALIBRATION.maximumLossy && f.eligible && f.alpha === false && !f.palette && !f.screenLike && f.shorterSide >= 256;
};

function nativeNow(intent, picture, native, effort, signal, floor = stillFloorNow) {
  if (native.decision?.calibratedWindow) {
    const d = stillWindowNow(intent, picture, native.decision, effort, signal, false, null, null);
    return needsFloor(d, effort, intent) ? floor(intent, picture, d, signal) : d;
  }
  const first = native.first && (firstOwned(native.first, intent) ? retainedStillWindow(intent, picture, native.first, 1, signal) : native.first);
  let decision;
  if (native.earlier && effort < 3) {
    const cap = ownedStillWindow(native.earlier, effort, intent) ? retainedStillWindow(intent, picture, native.earlier, effort, signal) : native.earlier;
    decision = lowerOfEarlier(stillWindowNow(intent, picture, native.decision, effort, signal, false, cap), cap, first);
  } else {
    const sharedState = {};
    decision = stillWindowNow(intent, picture, native.decision, effort, signal, false, null, sharedState);
    if (native.earlier) decision = lowerOfEarlier(decision, ownedStillWindow(native.earlier, effort, intent)
      ? retainedStillWindow(intent, picture, native.earlier, effort, signal, sharedState) : native.earlier, first);
  }
  return needsFloor(decision, effort, intent) ? floor(intent, picture, decision, signal) : decision;
}

export function ordinaryStillReader(options) {
  const filteredStill = options?.filteredStill !== false;
  let pending = null;
  let later = null, laterAsked = false;
  const deferred = (intent, picture, decision) => { later = decision; return decision; };
  const floorOf = (intent, picture, decision, signal) => laterAsked ? deferred(intent, picture, decision) : stillFloorNow(intent, picture, decision, signal);
  const reader = photoIntentReader((intent, picture, capabilities) => {
    const decision = ordinaryStillDecision(intent, picture, {...capabilities, filteredStill});
    if (filteredStill && decision?.calibratedWindow) {
      const landed = d => needsFloor(d, capabilities.effort, intent) ? floorOf(intent, picture, d, options?.signal) : d;
      const now = ordinaryStillWindowNow(intent, picture, decision, capabilities.effort, options?.signal, null, landed);
      if (now) return now;
      if (windowsNow()) {
        try { return landed(stillWindowNow(intent, picture, decision, capabilities.effort, options?.signal, false, null, null)); }
        finally { releaseWindows(); }
      }
      pending = {decision}; return null;
    }
    if (filteredStill && needsStillWindow(decision, capabilities.effort, intent)) {
      const {earlier, first} = usesRegionalCalibration(intent, capabilities.effort) ? earlierStill(intent, picture, capabilities, decision) : {};
      const now = earlier && !ownedStillWindow(earlier, capabilities.effort, intent) && !firstOwned(first, intent) && ordinaryStillWindowNow(intent, picture, decision, capabilities.effort, options?.signal, earlier,
        reading => { const lower = lowerOfEarlier(reading, earlier, first);
          return needsFloor(lower, capabilities.effort, intent) ? floorOf(intent, picture, lower, options?.signal) : lower; });
      if (now) return now;
      if (windowsNow()) {
        try { return nativeNow(intent, picture, {decision, earlier, first}, capabilities.effort, options?.signal, floorOf); }
        finally { releaseWindows(); }
      }
      pending = {decision, earlier, first}; return null;
    }
    return filteredStill ? floorNow(intent, picture, capabilities.effort, decision) : decision;
  }, options);
  const floorNow = (intent, picture, effort, decision) => {
    if (!needsFloor(decision, effort, intent)) return decision;
    if (laterAsked) return deferred(intent, picture, decision);
    const floored = stillFloorSync(intent, picture, decision, options?.signal);
    if (floored) return floored;
    pending = {floor: decision}; return null;
  };
  const coding = (codec, decision) => {
    if (codec.qualityIntent === undefined) return codec;
    const {qualityIntent, ...rest} = codec;
    return decision.route === 'exact' ? {...rest, quality: 100}
      : decision.settled ? {...rest, quality: decision.quality} : {...rest, quality: decision.quality, lowIntent: qualityIntent,
        ...(decision.lowFilteredQuality !== undefined && {lowFilteredQuality: decision.lowFilteredQuality}),
        ...(decision.lowFilteredOther !== undefined && {lowFilteredOther: decision.lowFilteredOther}),
        ...(decision.lowBoth && {lowBoth: true})};
  };
  let closed = false;
  const number = codec => {
    if (options?.signal?.aborted) throw options.signal.reason;
    if (closed) throw fault('JXL_INTERNAL', 'ordinary-still-policy:result');
    return coding(codec, {quality: codec.qualityIntent * 100, route: 'photo', settled: true});
  };
  return {
    read(codec, picture, asked) {
      pending = null; later = null; laterAsked = asked?.floorLater === true;
      const capabilities = asked && 'floorLater' in asked ? (({floorLater: _later, ...rest}) => rest)(asked) : asked;
      if (codec.qualityIntent !== undefined && capabilities?.exactAllowed === false) {
        const decision = codec.effort < MEASURED_EFFORT ? reader.read(codec, picture, {...capabilities, exactAllowed: true}) : null;
        later = null;
        return decision?.facts && decision.facts.alpha !== false && decision.route === 'photo' ? coding(codec, decision) : number(codec);
      }
      const decision = reader.read(codec, picture, capabilities);
      return decision === null ? null : coding(codec, decision);
    },
    async project(codec, ownedPicture, {jpeg, floorLater = false} = {}) {
      const native = pending; pending = null; later = null; laterAsked = floorLater;
      const projected = await reader.project(ownedPicture);
      if (native?.floor) {
        const decision = await stillFloor(codec.qualityIntent, ownedPicture, native.floor, options?.signal);
        if (closed) throw fault('JXL_INTERNAL', 'ordinary-still-policy:closed');
        return coding(codec, decision);
      }
      if (native) {
        await windowsReady(options?.signal);
        let decision;
        try { decision = nativeNow(codec.qualityIntent, ownedPicture, native, codec.effort, options?.signal, floorOf); }
        finally { releaseWindows(); }
        if (closed) throw fault('JXL_INTERNAL', 'ordinary-still-policy:closed');
        return coding(codec, decision);
      }
      if (codec.qualityIntent === undefined || ownedPicture?.icc && !profileTransform(ownedPicture.icc)) return coding(codec, projected);
      if (ownedPicture?.colorSpace === 'display-p3') {
        let decision = ordinaryStillDecision(codec.qualityIntent, ownedPicture, {effort: codec.effort, filteredStill, wide: true, jpeg});
        if (decision && filteredStill && needsWideWindow(decision, codec.effort)) {
          decision = await ordinaryStillWindow(codec.qualityIntent, ownedPicture, decision, codec.effort, options?.signal, true);
          if (closed) throw fault('JXL_INTERNAL', 'ordinary-still-policy:closed');
        }
        if (decision) return coding(codec, decision);
      }
      if (statedPicture(ownedPicture)) {
        const {data, width, height} = ownedPicture, facts = lowIntentFacts({data, width, height});
        const decision = facts.eligible && !facts.screenLike && ordinaryStillDecision(codec.qualityIntent, ownedPicture, {effort: codec.effort, filteredStill: true, jpeg, facts});
        if (decision) return coding(codec, decision);
      }
      return number(codec);
    },
    deferredFloor() { return later; },
    async floor(codec, picture, decision) {
      const floored = await stillFloor(codec.qualityIntent, picture, decision, options?.signal);
      if (closed) throw fault('JXL_INTERNAL', 'ordinary-still-policy:closed');
      return coding(codec, floored);
    },
    destroy() { closed = true; pending = null; later = null; reader.destroy(); },
  };
}

export function predictedFacts(codec) {
  const intent = codec?.lowIntent;
  if (intent === undefined || !(intent > 0.92) || !(codec.quality < 100) || !((codec.effort ?? 0) < MEASURED_EFFORT)) return null;
  return {kept: 'lossy', measurements: [{metric: 'ssimulacra2', domain: 'predicted', floor: measuredLook(intent)}]};
}
