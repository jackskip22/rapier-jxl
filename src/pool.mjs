// SPDX-License-Identifier: MIT
// Parallel group coding with byte-identical output. Tasks depend only on fixed pass setup and group pixels.
// Workers retain transferred pixels until the frame or group dimensions change. The coordinator selects models,
// combines counts and sections in group order, and codes groups while waiting for worker results.
//
// spawn() returns a Worker that forwards servePool(message, report) reports and transferable replies.
// Job completion and cancellation terminate all workers. Failed workers fall back to the same local group functions.
// Effort 9 also runs independent learned candidates, including images with one format group.
import {groupLayout, groupRect, GROUP_DIM} from './frame.mjs';
import {planGroup} from './lossless.mjs';
import {colourTransform} from './rct-search.mjs';
import {localGroup} from './local.mjs';
import {sampledGroup, sampledSteps} from './sampled.mjs';
import {screenGroup} from './screen.mjs';
import {paletteGroup} from './palette-search.mjs';
import {searchGroup, effortJob} from './effort-job.mjs';
import {guard, answer} from './admit.mjs';

const WORK = {plan: setup => planGroup(setup, setup.rct === undefined ? undefined : colourTransform(setup.rct, setup.channels)), search: searchGroup, local: localGroup, sampled: sampledGroup, screen: screenGroup, palette: paletteGroup};
// Counting returns fresh histograms of setup.sizes; writing returns a section.
const work = (group, setup, rgba, stride, rect) => { const counts = setup.sizes?.map(n => new Uint32Array(n)); return group(rgba, stride, ...rect, counts) || counts; };

// Worker-local tiles and active pass. Reset releases both before a frame or layout change.
let tiles = [], current = null;
export function servePool(message, report = () => {}) {
  if (message.pool === 'candidate') {
    const {id, k, data, width, height, shape, colorSpace, options, ceiling} = message;
    try {
      report({pool: 'candidate-progress', id, k, progress: 0});
      const steps = sampledSteps(data, width, height, shape, colorSpace, options, false, ceiling);
      let step;
      while (!(step = steps.next()).done) if (step.value < 1) report({pool: 'candidate-progress', id, k, progress: step.value});
      const result = step.value;
      return [{pool: 'candidate-done', id, k, result}, result ? [result.buffer] : []];
    } catch (error) { return [{pool: 'candidate-done', id, k, error: {name: error.name, code: error.code, message: error.message}}, []]; }
  }
  if (message.pool === 'reset') { tiles = []; current = null; return null; }
  if (message.pool === 'tile') { tiles[message.g] = message; return null; }
  if (message.pool === 'pass') { current = {...message, group: WORK[message.kind](message.setup)}; return null; }
  const {g} = message, {rgba, w, h} = tiles[g];
  try {
    const result = work(current.group, current.setup, rgba, w, [0, 0, w, h]);
    return [{pool: 'done', id: current.id, g, result}, (Array.isArray(result) ? result : [result]).map(a => a.buffer)];
  } catch (error) { return [{pool: 'done', id: current.id, g, error: {name: error.name, code: error.code, message: error.message}}, []]; }
}

