// SPDX-License-Identifier: MIT
let next = 0;
const fail = (code, message) => Object.assign(new Error(message), {code}), turns = new WeakMap();

export async function toJXL(source, {worker, ...options} = {}) {
  if (!worker) throw fail('JXL_OPTIONS', 'Pass a worker as {worker}: a Worker running rapier-still-worker.js or rapier-worker.js, or the URL of either.');
  const plain = source instanceof Blob || typeof ImageData === 'function' && source instanceof ImageData;
  const picture = plain ? source : await createImageBitmap(source);
  const own = typeof worker === 'string' || worker instanceof URL, thread = own ? new Worker(worker) : worker, id = 'image' + ++next;
  // A worker encodes one picture at a time. Calls that share one wait their turn instead of failing JXL_BUSY.
  const turn = (turns.get(thread) ?? Promise.resolve()).then(() => new Promise((resolve, reject) => {
    const done = () => { thread.removeEventListener('message', reply); thread.removeEventListener('error', broke); };
    const reply = ({data}) => {
      if (data?.id !== id || !('ok' in data)) return;
      done();
      if (data.ok) resolve(new Blob([data.bytes], {type: 'image/jxl'}));
      else reject(Object.assign(new Error(data.error.message), data.error));
    };
    const broke = event => { done(); reject(fail('JXL_WORKER', event?.message || 'The JPEG XL worker failed.')); };
    thread.addEventListener('message', reply);
    thread.addEventListener('error', broke);
    thread.postMessage({id, operation: 'image', source: picture, options}, plain ? [] : [picture]);
  }));
  turns.set(thread, turn.catch(() => {}));
  try {
    return await turn;
  } finally {
    if (own) thread.terminate();
  }
}
