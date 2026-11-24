// SPDX-License-Identifier: MIT
import {mapPrepared} from './preparation-drive.mjs';
import {fitPrepared, intended, intentPolicy} from './preparation-fit.mjs';
import {variantsOptions} from './preparation-options.mjs';
import {preparedResult, preparedEncode, finishPrepared} from './preparation-result.mjs';
import {DEFAULT_INPUT_BYTES} from './ownership.mjs';
import {check, fail, progressOf} from './primitives.mjs';
import {JPEG_SOURCE, jpegSource, readJpegSource, chooseJpeg} from './jpeg-choice.mjs';
import {RESULT_REFERENCE, resultFacts} from './result-reference.mjs';
import {PREVIEW} from './preview.mjs';

const variantRateKey = settings => JSON.stringify([settings.effort, settings.features]);
const variantOutputBudget = maxPixels => Math.max(DEFAULT_INPUT_BYTES, maxPixels * 16);
const STREAMED_S2_PIXELS = Math.floor((64 * 1024 * 1024) / 36);
const HELPER_ISOLATE_BYTES = 120 * 1048576;
const MEASURED_WHOLE_RESERVATION = 384 * 1048576;
const MEASURED_BAND_THRASH_LIMIT = 256 * 1048576;
const MEASURED_BYTES_PER_PIXEL = 210, MEASURED_HELPER_SHARE = 0.38;

const hostCores = fallback => {
  const nav = globalThis.navigator?.hardwareConcurrency;
  if (nav > 0) return nav;
  try { const n = globalThis.process?.getBuiltinModule?.('node:os')?.availableParallelism?.(); if (n > 0) return n; } catch {}
  return fallback;
};

const helperWorkBytes = (area, effort) => {
  if (effort <= 5) return 24 * area;
  return 200 * 1048576 + (area > STREAMED_S2_PIXELS ? 56 * area : 118 * area);
};

const canSendWhole = settings => {
  const {features} = settings;
  return features === undefined || (Object.keys(features).length === 1 && features.firstRegion !== undefined);
};

const toPublicEncodeOptions = settings => {
  const {readAs: _r, signal: _s, onProgress: _p, onPreview: _v, features, ...rest} = settings;
  return {...rest, ...(features?.firstRegion !== undefined && {firstRegion: features.firstRegion})};
};

