// SPDX-License-Identifier: MIT
import {acquireSource, sizedPictures} from './preparation-source.mjs';
import {sampleResizeConfig, sampleResizeStep, expandRGB} from '../sample-transforms.mjs';
import {sampleBands} from '../kernels.mjs';
import {turn} from '../turn.mjs';
import {own, withCost, DEFAULT_INPUT_BYTES} from './ownership.mjs';
import {check, fail, object, pixelLimit, dimensions} from './primitives.mjs';
import {outputSides, outputSize} from './preparation-sides.mjs';

const yields = typeof WorkerGlobalScope !== 'function' &&
  (() => { try { return globalThis.process?.getBuiltinModule?.('node:worker_threads')?.isMainThread !== false; } catch { return true; } })();

async function resizePrepared(picture, width, height, prepared, {signal, maxPixels}) {
  dimensions(width, height, maxPixels); check(signal);
  if (width === picture.width && height === picture.height) return picture;
  const {config, table, levels} = prepared, {data} = picture;
  const out = new data.constructor(width * height * 4);
  const bands = sampleBands(picture.width, picture.height, width, height, config, table, levels, data.BYTES_PER_ELEMENT);
  let last = -Infinity;
  for (let state = {y: 0, row: null, sum: null}; state.y < height;) {
    check(signal);
    ({state} = sampleResizeStep(bands, data, picture.height, height, state, out));
    if (yields && performance.now() - last > 8) { await turn(); check(signal); last = performance.now(); }
  }
  check(signal);
  return {...picture, data: out, width, height};
}

export async function mapPrepared(input, outputs, options, consume, hooks = {}) {
  const settings = object(options), maxPixels = pixelLimit(settings.maxPixels), {signal, readAs} = settings;
  if (typeof consume !== 'function') throw fail('JXL_OPTIONS', 'consume: function');
  if (!Array.isArray(outputs) || !outputs.length) throw fail('JXL_OPTIONS', 'outputs: nonempty array');
  const requests = own(outputs, maxPixels, Math.max(DEFAULT_INPUT_BYTES, maxPixels * 16));
  if (requests.length !== outputs.length) throw fail('JXL_OPTIONS', 'output: width or height');
  for (const value of requests) {
    const request = object(value, 'output');
    for (const key of Object.keys(request)) if (key !== 'width' && key !== 'height' && key !== 'upscale')
      throw fail('JXL_OPTIONS', 'output: {width, height, upscale} only');
    if (request.upscale !== undefined && typeof request.upscale !== 'boolean') throw fail('JXL_OPTIONS', 'upscale: boolean');
    outputSides(request.width, request.height, maxPixels);
  }
  check(signal);
  const picture = await acquireSource(input, {signal, readAs, maxPixels}, hooks.resize ? hooks
    : {...hooks, sizes: whole => requests.map(request => outputSize(request, whole, maxPixels))});
  const sizes = requests.map(request => outputSize(request, picture, maxPixels)), made = sizedPictures(picture);
  const firsts = sizes.map(({width, height}) => sizes.findIndex(s => s.width === width && s.height === height));
  const uses = new Int32Array(requests.length);
  let keepsSource = false, uniqueResizes = 0;
  for (let i = 0; i < sizes.length; i++) {
    uses[firsts[i]]++;
    if (firsts[i] === i) {
      if (sizes[i].width === picture.width && sizes[i].height === picture.height) keepsSource = true;
      else uniqueResizes++;
    }
  }
  const preparedCfg = !made && !hooks.resize && uniqueResizes > 0 ? await sampleResizeConfig(picture, {signal}) : null;
  const canDropSource = !made && !keepsSource && !hooks.journal && !hooks.orient && !hooks.resize;
  const sourceBytes = picture.data?.byteLength ?? 0, pixelBytes = (picture.data?.BYTES_PER_ELEMENT ?? 1) * 4;
  const shared = new Map(), results = new Array(requests.length);
  let resizeTurn = Promise.resolve();
  const makeSize = first => {
    if (shared.has(first)) return Promise.resolve(shared.get(first));
    const next = resizeTurn.then(async () => {
      if (shared.has(first)) return shared.get(first);
      const {width, height} = sizes[first];
      const held = made?.[first], sized = held && (({rgb, ...rest}) => ({...rest, data: expandRGB(rgb)}))(held);
      if (made) made[first] = null;
      const size = sized ?? (hooks.resize ? await hooks.resize(picture, width, height, {signal, maxPixels})
        : width === picture.width && height === picture.height ? picture
        : await resizePrepared(picture, width, height, preparedCfg, {signal, maxPixels}));
      if (size !== picture && !hooks.resize && uses[first] === 1) withCost(size.data, size.data.byteLength);
      shared.set(first, size);
      if (size !== picture && --uniqueResizes === 0 && canDropSource) picture.data = null;
      return size;
    });
    resizeTurn = next.then(() => {}, () => {});
    return next;
  };
  const releaseSlot = i => {
    const first = firsts[i];
    if (--uses[first] === 0) {
      shared.delete(first);
    }
  };
  const dropSourceIfSmaller = async indices => {
    if (!canDropSource || picture.data === null) return;
    let restBytes = 0;
    for (const k of indices) {
      const f = firsts[k];
      if (!shared.has(f)) restBytes += sizes[f].width * sizes[f].height * pixelBytes;
    }
    if (restBytes < sourceBytes) {
      for (const k of indices) await makeSize(firsts[k]);
    }
  };
  if (hooks.schedule && !hooks.resize) {
    const ran = await hooks.schedule({sizes, firsts, uses, picture, results, makeSize, releaseSlot, dropSourceIfSmaller});
    if (ran) return results;
  }
  const order = hooks.order ? hooks.order(sizes) : Array.from({length: requests.length}, (_, i) => i);
  let peakStep = 0;
  for (let s = 1; s < order.length; s++)
    if (sizes[order[s]].width * sizes[order[s]].height > sizes[order[peakStep]].width * sizes[order[peakStep]].height) peakStep = s;
  for (let step = 0; step < order.length; step++) {
    const i = order[step];
    check(signal);
    const first = firsts[i], resized = await makeSize(first);
    if (step === peakStep && step > 0) await dropSourceIfSmaller(order.slice(step + 1));
    check(signal);
    const result = await consume(resized, i, picture, step, uses[first] > 1);
    releaseSlot(i);
    check(signal);
    results[i] = result;
  }
  return results;
}
