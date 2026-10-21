// SPDX-License-Identifier: MIT
import {complete} from './bits.mjs';
import {guard} from './admit.mjs';
import {admitAnimation, animationSteps, partSteps, pixelsOf, ANIMATION_LIMITS} from './animation-frames.mjs';

let animationSerial = 0;

export function serveAnimationPool({id, k, coder, crop, w, h}) {
  try {
    const bytes = complete(partSteps(coder, crop, w, h));
    return [{pool: 'animation-done', id, k, bytes}, [bytes.buffer]];
  } catch (error) { return [{pool: 'animation-done', id, k, error: {name: error.name, code: error.code, message: error.message}}, []]; }
}

export function encodeAnimationPool(animation, options, {spawn, workers = 3} = {}) {
  const admitted = admitAnimation(animation, options), signal = admitted.signal;
  let members = [];
  const it = (async function* () {
    const steps = animationSteps(admitted, true);
    let step, reply, last = 0;
    try {
      while (!(step = guard(() => steps.next(reply))).done) {
        signal?.throwIfAborted();
        if (typeof step.value === 'number') { if (step.value > last && step.value < 1) yield last = step.value; reply = it.hurry; continue; }
        const run = rectangles(step.value);
        for (let next; !(next = await run.next()).done;) if (next.value > last && next.value < 1) yield last = next.value;
        reply = run.result;
      }
    } finally { for (const worker of members) worker.terminate(); members = []; }
    if (step.value.length > ANIMATION_LIMITS.bytes) throw Object.assign(new Error('The encoded animation exceeds 256 MiB.'), {code: 'JXL_SIZE'});
    return it.bytes = step.value;
  })();
  it.bytes = null; it.hurry = false;

  function rectangles({width, coder, parts, at}) {
    const results = new Array(parts.length);
    const queue = parts.map((_, k) => k), id = ++animationSerial;
    let done = 0, ready = [], wake = () => {}, failed = false;
    const finish = (k, bytes) => { if (results[k]) return; results[k] = bytes; done += parts[k].span[1] - parts[k].span[0]; };
    const helpers = Math.min(workers, parts.length - 1);
    const dispatch = worker => {
      while (worker.flight < 2 && queue.length && !failed) {
        const k = queue.shift(), [, , w, h] = parts[k].rect, crop = pixelsOf(parts[k], width);
        try { worker.postMessage({pool: 'animation', id, k, coder, crop, w, h}, [crop.buffer]); worker.flight++; worker.owned.add(k); }
        catch { queue.unshift(k); return; }
      }
    };
    const lose = worker => {
      if (!members.includes(worker)) return;
      members = members.filter(other => other !== worker); worker.terminate();
      for (const k of worker.owned) if (!results[k]) queue.push(k);
      wake();
    };
    if (!members.length) try {
      for (let n = 0; n < helpers; n++) {
        const worker = spawn();
        worker.flight = 0; worker.owned = new Set();
        worker.onmessage = ({data: message}) => {
          if (message?.pool !== 'animation-done' || message.id !== id) return;
          worker.flight--; worker.owned.delete(message.k);
          if (message.error) { queue.push(message.k); lose(worker); return; }
          ready.push(message); dispatch(worker); wake();
        };
        worker.onerror = worker.onmessageerror = event => { event?.preventDefault?.(); lose(worker); };
        members.push(worker);
      }
    } catch { failed = true; }
    else for (const worker of members) { worker.flight = 0; worker.owned = new Set(); }
    for (const worker of members) dispatch(worker);
    let channel;
    const turn = () => new Promise(resolve => {
      if (typeof setImmediate === 'function') { setImmediate(resolve); return; }
      channel ||= new MessageChannel(); channel.port1.onmessage = resolve; channel.port2.postMessage(0);
    });
    const run = (async function* () {
      try {
        while (results.filter(Boolean).length < parts.length) {
          signal?.throwIfAborted();
          const message = ready.shift();
          if (message) { finish(message.k, message.bytes); yield at(done); continue; }
          for (const worker of members) dispatch(worker);
          const k = !members.length || queue.length > 2 * members.length ? queue.pop() : undefined;
          if (k === undefined) { if (!members.length && !queue.length) break; await new Promise(resolve => { wake = resolve; }); continue; }
          const [, , w, h] = parts[k].rect;
          finish(k, complete(partSteps(coder, pixelsOf(parts[k], width), w, h)));
          yield at(done);
          await turn();
        }
      } finally { channel?.port1.close(); channel?.port2.close(); }
      run.result = results;
    })();
    return run;
  }
  return it;
}