export async function variantsWith(encode, input, options, hooks = {}) {
  const supplied = options?.[JPEG_SOURCE];
  if (supplied !== undefined) options = (({[JPEG_SOURCE]: _jpeg, ...rest}) => rest)(options);
  const {requests, common, maxPixels} = variantsOptions(options, hooks.admitEncode), {signal} = common, onProgress = progressOf(common.onProgress, signal);
  let retained = 0;
  const budget = variantOutputBudget(maxPixels);
  const rates = new Map();
  const originalSource = jpegSource(input, supplied);
  const jpeg = originalSource ? await readJpegSource(originalSource, {signal, maxPixels}) : null;
  const encoded = new WeakMap();
  const defaultEffort = hooks.admitEncode ? hooks.admitEncode({}).effort : hooks.carriesJpeg ? 3 : 7;
  const fixedOnly = hooks.journal === undefined && common[PREVIEW] === undefined &&
    common.onPreview === undefined && requests.every(r => !r.policy);
  const measuredAny = fixedOnly && requests.some(r => (r.options?.effort ?? defaultEffort) >= 6);

  const distinctSizes = sizes => {
    if (sizes.length < 2) return false;
    for (let i = 0; i < sizes.length; i++)
      if (sizes.findIndex(s => s.width === sizes[i].width && s.height === sizes[i].height) !== i) return false;
    return true;
  };

  const order = sizes => {
    if (!measuredAny || !distinctSizes(sizes)) return Array.from({length: sizes.length}, (_, i) => i);
    const streamed = [], cached = [];
    for (let i = 0; i < sizes.length; i++) {
      const area = sizes[i].width * sizes[i].height;
      (area > STREAMED_S2_PIXELS ? streamed : cached).push(i);
    }
    if (!streamed.length || !cached.length) return Array.from({length: sizes.length}, (_, i) => i);
    streamed.sort((a, b) => sizes[a].width * sizes[a].height - sizes[b].width * sizes[b].height || a - b);
    cached.sort((a, b) => sizes[b].width * sizes[b].height - sizes[a].width * sizes[a].height || a - b);
    return [...streamed, ...cached];
  };

  const finishSlot = (answer, settings, resized, i, source) => {
    const request = requests[i], {bytes} = answer;
    if (!(bytes instanceof Uint8Array) || !bytes.byteLength) throw fail('JXL_INTERNAL', 'preparation-variants:empty');
    let result = {...preparedResult(bytes, settings.fidelity ?? {quality: 90}, resized), ...answer};
    if (result.kept !== 'jpeg-bytes') result = intended(result, source);
    if (jpeg) result.originalBytes = jpeg.originalBytes;
    if (result.bytes && (retained += result.bytes.byteLength) > budget)
      throw fail('JXL_MEMORY', 'outputs: over retained budget');
    return finishPrepared(result, resized, {
      fidelity: request.options?.fidelity, readAs: common.readAs,
      signal, transform: {width: resized.width, height: resized.height}});
  };

  const variantHelpers = hooks.variantHelpers, localEncode = hooks.localEncode ?? encode;
  const sequentialCoder = measuredAny && variantHelpers && variantHelpers.reservation.memoryBytes < MEASURED_BAND_THRASH_LIMIT && requests.length > 1
    ? localEncode : encode;
  const canWholeSchedule = fixedOnly && variantHelpers?.reservation?.count &&
    (!measuredAny || variantHelpers.reservation.memoryBytes >= MEASURED_WHOLE_RESERVATION);

  const schedule = canWholeSchedule ? async ({sizes, picture, results, makeSize, releaseSlot, dropSourceIfSmaller}) => {
    if (!distinctSizes(sizes)) return false;
    const reservation = variantHelpers.reservation;
    const perHelper = measuredAny ? MEASURED_WHOLE_RESERVATION : HELPER_ISOLATE_BYTES;
    const reserveHeadroom = measuredAny ? 0 : 64 * 1048576;
    const byMem = reservation.memoryBytes >= 160 * 1048576
      ? Math.max(measuredAny ? 0 : 1, Math.floor((reservation.memoryBytes - reserveHeadroom) / perHelper)) : 0;
    const maxHelpers = Math.min(reservation.count, sizes.length - 1, Math.max(1, hostCores(reservation.count + 1) - 1), byMem);
    if (maxHelpers < 1) return false;

    const isUnchanged = i => !!(jpeg && supplied?.preserve !== false && common.readAs === undefined &&
      sizes[i].width === picture.width && sizes[i].height === picture.height);
    const effortOf = i => requests[i].options?.effort ?? defaultEffort;
    const areaOf = i => sizes[i].width * sizes[i].height;

    const slots = Array.from({length: sizes.length}, (_, i) => i).sort((a, b) => areaOf(a) - areaOf(b) || a - b);
    const peakIndex = slots[slots.length - 1];
    const coordOrder = measuredAny ? order(sizes) : [...slots].reverse();
    const pending = new Set(slots);

    const slotFractions = new Float64Array(sizes.length);
    const reportSlot = onProgress && ((i, f) => {
      if (f > slotFractions[i]) {
        slotFractions[i] = Math.min(1, f);
        let sum = 0;
        for (let k = 0; k < slotFractions.length; k++) sum += slotFractions[k];
        onProgress(sum / slotFractions.length);
      }
    });

    const stop = new AbortController();
    const onAbort = () => stop.abort(signal.reason);
    signal?.addEventListener('abort', onAbort, {once: true});
    let firstError = null;
    const failAll = err => { if (!firstError) { firstError = err; stop.abort(err); } };

    let activeHelpers = 0, activeWorkBytes = 0, activeModel = 0, helperDead = false;
    const modelOf = i => measuredAny ? MEASURED_BYTES_PER_PIXEL * areaOf(i) + HELPER_ISOLATE_BYTES : 0;
    const helperBudget = MEASURED_HELPER_SHARE * MEASURED_BYTES_PER_PIXEL * areaOf(peakIndex);
    const underCap = k => !measuredAny || activeModel + modelOf(k) <= helperBudget;
    const pickHelperSlot = () => {
      if (helperDead || stop.signal.aborted || pending.size === 0 || activeHelpers >= maxHelpers) return -1;
      const baseCharge = (activeHelpers + 1) * (44 * 1048576) + activeWorkBytes;
      if (baseCharge >= reservation.memoryBytes) return -1;
      let largestPending = -1;
      if (pending.size > 1) {
        for (const k of slots) if (pending.has(k)) largestPending = k;
      }
      if (measuredAny) {
        for (const k of slots) {
          if (!pending.has(k) || k === largestPending || isUnchanged(k) || !canSendWhole(requests[k].options)) continue;
          if (areaOf(k) > STREAMED_S2_PIXELS && underCap(k) && baseCharge + helperWorkBytes(areaOf(k), effortOf(k)) <= reservation.memoryBytes) return k;
        }
      }
      for (const k of slots) {
        if (!pending.has(k) || k === largestPending || isUnchanged(k) || !canSendWhole(requests[k].options)) continue;
        if (underCap(k) && baseCharge + helperWorkBytes(areaOf(k), effortOf(k)) <= reservation.memoryBytes) return k;
      }
      return -1;
    };

    const claimHelperSlot = () => {
      const i = pickHelperSlot();
      if (i < 0) return -1;
      pending.delete(i);
      activeHelpers++;
      activeWorkBytes += helperWorkBytes(areaOf(i), effortOf(i)); activeModel += modelOf(i);
      return i;
    };

    const pickCoordSlot = () => {
      if (stop.signal.aborted) return -1;
      for (const k of coordOrder) if (pending.has(k)) { pending.delete(k); return k; }
      return -1;
    };

    const runLocalSlot = async (i, resized) => {
      const {readAs: _spent, ...settings} = requests[i].options;
      const unchanged = isUnchanged(i);
      const original = unchanged ? {[JPEG_SOURCE]: {bytes: jpeg.source, info: jpeg.info}} : {};
      const answer = await preparedEncode(localEncode, resized, {
        ...settings, ...original, signal: stop.signal,
        ...(reportSlot && {onProgress: f => reportSlot(i, f)}),
      });
      reportSlot?.(i, 1);
      results[i] = await finishSlot(answer, settings, resized, i, picture);
    };

    const helperWorkers = [];
    const spawnLane = async initialSlot => {
      let i = initialSlot;
      while (i >= 0) {
        const work = helperWorkBytes(areaOf(i), effortOf(i));
        let resized;
        try {
          check(signal);
          resized = await makeSize(i);
          check(signal);
          const {readAs: _spent, ...settings} = requests[i].options;
          const remote = await variantHelpers.encode(
            {...resized, data: new resized.data.constructor(resized.data.buffer, resized.data.byteOffset, resized.data.length)},
            toPublicEncodeOptions({...settings, effort: effortOf(i)}),
            {signal: stop.signal, ...(reportSlot && {onProgress: f => reportSlot(i, f)})},
          );
          if (remote.usedWebGPU) hooks.markDeviceRan?.();
          reportSlot?.(i, 1);
          check(signal);
          results[i] = await finishSlot({
            bytes: remote.bytes, fidelity: remote.fidelity, kept: remote.kept,
            meetsTarget: remote.meetsTarget, measurements: remote.measurements,
          }, settings, resized, i, picture);
          releaseSlot(i);
        } catch (error) {
          if (error?.lost && !signal?.aborted && !firstError) {
            helperDead = true;
            pending.add(i);
            activeHelpers--; activeWorkBytes -= work; activeModel -= modelOf(i);
            break;
          }
          releaseSlot(i);
          activeHelpers--; activeWorkBytes -= work; activeModel -= modelOf(i);
          failAll(error);
          break;
        }
        activeHelpers--; activeWorkBytes -= work; activeModel -= modelOf(i);
        i = claimHelperSlot();
      }
    };

    try {
      for (let h = 0; h < maxHelpers; h++) {
        const claimed = claimHelperSlot();
        if (claimed < 0) break;
        await makeSize(claimed);
        helperWorkers.push(spawnLane(claimed));
      }
      while (!stop.signal.aborted) {
        const i = pickCoordSlot();
        if (i < 0) break;
        try {
          check(signal);
          const resized = await makeSize(i);
          if (i === peakIndex && pending.size > 0) await dropSourceIfSmaller([...pending]);
          check(signal);
          while (!helperDead && activeHelpers < maxHelpers) {
            const claimed = claimHelperSlot();
            if (claimed < 0) break;
            helperWorkers.push(spawnLane(claimed));
          }
          await runLocalSlot(i, resized);
          releaseSlot(i);
        } catch (error) {
          releaseSlot(i);
          failAll(error);
          break;
        }
      }
      await Promise.allSettled(helperWorkers);
      while (!stop.signal.aborted && pending.size > 0) {
        const i = pickCoordSlot();
        if (i < 0) break;
        const resized = await makeSize(i);
        try { await runLocalSlot(i, resized); } finally { releaseSlot(i); }
      }
      check(signal);
      if (firstError) throw firstError;
      return true;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      await Promise.allSettled(helperWorkers);
    }
  } : undefined;

  return mapPrepared(input, requests.map(({width, height, upscale}) => ({...(width !== undefined && {width}), ...(height !== undefined && {height}), ...(upscale !== undefined && {upscale})})), common, async (resized, i, source, step = i, sharedSize = false) => {
    const request = requests[i];
    const progress = onProgress && (fraction => onProgress((step + fraction) / requests.length));
    const unchanged = jpeg && supplied?.preserve !== false && common.readAs === undefined &&
      resized.width === source.width && resized.height === source.height;
    const original = unchanged ? {[JPEG_SOURCE]: {bytes: jpeg.source, info: jpeg.info}} : {};
    if (request.policy) {
      const {readAs: _spent, ...settings} = request.policy.encode, key = variantRateKey(settings);
      if (!rates.has(key)) rates.set(key, []);
      const search = {...request.policy.search, rates: rates.get(key), area: resized.width * resized.height};
      const policy = {...intentPolicy(request.policy, source), search};
      let result;
      if (unchanged) {
        let fitted;
        const selected = {}, choosing = {...settings, onProgress: progress,
          [RESULT_REFERENCE]: (_picture, _input, facts) => { if (facts) Object.assign(selected, facts); }};
        const effort = settings.effort ?? defaultEffort;
        const bytes = await chooseJpeg(jpeg.source, {effort, quality: search.maxQuality === 100 ? 100 : 90,
          qualityIntent: search.maxQuality / 100}, choosing, {signal, maxPixels, maxBytes: request.policy.maxBytes,
          journal: hooks.journal, probes: search.maxProbes,
          carry: (bytes, effort, carryHooks) => encode(new Blob([bytes], {type: 'image/jpeg'}), {
            fidelity: 'exact', effort, maxPixels, signal, onProgress: carryHooks.onProgress,
            [RESULT_REFERENCE]: (_picture, _input, facts) => { if (facts?.otherDecoders) carryHooks.outside?.(facts.otherDecoders.missing); }})}, async (chosen, _jpeg, spentProbes = 0) => {
          fitted = await fitPrepared(encode, resized, {...policy, spentProbes, encode: {...chosen, ...original, jpeg: 'pixels'}}, hooks);
          resultFacts(chosen, {fidelity: fitted.fidelity, meetsTarget: fitted.meetsTarget, measurements: fitted.measurements});
          return fitted.bytes;
        });
        result = bytes ? {...preparedResult(bytes, selected.fidelity ?? fitted?.fidelity ?? 'exact', resized,
          selected.kept === 'jpeg-bytes' ? 'jpeg' : undefined), ...fitted, ...selected, bytes} : fitted;
      } else result = await fitPrepared(encode, resized, {...policy, encode: {...settings, ...original, onProgress: progress}}, hooks);
      if (result.kept !== 'jpeg-bytes') result = intended(result, source);
      if (jpeg) result.originalBytes = jpeg.originalBytes;
      if (result.bytes && (retained += result.bytes.byteLength) > budget)
        throw fail('JXL_MEMORY', 'outputs: over retained budget');
      return finishPrepared(result, resized, {
        fidelity: request.policy.requestedFidelity, readAs: common.readAs,
        maxBytes: request.policy.maxBytes, signal, transform: {width: resized.width, height: resized.height}});
    }
    const {readAs: _spent, ...settings} = request.options;
    const key = sharedSize && settings[PREVIEW] === undefined && JSON.stringify([!!jpeg, !!unchanged, settings],
      (name, value) => name === 'signal' || name === 'onProgress' || typeof value === 'function' ? undefined : value);
    const same = key && encoded.get(resized)?.get(key);
    let answer;
    if (same) { answer = structuredClone(same); progress?.(1); }
    else {
      answer = await preparedEncode(sequentialCoder, resized, {...settings, ...original, onProgress: progress});
      if (key) try { if (!encoded.has(resized)) encoded.set(resized, new Map()); encoded.get(resized).set(key, structuredClone(answer)); } catch {}
    }
    check(signal);
    return finishSlot(answer, settings, resized, i, source);
  }, {...hooks, order, ...(schedule && {schedule})});
}
