// SPDX-License-Identifier: MIT
import {mapPrepared} from './preparation-drive.mjs';
import {fitPrepared, intended, intentPolicy} from './preparation-fit.mjs';
import {variantsOptions} from './preparation-options.mjs';
import {preparedResult, preparedEncode, finishPrepared} from './preparation-result.mjs';
import {DEFAULT_INPUT_BYTES} from './ownership.mjs';
import {check, fail, progressOf} from './primitives.mjs';

export const variantRateKey = settings => JSON.stringify([settings.effort, settings.features]);
export const variantOutputBudget = maxPixels => Math.max(DEFAULT_INPUT_BYTES, maxPixels * 16);

export async function variantsWith(encode, input, options, hooks = {}) {
  const {requests, common, maxPixels} = variantsOptions(options, hooks.admitEncode), {signal} = common, onProgress = progressOf(common.onProgress, signal);
  let retained = 0;
  const budget = variantOutputBudget(maxPixels);
  const rates = new Map();
  return mapPrepared(input, requests.map(({width, height}) => ({...(width !== undefined && {width}), ...(height !== undefined && {height})})), common, async (resized, i, source) => {
    const request = requests[i];
    const progress = onProgress && (fraction => onProgress((i + fraction) / requests.length));
    let result;
    if (request.policy) {
      const {readAs: _spent, ...settings} = request.policy.encode, key = variantRateKey(settings);
      if (!rates.has(key)) rates.set(key, []);
      const search = {...request.policy.search, rates: rates.get(key), area: resized.width * resized.height};
      result = await fitPrepared(encode, resized, {...intentPolicy(request.policy, source), search, encode: {...settings, onProgress: progress}}, hooks);
    } else {
      const {readAs: _spent, ...settings} = request.options;
      const answer = await preparedEncode(encode, resized, {...settings, onProgress: progress});
      const {bytes} = answer;
      check(signal);
      if (!(bytes instanceof Uint8Array) || !bytes.byteLength) throw fail('JXL_INTERNAL', 'The encoder must return a nonempty Uint8Array.');
      result = {...preparedResult(bytes, settings.fidelity ?? {quality: 90}, resized), ...answer};
    }
    result = intended(result, source);
    if (result.bytes && (retained += result.bytes.byteLength) > budget)
      throw fail('JXL_MEMORY', 'The prepared outputs exceed the retained byte budget.');
    return finishPrepared(result, resized, {
      fidelity: request.policy?.requestedFidelity ?? request.options?.fidelity, readAs: common.readAs,
      maxBytes: request.policy?.maxBytes, signal, transform: {width: resized.width, height: resized.height}});
  }, hooks);
}
