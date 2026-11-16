// Relays Swift's calls to the worker and the worker's answers to Swift. An animation (a GIF, or a video's frames) is made
// here with rapier-jxl/animation, which encodes in its own worker. Swift reads a video's frames with AVFoundation and sends
// them in parts (frames). Bytes never pass through Swift's messages: each call reads its input from /in/<id> (a part from
// /in/<id>.<part>) and writes its output to /out/<id>/<kind>.
const tell = message => webkit.messageHandlers.rapier.postMessage(JSON.stringify(message));
const worker = new Worker(new URL('./encoder.mjs', location.href), {type: 'module'});
const fail = message => tell({type: 'error', id: null, code: 'JXL_WORKER', message});
worker.onmessage = ({data}) => tell(data);
worker.onerror = event => { event.preventDefault(); fail(event.message || 'The encoder worker stopped.'); worker.terminate(); };
worker.onmessageerror = () => { fail('The encoder reply could not be read.'); worker.terminate(); };

const running = new Map(), clips = new Map();
const refusal = (code, message) => Object.assign(new Error(message), {code});
// One part of a video's frames: RGBA, one frame after another, each with its time in seconds.
async function frames({id, part, width, height, times}) {
  const response = await fetch(`/in/${id}.${part}`);
  if (!response.ok) throw refusal('JXL_BRIDGE', 'Swift did not send the frames.');
  const buffer = await response.arrayBuffer(), size = width * height * 4;
  if (buffer.byteLength !== size * times.length) throw refusal('JXL_BRIDGE', 'Swift sent part of a frame.');
  if (!clips.has(id)) clips.set(id, {width, height, frames: []});
  const clip = clips.get(id);
  times.forEach((time, i) => clip.frames.push({data: new Uint8ClampedArray(buffer, i * size, size), time}));
}
// A video's frames, each lasting until the next one's time and the last until `end`, looping forever.
function clipOf(id, end) {
  const clip = clips.get(id);
  clips.delete(id);
  if (!clip?.frames.length) throw refusal('JXL_INPUT', 'Video has no frames.');
  const {width, height, frames} = clip;
  return {width, height, loops: 0, frames: frames.map(({data, time}, i) => ({data, duration: ((frames[i + 1]?.time ?? end) - time) * 1000}))};
}
async function animate({id, mime, quality, effort, end}) {
  const controller = new AbortController(), {signal} = controller;
  running.set(id, controller);
  try {
    let input;
    if (mime === 'video/frames') input = clipOf(id, end);
    else {
      const response = await fetch(`/in/${id}`);
      if (!response.ok) throw refusal('JXL_BRIDGE', 'Swift did not send the input.');
      input = new Blob([await response.arrayBuffer()], {type: mime});
    }
    tell({type: 'started', id});
    const {encode} = await import('./jpegxl/animation.browser.mjs');
    let shown = -1;
    const result = await encode(input, {effort, fidelity: {quality}, signal, ...(!(input instanceof Blob) && {transfer: true}), onProgress: fraction => {
      const step = Math.floor(fraction * 100);
      if (step > shown) { shown = step; tell({type: 'progress', id, fraction}); }
    }});
    if (!result.bytes) throw refusal(result.reason.code, result.reason.message);
    const stored = await fetch(`/out/${id}/result`, {method: 'POST', body: result.bytes});
    if (!stored.ok) throw refusal('JXL_BRIDGE', 'Swift did not take the result.');
    tell({type: 'done', id});
  } catch (error) {
    const code = error?.name === 'AbortError' ? 'JXL_CANCELED' : /^JXL_[A-Z0-9_]+$/.test(error?.code) ? error.code : 'JXL_MESSAGE';
    tell({type: 'error', id, code, message: (error?.message || String(error)) + (error?.cause?.message ? ` (${error.cause.message})` : '')});
  } finally { running.delete(id); }
}
globalThis.rapier = {
  run: job => job.op === 'animate' ? animate(job) : worker.postMessage(job),
  frames,
  drop: id => clips.delete(id),
  cancel: id => running.has(id) ? running.get(id).abort() : worker.postMessage({type: 'cancel', id})
};
