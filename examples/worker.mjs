// SPDX-License-Identifier: MIT
// Requests: {id, op: 'encode' | 'photo', data, width, height, ...options} or {id, op: 'transcode', jpeg, effort}.
// Responses: {id, progress}, then {id, ok: true, bytes, width, height, orientation} or {id, ok: false, code, message}.
// {id, op: 'abort'} cancels between steps. The encode entry point defaults to effort 1. A deadline in milliseconds
// ends search with the smallest completed stream, at most effort 1's size. Output buffers transfer to the caller.
import {encodeSteps} from '../src/effort.mjs';
import {transcodeSteps} from '../src/jpeg.mjs';
import {encodePhotoSteps} from '../src/photo.mjs';

const running = new Set();
const turn = () => new Promise(resolve => setTimeout(resolve));

self.onmessage = async event => {
  const ask = event.data || {}, {id, op} = ask;
  if (op === 'abort') { running.delete(id); return; }
  try {
    const job = op === 'encode' ? encodeSteps(ask.data, ask.width, ask.height, ask)
      : op === 'photo' ? encodePhotoSteps(ask.data, ask.width, ask.height, ask)
      : op === 'transcode' ? transcodeSteps(ask.jpeg, {effort: ask.effort})
      : null;
    if (!job) throw Object.assign(new Error('Operation is encode, photo or transcode.'), {code: 'JXL_INPUT'});
    running.add(id);
    let shown = performance.now();
    const hurryAt = ask.deadline >= 0 ? shown + ask.deadline : Infinity;
    for (const done of job) {
      if (performance.now() >= hurryAt) job.hurry = true;
      // Yield every 50 ms to receive cancellation messages and report progress.
      if (performance.now() - shown < 50) continue;
      self.postMessage({id, progress: done});
      await turn();
      if (!running.has(id)) return;
      shown = performance.now();
    }
    running.delete(id);
    const out = {bytes: job.bytes, width: job.width ?? ask.width, height: job.height ?? ask.height, orientation: job.orientation ?? 1};
    self.postMessage({id, ok: true, ...out}, [out.bytes.buffer]);
  } catch (error) {
    running.delete(id);
    const failure = {id, ok: false, message: String(error.message || error)};
    if (error.code) failure.code = error.code;
    self.postMessage(failure);
  }
};
