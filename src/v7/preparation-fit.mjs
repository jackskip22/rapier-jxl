// SPDX-License-Identifier: MIT
import {fitSearch} from '../target-search.mjs';
import {ordinaryStillDecision} from './ordinary-still-policy.mjs';
import {lowWebpFacts} from './low-webp-quality.mjs';
import {fitOptions} from './preparation-options.mjs';
import {check, fail, callers, isCaller, progressOf} from './primitives.mjs';
import {acquireSource} from './preparation-source.mjs';
import {preparedResult, preparedEncode, finishPrepared} from './preparation-result.mjs';
import {jpegDisplayDimensions, jpegReconstruction} from './preparation-jpeg.mjs';
import {admitJpeg} from './input.mjs';
import {FIT_BYTES} from './result-reference.mjs';
import {sourceIntent} from './preparation-source.mjs';
import {withRenderingIntent} from './header-intent.mjs';
import {journaled} from '../step-journal.mjs';

export const INTENT_BYTES = 4;
export const intended = (result, source) => result.bytes && sourceIntent(source) ? {...result, bytes: withRenderingIntent(result.bytes, sourceIntent(source))} : result;
export const intentPolicy = (policy, source) => sourceIntent(source) && policy.maxBytes > INTENT_BYTES ? {...policy, maxBytes: policy.maxBytes - INTENT_BYTES} : policy;
import {PREVIEW} from './preview.mjs';

export function fitSettle(picture) {
  let facts;
  return q => (ordinaryStillDecision(q / 100, picture, {facts: facts ??= lowWebpFacts(picture)}) ?? {quality: q}).quality;
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
  const candidates = fitSearch(maxBytes, {...search, maxProbes: search.maxProbes - spent,
    picture, effort: rest.effort, initial, settle: picture?.data && fitSettle(picture)});
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
            return fits ? {...preparedResult(bytes, {quality}, picture), ...found, bytes} : {fits: false, width, height};
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
        throw fail('JXL_INTERNAL', 'The encoder must return a nonempty Uint8Array.');
      if (bytes) options[PREVIEW]?.(bytes, {width: picture.width, height: picture.height, measurements: facts.get(bytes)?.measurements ?? []});
      count++;
      next = candidates.next({bytes});
    }
    onProgress?.(1); check(signal);
    const {bytes, quality} = next.value, {width, height} = picture;
    return bytes ? {...preparedResult(bytes, quality === 100 ? 'exact' : {quality}, picture), ...facts.get(bytes)}
      : {fits: false, width, height};
  } catch (error) { failed = true; throw error; }
  finally {
    let cleanup, broken = false;
    try { candidates.return(); } catch (error) { cleanup = error; broken = true; }
    try { reuse?.dispose(); } catch (error) { if (!broken) { cleanup = error; broken = true; } }
    if (broken && !failed) throw cleanup;
  }
}

export async function fitWith(encode, input, options, hooks = {}) {
  let policy = fitOptions(options, hooks.admitEncode);
  policy.encode.onProgress = progressOf(policy.encode.onProgress, policy.encode.signal);
  if (hooks.carriesJpeg && policy.search.maxQuality === 100 && policy.encode.readAs === undefined && policy.encode.features === undefined && typeof Blob === 'function' && input instanceof Blob) {
    check(policy.encode.signal);
    const head = new Uint8Array(await input.slice(0, 2).arrayBuffer());
    check(policy.encode.signal);
    let picture = null, original;
    if (head[0] === 255 && head[1] === 216) {
      await admitJpeg(input, policy.encode.maxPixels, policy.encode.signal);
      original = new Uint8Array(await input.arrayBuffer());
      check(policy.encode.signal);
      try { picture = jpegDisplayDimensions(original, policy.encode.maxPixels); }
      catch (error) { if (error?.code !== 'JXL_JPEG') throw error; }
    }
    check(policy.encode.signal);
    if (picture) {
      const {signal, onProgress: report} = policy.encode, probes = policy.search.maxProbes;
      let previous = -1;
      const progress = report && (fraction => {
        if (!Number.isFinite(fraction) || fraction <= previous) return;
        previous = fraction;
        try { report(fraction); } catch (error) { throw callers(error); }
      });
      const bytes = await encode(input, {...policy.encode, fidelity: 'exact',
        ...(progress && {onProgress: fraction => progress(fraction / probes)})});
      check(signal);
      const result = preparedResult(bytes, 'exact', picture, jpegReconstruction(bytes));
      policy.encode[PREVIEW]?.(bytes, {width: picture.width, height: picture.height, measurements: []});
      if (bytes.byteLength <= policy.maxBytes) {
        progress?.(1); check(signal);
        return finishPrepared(result, original,
          {fidelity: policy.requestedFidelity, maxBytes: policy.maxBytes, signal});
      }
      policy = {...policy, spentProbes: 1,
        encode: {...policy.encode, ...(progress && {onProgress: progress})}};
    }
  }
  let orientation;
  const taking = acquireSource(input, policy.encode, {...hooks, reference: value => { orientation = value.orientation; }});
  const picture = await taking;
  const {readAs: _spent, ...encodeOptions} = policy.encode;
  const result = intended(await fitPrepared(encode, picture, {...intentPolicy(policy, picture), encode: encodeOptions}, hooks), picture);
  return finishPrepared(result, picture, {
    fidelity: policy.requestedFidelity, readAs: policy.encode.readAs, maxBytes: policy.maxBytes, signal: policy.encode.signal,
    ...(orientation > 1 && {transform: {width: picture.width, height: picture.height}})});
}
