// SPDX-License-Identifier: MIT
import {fitSearch} from '../target-search.mjs';
import {ordinaryStillDecision} from './ordinary-still-policy.mjs';
import {lowIntentFacts} from './low-intent-quality.mjs';
import {fitOptions} from './preparation-options.mjs';
import {encodeOptions} from './encode-options.mjs';
import {check, fail, callers, isCaller, progressOf, PIXELS} from './primitives.mjs';
import {acquireSource} from './preparation-source.mjs';
import {preparedResult, preparedEncode, finishPrepared} from './preparation-result.mjs';
import {FIT_BYTES, RESULT_REFERENCE, resultFacts, originalSize} from './result-reference.mjs';
import {JPEG_SOURCE, jpegSource, chooseJpeg} from './jpeg-choice.mjs';
import {sourceIntent} from './preparation-source.mjs';
import {withRenderingIntent} from './header-intent.mjs';
import {journaled} from '../step-journal.mjs';

export const INTENT_BYTES = 4;
export const intended = (result, source) => result.bytes && sourceIntent(source) ? {...result, bytes: withRenderingIntent(result.bytes, sourceIntent(source))} : result;
export const intentPolicy = (policy, source) => sourceIntent(source) && policy.maxBytes > INTENT_BYTES ? {...policy, maxBytes: policy.maxBytes - INTENT_BYTES} : policy;
import {PREVIEW} from './preview.mjs';

export function fitSettle(picture, effort, jpeg) {
  let facts;
  return q => {
    const decision = ordinaryStillDecision(q / 100, picture, {facts: facts ??= lowIntentFacts(picture), effort, filteredStill: true, jpeg});
    return decision?.lowFilteredQuality !== undefined ? decision.lowFilteredQuality + 0.5 : decision?.quality ?? q;
  };
}

export function knownFitProbe(policy) {
  const {encode: options, search} = policy, named = options.features && Object.keys(options.features);
  return policy.probed ?? (named && !(named.length === 1 && named[0] === 'firstRegion') &&
    search.maxQuality === 100 && search.minQuality < 100 ? {quality: 100, bytes: null} : null);
}

export async function fitPrepared(encode, picture, policy, capabilities = {}) {
  const {maxBytes, search, encode: options} = policy, {signal, onProgress: report, ...rest} = options;
  const probed = knownFitProbe(policy);
  let previous = -1;
  const onProgress = report && (fraction => {
    if (!Number.isFinite(fraction) || fraction <= previous) return;
    previous = fraction;
    try { report(fraction); } catch (error) { throw callers(error); }
  });
  const initial = policy.probed ? [policy.probed] : null, spent = policy.spentProbes ?? 0;
  const settleEffort = rest.effort ?? (capabilities.admitEncode ?? encodeOptions)({}).effort;
  const original = rest[JPEG_SOURCE];
  const candidates = fitSearch(maxBytes, {...search, maxProbes: search.maxProbes - spent,
    picture, effort: rest.effort, initial, settle: picture?.data && fitSettle(picture, settleEffort,
      original?.preserve === false || rest.readAs !== undefined ? undefined : original?.info)});
  const facts = new WeakMap();
  let next = candidates.next(), count = spent + (initial?.length ?? 0), reuse, encoded = false, failed = false;
  try {
    while (!next.done) {
      check(signal);
      let bytes = null;
      try {
        const hooks = {signal, ...(onProgress && {onProgress: fraction => onProgress((count + fraction) / search.maxProbes)})};
        const known = probed !== null && probed.quality === next.value;
        if (known) bytes = probed.bytes;
        else if (encoded) {
          if (reuse === undefined) reuse = capabilities.retainedFit?.(picture, policy) ?? null;
          const result = await reuse?.probe(next.value, hooks);
          bytes = result?.bytes ?? null;
          if (bytes instanceof Uint8Array) facts.set(bytes, result);
        }
        if (!bytes && !known) {
          const probe = () => preparedEncode(encode, picture, {...rest, fidelity: {quality: next.value}, ...hooks,
            ...(!encoded && capabilities.fitTarget && {[FIT_BYTES]: {maxBytes, minQuality: search.minQuality, maxQuality: search.maxQuality, candidates: (pixels, [minQuality, maxQuality] = []) => fitSearch(maxBytes, {...search, maxProbes: search.maxProbes - spent, picture: pixels, effort: rest.effort, ...(minQuality !== undefined && {minQuality, maxQuality})})}})});
          const result = capabilities.journal ? await journaled(capabilities.journal, 'fit-encode', probe) : await probe();
          bytes = result.bytes;
          if (bytes instanceof Uint8Array) facts.set(bytes, result);
          if (result.fitted) {
            onProgress?.(1); check(signal);
            const {fitted: {quality, fits}, ...found} = result, {width, height} = picture;
            return fits ? {...preparedResult(bytes, {quality}, picture), ...found, bytes} : {meetsTarget: false, width, height};
          }
          encoded = true;
        }
      } catch (error) {
        check(signal);
        if (isCaller(error)) throw error;
        if (!capabilities.qualityMiss?.(error) && error?.code !== 'JXL_SIZE' &&
            !(error?.code === 'JXL_LIMIT' && error.cause?.code === 'JXL_SIZE')) throw error;
      }
      check(signal);
      if (bytes !== null && (!(bytes instanceof Uint8Array) || !bytes.byteLength))
        throw fail('JXL_INTERNAL', "Incomplete output file; report the input and options.");
      if (bytes) options[PREVIEW]?.(bytes, {width: picture.width, height: picture.height, measurements: facts.get(bytes)?.measurements ?? []});
      count++;
      next = candidates.next({bytes});
    }
    onProgress?.(1); check(signal);
    const {bytes, quality} = next.value, {width, height} = picture;
    return bytes ? {...preparedResult(bytes, quality === 100 ? 'exact' : {quality}, picture), ...facts.get(bytes)}
      : {meetsTarget: false, width, height};
  } catch (error) { failed = true; throw error; }
  finally {
    let cleanup, broken = false;
    try { candidates.return(); } catch (error) { cleanup = error; broken = true; }
    try { reuse?.dispose(); } catch (error) { if (!broken) { cleanup = error; broken = true; } }
    if (broken && !failed) throw cleanup;
  }
}

