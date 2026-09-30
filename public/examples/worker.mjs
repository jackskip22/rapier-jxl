// SPDX-License-Identifier: MIT
// A complete worker around Rapier JXL: post {id, op: 'encode' or 'photo', data, width, height, quality} or
// {id, op: 'transcode', jpeg}; receive {id, progress} while it works, then {id, ok: true, bytes, width, height,
// orientation} or {id, ok: false, code, message}. {id, op: 'abort'} ends a request between steps. 'encode' takes an
// effort (the effort door; 1, its default, writes the core's bytes) and a deadline in milliseconds: past it the search
// is hurried and answers with the smallest stream written so far, never larger than effort 1's. Bytes are transferred.
import {encodeSteps} from '../../effort.mjs';
import {transcodeSteps} from '../../jpeg.mjs';
import {encodePhotoSteps} from '../../photo.mjs';

const running = new Set();
const turn = () => new Promise(resolve => setTimeout(resolve));

self.onmessage = async event => {
  const ask = event.data || {}, {id, op} = ask;
  if (op === 'abort') { running.delete(id); return; }
  try {
    const job = op === 'encode' ? encodeSteps(ask.data, ask.width, ask.height, {quality: ask.quality, effort: ask.effort})
      : op === 'photo' ? encodePhotoSteps(ask.data, ask.width, ask.height, {quality: ask.quality})
      : op === 'transcode' ? transcodeSteps(ask.jpeg)
      : null;
    if (!job) throw Object.assign(new Error('unknown op ' + op), {code: 'JXL_INPUT'});
    running.add(id);
    let shown = performance.now();
    const hurryAt = ask.deadline >= 0 ? shown + ask.deadline : Infinity;
    for (const done of job) {
      if (performance.now() >= hurryAt) job.hurry = true;
      // Every 50 ms the worker takes its messages (an abort among them) and reports progress; leaving is the cancel.
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
    self.postMessage({id, ok: false, code: error.code || 'JXL_ERROR', message: String(error.message || error)});
  }
};
