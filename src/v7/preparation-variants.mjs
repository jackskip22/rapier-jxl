// SPDX-License-Identifier: MIT
import {mapPrepared} from './preparation-drive.mjs';
import {fitPrepared} from './preparation-fit.mjs';
import {variantsOptions} from './preparation-options.mjs';
import {preparedResult} from './preparation-result.mjs';
import {DEFAULT_INPUT_BYTES} from './ownership.mjs';
import {check, fail, progressOf} from './primitives.mjs';

export async function variantsWith(encode, input, options, hooks = {}) {
  const {requests, common, maxPixels} = variantsOptions(options, hooks.admitEncode), {signal} = common, onProgress = progressOf(common.onProgress, signal);
  let retained = 0;
  const budget = Math.max(DEFAULT_INPUT_BYTES, maxPixels * 16);
  const rates = new Map();
  return mapPrepared(input, requests.map(({width, height}) => ({...(width !== undefined && {width}), ...(height !== undefined && {height})})), common, async (resized, i) => {
    const request = requests[i];
    const progress = onProgress && (fraction => onProgress((i + fraction) / requests.length));
    let result;
    if (request.policy) {
      const {readAs: _spent, ...settings} = request.policy.encode, key = JSON.stringify([settings.effort, settings.features]);
      if (!rates.has(key)) rates.set(key, []);
      const search = {...request.policy.search, rates: rates.get(key), area: resized.width * resized.height};
      result = await fitPrepared(encode, resized, {...request.policy, search, encode: {...settings, onProgress: progress}}, hooks);
    } else {
      const {readAs: _spent, ...settings} = request.options;
      const bytes = await encode(resized, {...settings, onProgress: progress});
      check(signal);
      if (!(bytes instanceof Uint8Array) || !bytes.byteLength) throw fail('JXL_INTERNAL', 'The encoder must return a nonempty Uint8Array.');
      result = preparedResult(bytes, settings.fidelity ?? {quality: 90}, resized);
    }
    if (result.bytes && (retained += result.bytes.byteLength) > budget)
      throw fail('JXL_MEMORY', 'The prepared outputs exceed the retained byte budget.');
    return result;
  }, hooks);
}
