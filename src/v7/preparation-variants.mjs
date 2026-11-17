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
  return mapPrepared(input, requests.map(({width, height}) => ({...(width !== undefined && {width}), ...(height !== undefined && {height})})), common, async (resized, i, source, resize) => {
    const request = requests[i];
    const progress = onProgress && (fraction => onProgress((i + fraction) / requests.length));
    const unchanged = jpeg && supplied?.preserve !== false && common.readAs === undefined &&
      resized.width === source.width && resized.height === source.height;
    const original = jpeg ? {[JPEG_SOURCE]: {bytes: jpeg.source, info: jpeg.info, ...(!unchanged && {preserve: false})}} : {};
    let result;
    if (request.policy) {
      const {readAs: _spent, ...settings} = request.policy.encode, key = variantRateKey(settings);
      if (!rates.has(key)) rates.set(key, []);
      const search = {...request.policy.search, rates: rates.get(key), area: resized.width * resized.height};
      const policy = {...intentPolicy(request.policy, source), search};
      if (unchanged) {
        let fitted;
        const selected = {}, choosing = {...settings, onProgress: progress,
          [RESULT_REFERENCE]: (_picture, _input, facts) => { if (facts) Object.assign(selected, facts); }};
        const effort = settings.effort ?? (hooks.carriesJpeg ? 3 : 7);
        const bytes = await chooseJpeg(jpeg.source, {effort, quality: search.maxQuality === 100 ? 100 : 90,
          qualityIntent: search.maxQuality / 100}, choosing, {signal, maxPixels, maxBytes: request.policy.maxBytes,
          journal: hooks.journal, probes: search.maxProbes,
          carry: (bytes, effort, carryHooks) => encode(new Blob([bytes], {type: 'image/jpeg'}), {
            fidelity: 'exact', effort, maxPixels, signal, onProgress: carryHooks.onProgress})}, async (chosen, _jpeg, spentProbes = 0) => {
          fitted = await fitPrepared(encode, resized, {...policy, spentProbes, encode: {...chosen, ...original, jpeg: 'pixels'}}, hooks);
          resultFacts(chosen, {fidelity: fitted.fidelity, meetsTarget: fitted.meetsTarget, measurements: fitted.measurements});
          return fitted.bytes;
        });
        result = bytes ? {...preparedResult(bytes, selected.fidelity ?? fitted?.fidelity ?? 'exact', resized,
          selected.kept === 'jpeg-bytes' ? 'jpeg' : undefined), ...fitted, ...selected, bytes} : fitted;
      } else result = await fitPrepared(encode, resized, {...policy, encode: {...settings, ...original, onProgress: progress}}, hooks);
    } else {
      const {readAs: _spent, ...settings} = request.options;
      const key = settings[PREVIEW] === undefined && JSON.stringify([!!jpeg, !!unchanged, settings],
        (name, value) => name === 'signal' || name === 'onProgress' || typeof value === 'function' ? undefined : value);
      const same = key && encoded.get(resized)?.get(key);
      let answer;
      if (same) { answer = structuredClone(same); progress?.(1); }
      else {
        answer = await preparedEncode(encode, resized, {...settings, ...original, onProgress: progress});
        if (key) try { if (!encoded.has(resized)) encoded.set(resized, new Map()); encoded.get(resized).set(key, structuredClone(answer)); } catch {}
      }
      const {bytes} = answer;
      check(signal);
      if (!(bytes instanceof Uint8Array) || !bytes.byteLength) throw fail('JXL_INTERNAL', 'preparation-variants:empty');
      result = {...preparedResult(bytes, settings.fidelity ?? {quality: 90}, resized), ...answer};
    }
    if (result.kept !== 'jpeg-bytes') result = intended(result, source);
    if (jpeg) result.originalBytes = jpeg.originalBytes;
    if (result.bytes && (retained += result.bytes.byteLength) > budget)
      throw fail('JXL_MEMORY', 'outputs: over retained budget');
    return finishPrepared(result, resized, {
      fidelity: request.policy?.requestedFidelity ?? request.options?.fidelity, readAs: common.readAs,
      maxBytes: request.policy?.maxBytes, signal, transform: {width: resized.width, height: resized.height, ...resize}});
  }, hooks);
}
