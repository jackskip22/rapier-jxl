// Relays Swift's calls to the worker and the worker's answers to Swift. An animation (a GIF or a video) is made here,
// where the browser plays a video: rapier-jxl/animation reads it on the page and encodes in its own worker. Bytes never
// pass through Swift's messages: each call reads its input from /in/<id> and writes its output to /out/<id>/<kind>.
const tell = message => webkit.messageHandlers.rapier.postMessage(JSON.stringify(message));
const worker = new Worker(new URL('./encoder.mjs', location.href), {type: 'module'});
const fail = message => tell({type: 'error', id: null, code: 'JXL_WORKER', message});
worker.onmessage = ({data}) => tell(data);
worker.onerror = event => { event.preventDefault(); fail(event.message || 'The encoder worker stopped.'); worker.terminate(); };
worker.onmessageerror = () => { fail('The encoder reply could not be read.'); worker.terminate(); };

const running = new Map();
const refusal = (code, message) => Object.assign(new Error(message), {code});
async function animate({id, mime, quality, effort}) {
  const controller = new AbortController(), {signal} = controller;
  running.set(id, controller);
  try {
    const response = await fetch(`/in/${id}`);
    if (!response.ok) throw refusal('JXL_BRIDGE', 'Swift did not send the input.');
    const input = new Blob([await response.arrayBuffer()], {type: mime});
    tell({type: 'started', id});
    const {encode} = await import('./jpegxl/animation.browser.mjs');
    let shown = -1;
    const result = await encode(input, {effort, fidelity: {quality}, signal, onProgress: fraction => {
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
  cancel: id => running.has(id) ? running.get(id).abort() : worker.postMessage({type: 'cancel', id})
};
