// SPDX-License-Identifier: MIT
// Every core: the effort door's exact work over a pool of workers, the same bytes as one thread for any number of them.
// A frame's groups are coded independently once its global choices are made, and every pass of the door over its
// groups (the plan's counting and writing, the weighted search's, the local trees') is a function of the pass's setup
// and the group's pixels alone (frame.mjs, groupPass). So each worker is given its groups' pixels once, by transfer, and
// keeps them for every pass of the picture; a pass sends its setup and then group numbers; this thread, which has every
// pixel, codes groups too while it waits. The counts come back per group and are added in group order, the sections
// are placed in group order, and every choice between passes (predictors, codes, trees, which plan, which stream) stays
// in this thread. Only the time changes.
//
// The workers are the caller's: `spawn()` returns a Worker (postMessage, onmessage, onerror, terminate) whose script
// hands every message to `servePool` and posts back what it answers, with its transfer list. The pool ends its workers
// when the job ends or is left. A worker that cannot start or fails leaves its groups to this thread, which runs the
// same functions on the same pixels: the bytes stand. A picture of one group, or a lossy one, never starts a worker.
import {groupLayout, groupRect} from './frame.mjs';
import {planGroup} from './lossless.mjs';
import {colourTransform} from './rct-search.mjs';
import {localGroup} from './local.mjs';
import {sampledGroup} from './sampled.mjs';
import {searchGroup, effortJob} from './effort-job.mjs';
import {guard, answer} from './admit.mjs';

const WORK = {plan: setup => planGroup(setup, setup.rct === undefined ? undefined : colourTransform(setup.rct, setup.channels)), search: searchGroup, local: localGroup, sampled: sampledGroup};
// A group's result: its counts (fresh, the pass's `sizes`), or its section.
const work = (group, setup, rgba, stride, rect) => { const counts = setup.sizes?.map(n => new Uint32Array(n)); return group(rgba, stride, ...rect, counts) || counts; };

// A worker's side. Its tiles: {rgba, w, h} by group; the pass it is working.
let tiles = [], current = null;
export function servePool(message) {
  if (message.pool === 'tile') { tiles[message.g] = message; return null; }
  if (message.pool === 'pass') { current = {...message, group: WORK[message.kind](message.setup)}; return null; }
  const {g} = message, {rgba, w, h} = tiles[g];
  try {
    const result = work(current.group, current.setup, rgba, w, [0, 0, w, h]);
    return [{pool: 'done', id: current.id, g, result}, (Array.isArray(result) ? result : [result]).map(a => a.buffer)];
  } catch (error) { return [{pool: 'done', id: current.id, g, error: {name: error.name, code: error.code, message: error.message}}, []]; }
}