export async function fitWith(encode, input, options, hooks = {}) {
  const original = options?.[JPEG_SOURCE];
  if (original !== undefined) options = (({[JPEG_SOURCE]: _jpeg, ...rest}) => rest)(options);
  const policy = fitOptions(options, hooks.admitEncode);
  policy.encode.onProgress = progressOf(policy.encode.onProgress, policy.encode.signal);
  const source = jpegSource(input, original), selected = {};
  let orientation, picture, fitted;
  const choosing = {...policy.encode, [RESULT_REFERENCE]: (reference, _source, facts) => {
    if (reference) picture = reference;
    if (facts) Object.assign(selected, facts);
  }};
  const pixels = async (settings = policy.encode, jpeg, spentProbes = 0) => {
    picture = await acquireSource(input, settings, {...hooks, reference: value => { orientation = value.orientation; }});
    const {readAs: _spent, ...encoding} = settings;
    const context = jpeg ? {[JPEG_SOURCE]: {bytes: source, info: jpeg,
      preserve: original?.preserve !== false && settings.readAs === undefined}, jpeg: 'pixels'} : {};
    fitted = intended(await fitPrepared(encode, picture, {...intentPolicy(policy, picture),
      spentProbes: spentProbes + (original?.spentProbes ?? 0),
      encode: {...encoding, ...context}}, hooks), picture);
    resultFacts(settings, fitted);
    return fitted.bytes;
  };
  const effort = policy.encode.effort ?? (hooks.admitEncode ? hooks.admitEncode({}).effort : hooks.carriesJpeg ? 3 : 7);
  const bytes = source ? await chooseJpeg(source, {effort, quality: policy.search.maxQuality === 100 ? 100 : 90,
    qualityIntent: policy.search.maxQuality / 100}, choosing, {signal: policy.encode.signal,
      maxPixels: policy.encode.maxPixels ?? PIXELS, maxBytes: policy.maxBytes, probes: policy.search.maxProbes,
      journal: hooks.journal, preserve: original?.preserve !== false,
      carry: (original, effort, carryHooks) => encode(new Blob([original], {type: 'image/jpeg'}), {
        fidelity: 'exact', effort, maxPixels: carryHooks.maxPixels, signal: carryHooks.signal,
        onProgress: carryHooks.onProgress})}, pixels) : await pixels();
  const result = bytes ? {...preparedResult(bytes, selected.fidelity ?? fitted?.fidelity ?? 'exact', picture,
    selected.kept === 'jpeg-bytes' ? 'jpeg' : undefined), ...fitted, ...selected, bytes} : fitted;
  const originalBytes = selected.originalBytes ?? originalSize(input);
  if (originalBytes !== undefined) result.originalBytes = originalBytes;
  return finishPrepared(result, picture, {
    fidelity: policy.requestedFidelity, readAs: policy.encode.readAs, maxBytes: policy.maxBytes, signal: policy.encode.signal,
    ...(result.kept !== 'jpeg-bytes' && orientation > 1 && {transform: {width: picture.width, height: picture.height}})});
}
