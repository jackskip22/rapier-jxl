// SPDX-License-Identifier: MIT
import {PHOTO_LIMITS} from './bits.mjs';
import {admitOptions, admitPixels, admitSampleFormat, answer} from './admit.mjs';
import {admitEffort} from './effort-level.mjs';
import {photoCoefficientSteps} from './photo-dct.mjs';
import {photoXYBSteps, preferXYB, gaborishPlanes} from './photo-xyb.mjs';
import {V6, GABORISH} from './photo-v6.mjs';
import {spaceTransform} from './icc-transform.mjs';
import {coefficientEffortSteps} from './coefficient-effort.mjs';
import {coefficientAnsSteps} from './coefficient-ans.mjs';
import {encodePhotoSteps} from './photo.mjs';
import {admitPhotoFilter} from './photo-job.mjs';

const BAND_MARGIN = 8;
function photoBand(message) {
  const {width, height, quality, colorSpace, xyb, filter, transform, gray, top = 0} = message, space = typeof colorSpace === 'object' ? colorSpace : undefined;
  const data = xyb ? message.data.subarray(top * width * 4, (top + height) * width * 4) : message.data;
  let steps;
  if (xyb) {
    const color = transform ? {transform, space} : {}, rows = message.data.length / 4 / width, W = Math.ceil(width / 8) * 8, H = Math.ceil(height / 8) * 8;
    const all = gaborishPlanes(message.data, width, rows, {...V6, ...GABORISH, ...color}), pre = all.map(p => p.subarray(top * W, (top + H) * W));
    steps = photoXYBSteps(data, width, height, quality, {...V6, ...GABORISH, ...color, pre});
  } else steps = photoCoefficientSteps(data, width, height, quality, colorSpace, gray);
  let step;
  while (!(step = steps.next()).done) {}
  const result = step.value;
  result.alpha = !!result.alpha;
  return result;
}

export function servePhotoPool(message) {
  const {id, band} = message;
  try {
    const result = photoBand(message), transfer = result.components.map(c => c.coeffs.buffer);
    if (result.cfl) transfer.push(result.cfl.x.buffer, result.cfl.b.buffer);
    return [{pool: 'photo-done', id, band, result}, transfer];
  } catch (error) {
    return [{pool: 'photo-done', id, band, error: {name: error.name, code: error.code, message: error.message}}, []];
  }
}

export function encodePhotoPool(data, width, height, options, {spawn, workers = 3} = {}) {
  const {quality, colorSpace: named} = admitOptions(options, 90), effort = admitEffort(options);
  admitPhotoFilter(options);
  admitPixels(data, width, height, PHOTO_LIMITS);
  const samples = admitSampleFormat(data, options), colorSpace = samples.iccSpace || named;
  if (!(samples.native8 || samples.iccSpace) || quality >= 100 || effort >= 8 || workers < 1 || typeof spawn !== 'function') return encodePhotoSteps(data, width, height, options);
  const signal = options?.signal, space = samples.iccSpace, gray = space?.colorChannels === 1, transform = space && !gray ? spaceTransform(space) : null;
  const xyb = space ? !!transform && preferXYB(data, width, height) : colorSpace === 'srgb' && preferXYB(data, width, height);
  const bandHeight = Math.max(64, Math.floor(262144 / width / 64) * 64), count = Math.ceil(height / bandHeight);
  const stride = Math.ceil(width / 8), rows = Math.ceil(height / 8);
  let members = [], next = 0, finished = 0, ready = [], wake = () => {}, channel, failed = false, jpeg;
  const waiting = new Set(Array.from({length: count}, (_, k) => k));
  const end = () => { for (const worker of members) worker.terminate(); members = []; };
  const fail = () => { failed = true; end(); wake(); };
  const abort = () => { end(); wake(); };
  const request = band => {
    const y = band * bandHeight, h = Math.min(bandHeight, height - y), from = xyb ? Math.max(0, y - BAND_MARGIN) : y, to = xyb ? Math.min(height, y + h + BAND_MARGIN) : y + h;
    return {pool: 'photo', id: 1, band, width, height: h, top: y - from, quality, colorSpace, xyb, filter: options?.filter, transform, gray,
      data: data.subarray(from * width * 4, to * width * 4)};
  };
  const send = worker => {
    if (failed || next >= count) return;
    const message = request(next++);
    try { message.data = new Uint8Array(message.data); worker.postMessage(message, [message.data.buffer]); }
    catch { fail(); }
  };
  const turn = () => new Promise(resolve => {
    if (typeof setImmediate === 'function') { setImmediate(resolve); return; }
    channel ||= new MessageChannel(); channel.port1.onmessage = resolve; channel.port2.postMessage(0);
  });
  const append = ({band, result}) => {
    if (!waiting.delete(band)) return false;
    if (!jpeg) {
      jpeg = {...result, colorSpace, width, height, alpha: null, components: result.components.map(c => ({...c, rows, coeffs: new Int16Array(stride * rows * 64)}))};
      if (result.cfl) {
        const size = result.cfl.width * Math.ceil(height / 64);
        jpeg.cfl = {width: result.cfl.width, x: new Int8Array(size), b: new Int8Array(size)};
      }
    }
    const offset = band * bandHeight / 8 * stride * 64;
    result.components.forEach((c, k) => jpeg.components[k].coeffs.set(c.coeffs, offset));
    if (result.cfl) {
      const offset = band * bandHeight / 64 * result.cfl.width;
      jpeg.cfl.x.set(result.cfl.x, offset); jpeg.cfl.b.set(result.cfl.b, offset);
    }
    if (result.alpha) jpeg.alpha = data;
    finished++;
    return true;
  };
  const it = (async function* () {
    try {
      signal?.throwIfAborted(); signal?.addEventListener('abort', abort, {once: true});
      try {
        for (let k = 0; k < Math.min(3, Math.floor(workers), count - 1); k++) {
          const worker = spawn(); members.push(worker);
          worker.onmessage = ({data: message}) => {
            if (!members.includes(worker) || message.pool !== 'photo-done' || message.id !== 1) return;
            if (message.error) { fail(); return; }
            ready.push(message); send(worker); wake();
          };
          worker.onerror = worker.onmessageerror = event => { event?.preventDefault?.(); if (members.includes(worker)) fail(); };
          send(worker);
          if (failed) break;
        }
      } catch { fail(); }
      while (waiting.size) {
        signal?.throwIfAborted();
        let done = ready.shift();
        if (!done) {
          const band = failed ? waiting.values().next().value : next < count ? next++ : undefined;
          if (band === undefined) { await new Promise(resolve => { wake = resolve; }); continue; }
          done = {band, result: photoBand(request(band))};
          await turn();
        }
        if (append(done)) yield finished / count / 2;
      }
      end();
      const steps = (effort >= 5 ? coefficientAnsSteps : coefficientEffortSteps)(jpeg, effort);
      let step;
      while (!(step = steps.next(it.hurry)).done) {
        signal?.throwIfAborted();
        if (step.value < 1) yield 0.5 + step.value / 2;
      }
      signal?.throwIfAborted();
      it.bytes = answer(step.value);
      yield 1;
      return it.bytes;
    } finally {
      signal?.removeEventListener('abort', abort); end(); channel?.port1.close(); channel?.port2.close();
    }
  })();
  it.bytes = null; it.hurry = false;
  return it;
}