// The effort door's encodeSteps (the same options, admitted at once) as an async job: `for await (const done of job)`,
// `job.hurry` and `job.bytes` as the steps' job; leaving the loop ends the workers. `workers` is how many to start.
export function encodePool(data, width, height, options, {spawn, workers = 4} = {}) {
  const steps = effortJob(data, width, height, options, true), layout = groupLayout(width, height), groups = layout.groupsX * layout.groupsY;
  let members = null, failed = false, live = 0, serial = 0, ready = [], wake = () => {}, last = 0;
  const end = () => { if (members) for (const worker of members) worker.terminate(); members = []; };
  const fail = () => { failed = true; end(); wake(); };
  // Every message to a worker goes through here: a send that throws (a pixel buffer that cannot be transferred, a
  // worker that is gone) is a failure of the pool like any other, and the groups come back to this thread.
  const send = (worker, message, transfer = []) => {
    if (failed) return false;
    try { worker.postMessage(message, transfer); return true; } catch { fail(); return false; }
  };
  // The workers, and each one's groups' pixels.
  const start = () => {
    members = [];
    try {
      for (let k = 0; k < Math.min(workers, groups); k++) {
        const worker = spawn();
        members.push(worker);
        worker.onmessage = ({data: message}) => { worker.up = true; if (message.id === live) { worker.flight--; ready.push(message); worker.feed(); wake(); } };
        worker.onerror = worker.onmessageerror = event => { event?.preventDefault?.(); if (members.includes(worker)) fail(); };
      }
    } catch { fail(); return; }
    for (let g = 0; g < groups; g++) {
      const [x0, y0, w, h] = groupRect(layout, width, height, g), rgba = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++) rgba.set(data.subarray(((y0 + y) * width + x0) * 4, ((y0 + y) * width + x0 + w) * 4), y * w * 4);
      if (!send(members[g % members.length], {pool: 'tile', g, w, h, rgba}, [rgba.buffer])) return;
    }
  };
  // A turn of the event loop, so that the workers' answers come in between this thread's own groups: a channel's
  // message in a browser, which queues behind them, and setImmediate where there is one (Node drains a port's messages
  // in one go, so a channel there would starve the workers' ports).
  let channel;
  const turn = () => new Promise(resolve => {
    if (typeof setImmediate === 'function') { setImmediate(resolve); return; }
    channel ||= new MessageChannel(); channel.port1.onmessage = resolve; channel.port2.postMessage(0);
  });
  // One pass: every group's result, or null when a hurry ended it, or the error a group's work threw. A worker is sent
  // a group at a time until it first answers (it may still be starting), then kept two ahead. This thread is not idle:
  // it takes the last unsent group of the longest queue, else a group sent to a worker that has not answered yet, and
  // only waits when every group left is with a working worker. A group answered twice counts once: it is the same.
  async function* pass({kind, setup, at, stop}) {
    if (!members) start();
    const id = live = ++serial, waiting = new Set(Array.from({length: groups}, (_, g) => g)), results = [];
    const queues = members.map((_, k) => [...waiting].filter(g => g % members.length === k));
    ready = [];
    for (const [k, worker] of members.entries()) {
      worker.flight = 0;
      worker.feed = () => { while (worker.flight < (worker.up ? 2 : 1) && queues[k].length && send(worker, {pool: 'task', g: queues[k][0]})) { worker.flight++; queues[k].shift(); } };
      if (!send(worker, {pool: 'pass', id, kind, setup})) break;
      worker.feed();
      if (failed) break;
    }
    const steal = () => {
      if (failed) return waiting.values().next().value;
      let k = -1;
      queues.forEach((queue, i) => { if (queue.length && (k < 0 || queue.length > queues[k].length)) k = i; });
      if (k >= 0) return queues[k].pop();
      for (const g of waiting) if (!members[g % members.length].up) return g;
    };
    let local, hurried = false;
    while (waiting.size) {
      let done = ready.shift();
      if (!done) {
        const g = steal();
        if (g === undefined) { await new Promise(resolve => { wake = resolve; }); continue; }
        local ||= WORK[kind](setup);
        try { done = {g, result: work(local, setup, data, width, groupRect(layout, width, height, g))}; } catch (error) { live = 0; return error; }
        await turn();
      }
      if (!waiting.has(done.g)) continue;
      if (done.error) { live = 0; return Object.assign(new (done.error.name === 'RangeError' ? RangeError : Error)(done.error.message), done.error.code ? {code: done.error.code} : {}); }
      waiting.delete(done.g); results[done.g] = done.result;
      const g = groups - waiting.size - 1;
      yield last = at(g);
      hurried = it.hurry;
      if (hurried && stop(g)) { live = 0; return null; }
    }
    live = 0;
    return {results, hurried};
  }
  const it = (async function* () {
    let step, reply;
    try {
      // The workers start, and take their pixels, while this thread inspects the picture.
      if (!layout.single && (options?.quality ?? 100) >= 100) start();
      while (!(step = guard(() => reply instanceof Error ? steps.throw(reply) : steps.next(reply))).done) {
        if (typeof step.value === 'number') { yield last = step.value; reply = it.hurry; }
        else reply = yield* pass(step.value);
      }
    } finally { live = -1; end(); channel?.port1.close(); }
    // A candidate given up (the stream limit, or memory for a search) ends early.
    if (last < 1) yield 1;
    return it.bytes = answer(step.value);
  })();
  it.bytes = null; it.hurry = false;
  return it;
}
