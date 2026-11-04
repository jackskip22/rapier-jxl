// SPDX-License-Identifier: MIT
import {fitSearch} from '../target-search.mjs';
import {fitOptions} from './preparation-options.mjs';
import {check, fail, callers, isCaller, progressOf} from './primitives.mjs';
import {acquireSource} from './preparation-source.mjs';
import {preparedResult} from './preparation-result.mjs';
import {jpegDisplayDimensions, jpegReconstruction} from './preparation-jpeg.mjs';
import {admitJpeg} from './input.mjs';

export async function fitPrepared(encode, picture, policy, capabilities = {}) {
  const {maxBytes, search, encode: options} = policy, {signal, onProgress: report, ...rest} = options;
  const named = options.features && Object.keys(options.features);
  const probed = policy.probed ?? (named && !(named.length === 1 && named[0] === 'firstRegion') &&
    search.maxQuality === 100 && search.minQuality < 100 ? {quality: 100, bytes: null} : null);
  let previous = -1;
  const onProgress = report && (fraction => {
    if (!Number.isFinite(fraction) || fraction <= previous) return;
    previous = fraction;
    try { report(fraction); } catch (error) { throw callers(error); }
  });
  const candidates = fitSearch(maxBytes, {...search, picture, effort: rest.effort});
  let next = candidates.next(), count = 0, reuse, encoded = false;
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
          bytes = await reuse?.probe(next.value, hooks) ?? null;
        }
        if (!bytes && !known) { bytes = await encode(picture, {...rest, fidelity: {quality: next.value}, ...hooks}); encoded = true; }
      } catch (error) {
        check(signal);
        if (isCaller(error)) throw error;
        if (error?.code !== 'JXL_SIZE' && !(error?.code === 'JXL_LIMIT' && error.cause?.code === 'JXL_SIZE')) throw error;
      }
      check(signal);
      if (bytes !== null && (!(bytes instanceof Uint8Array) || !bytes.byteLength))
        throw fail('JXL_INTERNAL', 'The encoder must return a nonempty Uint8Array.');
      count++;
      next = candidates.next({bytes});
    }
    onProgress?.(1); check(signal);
    const {bytes, quality} = next.value, {width, height} = picture;
    return bytes ? preparedResult(bytes, quality === 100 ? 'exact' : {quality}, picture)
      : {fits: false, width, height};
  } finally { candidates.return(); reuse?.dispose(); }
}

export async function fitWith(encode, input, options, hooks = {}) {
  let policy = fitOptions(options, hooks.admitEncode);
  policy.encode.onProgress = progressOf(policy.encode.onProgress, policy.encode.signal);
  if (policy.search.maxQuality === 100 && policy.encode.readAs === undefined && policy.encode.features === undefined && typeof Blob === 'function' && input instanceof Blob) {
    check(policy.encode.signal);
    const head = new Uint8Array(await input.slice(0, 2).arrayBuffer());
    check(policy.encode.signal);
    let picture = null;
    if (head[0] === 255 && head[1] === 216) {
      await admitJpeg(input, policy.encode.maxPixels, policy.encode.signal);
      const original = new Uint8Array(await input.arrayBuffer());
      check(policy.encode.signal);
      try { picture = jpegDisplayDimensions(original, policy.encode.maxPixels); }
      catch (error) { if (error?.code !== 'JXL_JPEG') throw error; }
    }
    check(policy.encode.signal);
    if (picture) {
      const {signal, onProgress: report} = policy.encode, probes = policy.search.maxProbes;
      const exactOnly = policy.search.minQuality === 100;
      let previous = -1;
      const progress = report && (fraction => {
        if (!Number.isFinite(fraction) || fraction <= previous) return;
        previous = fraction;
        try { report(fraction); } catch (error) { throw callers(error); }
      });
      const bytes = await encode(input, {...policy.encode, fidelity: 'exact',
        ...(progress && {onProgress: fraction => progress(exactOnly ? fraction : fraction / probes)})});
      check(signal);
      const result = preparedResult(bytes, 'exact', picture, jpegReconstruction(bytes));
      if (bytes.byteLength <= policy.maxBytes || exactOnly) {
        progress?.(1); check(signal);
        return bytes.byteLength <= policy.maxBytes ? result : {fits: false, width: result.width, height: result.height};
      }
      policy = {...policy, probed: {quality: 100, bytes},
        encode: {...policy.encode, ...(progress && {onProgress: progress})}};
    }
  }
  const taking = acquireSource(input, policy.encode, hooks);
  const picture = await taking;
  const {readAs: _spent, ...encodeOptions} = policy.encode;
  return fitPrepared(encode, picture, {...policy, encode: encodeOptions}, hooks);
}