// Async equivalent of encodeSteps: the same options, progress, hurry flag, and output bytes.
// Leaving the async iterator terminates its workers.
export function encodePool(data, width, height, options, {spawn, workers = 3, groupWorkers = true} = {}) {
  workers = Math.max(0, Math.min(3, Math.floor(workers) || 0));
  let hurryBytes;
  const steps = effortJob(data, width, height, options, groupWorkers && workers > 0, workers > 0, bytes => { hurryBytes = bytes; }), layout = groupLayout(width, height), groups = layout.groupsX * layout.groupsY;
  let members = null, failed = false, live = 0, serial = 0, ready = [], wake = () => {}, last = 0;
  let tiledData, tiledWidth, tiledHeight, tiledDim;
  const end = () => { if (members) for (const worker of members) worker.terminate(); members = []; tiledData = null; };
  const fail = () => { failed = true; end(); wake(); };
  // Transfer and dispatch failures use the same local fallback as worker failures.
  const send = (worker, message, transfer = []) => {
    if (failed) return false;
    try { worker.postMessage(message, transfer); return true; } catch { fail(); return false; }
  };
  // Start only the workers the next pass can use. The same members serve groups and complete candidates.
  const start = (count = Math.min(workers, groups)) => {
    members = [];
    try {
      for (let k = 0; k < count; k++) {
        const worker = spawn();
        members.push(worker);
        worker.onmessage = ({data: message}) => {
          if (!members.includes(worker) || message.id !== live) return;
          worker.up = true;
          if (message.pool === 'done') { worker.flight--; worker.feed(); }
          ready.push(message); wake();
        };
        worker.onerror = worker.onmessageerror = event => { event?.preventDefault?.(); if (members.includes(worker)) fail(); };
      }
    } catch { fail(); return; }
  };
  // A format-group change or a patch frame changes the owned pixels. Reset before replacing tiles so workers do
  // not retain old atlas/body buffers or accidentally read a previous frame's tile at the same group number.
  const retile = (source, imageWidth, imageHeight, dim) => {
    if (failed || source === tiledData && imageWidth === tiledWidth && imageHeight === tiledHeight && dim === tiledDim) return;
    try {
      for (const worker of members) if (!send(worker, {pool: 'reset'})) return;
      const frame = groupLayout(imageWidth, imageHeight, dim), count = frame.groupsX * frame.groupsY;
      for (let g = 0; g < count; g++) {
        const [x0, y0, w, h] = groupRect(frame, imageWidth, imageHeight, g, dim);
        const Sample = source instanceof Float32Array ? Float32Array : source instanceof Uint16Array ? Uint16Array : Uint8Array;
        const rgba = new Sample(w * h * 4);
        for (let y = 0; y < h; y++) rgba.set(source.subarray(((y0 + y) * imageWidth + x0) * 4, ((y0 + y) * imageWidth + x0 + w) * 4), y * w * 4);
        if (!send(members[g % members.length], {pool: 'tile', g, w, h, rgba}, [rgba.buffer])) return;
      }
      tiledData = source; tiledWidth = imageWidth; tiledHeight = imageHeight; tiledDim = dim;
    } catch { fail(); }
  };
  // Yield between local groups so worker responses can arrive. Node drains each port's queue in one pass;
  // setImmediate avoids starving worker ports with a repeatedly posted MessageChannel callback.
  let channel;
  const turn = () => new Promise(resolve => {
    if (typeof setImmediate === 'function') { setImmediate(resolve); return; }
    channel ||= new MessageChannel(); channel.port1.onmessage = resolve; channel.port2.postMessage(0);
  });
  // Fixed candidate shares count completed work, never elapsed time. Results retain transform rank order.
  async function* candidates({shape, colorSpace, rungs, ceiling, at}) {
    if (!members) start(Math.min(workers, rungs.length));
    const id = live = ++serial, waiting = new Set(rungs.map((_, k) => k)), results = [], fractions = rungs.map(() => 0), local = [];
    ready = [];
    // Candidate workers own one source copy each. Drop obsolete group tiles before allocating it.
    for (const worker of members) if (!send(worker, {pool: 'reset'})) break;
    tiledData = null;
    const count = Math.min(members.length, rungs.length);
    for (let k = 0; k < rungs.length; k++) {
      // With one helper, keep the first-ranked model on the already-warm coordinator.
      const worker = count < rungs.length ? k > 0 && members[k - 1] : members[k];
      if (!worker || failed) { local.push(k); continue; }
      try {
        const pixels = new Uint8Array(data);
        send(worker, {pool: 'candidate', id, k, data: pixels, width, height, shape, colorSpace, options: rungs[k], ceiling}, [pixels.buffer]);
      } catch { fail(); }
    }
    // Let a nested helper start before local model learning blocks its creator's thread.
    if (local.length && count && !failed && !ready.length) await new Promise(resolve => { wake = resolve; });
    const progress = (k, value) => {
      fractions[k] = Math.max(fractions[k], value);
      return at(fractions.reduce((sum, done) => sum + done, 0) / rungs.length);
    };
    while (waiting.size) {
      let done = ready.shift();
      if (!done) {
        let k = local.shift();
        while (k !== undefined && !waiting.has(k)) k = local.shift();
        if (k === undefined && failed) k = waiting.values().next().value;
        if (k === undefined) { await new Promise(resolve => { wake = resolve; }); continue; }
        try {
          const search = sampledSteps(data, width, height, shape, colorSpace, rungs[k], false, ceiling);
          let step;
          while (!(step = search.next(it.hurry)).done) {
            if (step.value < 1) {
              const value = progress(k, step.value);
              if (value > last && value < 1) yield last = value;
            }
            await turn();
          }
          done = {k, result: step.value};
        } catch (error) { done = {k, error: {name: error.name, code: error.code, message: error.message}}; }
      }
      if (!waiting.has(done.k)) continue;
      const complete = done.pool !== 'candidate-progress';
      if (complete) { results[done.k] = done; waiting.delete(done.k); }
      const value = progress(done.k, complete ? 1 : done.progress);
      if (value > last && value < 1) yield last = value;
      if (it.hurry) { live = 0; return {results, hurried: true}; }
    }
    live = 0;
    return {results, hurried: false};
  }
  // Send one task until a worker first responds, then keep two in flight. The coordinator steals from the longest
  // unsent queue or a worker that has not responded. Duplicate results are identical and count only once.
  async function* pass({kind, setup, at, stop, byteCeiling, dim = GROUP_DIM, data: source = data, width: imageWidth = width, height: imageHeight = height}) {
    if (!members) start();
    retile(source, imageWidth, imageHeight, dim);
    const frame = groupLayout(imageWidth, imageHeight, dim), groups = frame.groupsX * frame.groupsY;
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
    let local, hurried = false, sectionBytes = 0;
    while (waiting.size) {
      let done = ready.shift();
      if (!done) {
        const g = steal();
        if (g === undefined) { await new Promise(resolve => { wake = resolve; }); continue; }
        try { local ||= WORK[kind](setup); done = {g, result: work(local, setup, source, imageWidth, groupRect(frame, imageWidth, imageHeight, g, dim))}; } catch (error) { live = 0; return error; }
        await turn();
      }
      if (!waiting.has(done.g)) continue;
      if (done.error) { live = 0; return Object.assign(new (done.error.name === 'RangeError' ? RangeError : Error)(done.error.message), done.error.code ? {code: done.error.code} : {}); }
      waiting.delete(done.g); results[done.g] = done.result;
      if (byteCeiling !== undefined) sectionBytes += done.result.length;
      const g = groups - waiting.size - 1;
      const value = at(g);
      if (value > last && value < 1) yield last = value;
      hurried = it.hurry;
      // A pruned candidate is not a hurried job. Later candidates still compete against the retained stream.
      if (byteCeiling !== undefined && sectionBytes >= byteCeiling) { live = 0; return {pruned: true, hurried}; }
      if (hurried && stop(g)) { live = 0; return null; }
    }
    live = 0;
    return {results, hurried};
  }
  const it = (async function* () {
    let step, reply;
    try {
      // Start workers while the coordinator inspects the image.
      if (groupWorkers && workers > 0 && !layout.single && (options?.quality ?? 100) >= 100) start();
      while (!(step = guard(() => reply instanceof Error ? steps.throw(reply) : steps.next(reply))).done) {
        if (typeof step.value === 'number') {
          if (step.value > last && step.value < 1) yield last = step.value;
          reply = it.hurry;
        } else reply = yield* (step.value.kind === 'candidates' ? candidates(step.value) : pass(step.value));
      }
    } finally { live = -1; end(); channel?.port1.close(); }
    // A candidate given up (the stream limit, or memory for a search) ends early.
    const bytes = answer(step.value), hurried = hurryBytes && answer(hurryBytes);
    yield 1;
    return it.bytes = it.hurry && hurried ? hurried : bytes;
  })();
  it.bytes = null; it.hurry = false;
  return it;
}
