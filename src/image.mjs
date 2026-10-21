// SPDX-License-Identifier: MIT
let next = 0;
const fail = (code, message) => Object.assign(new Error(message), {code});

export async function toJXL(source, {worker, ...options} = {}) {
  if (!worker) throw fail('JXL_OPTIONS', 'Pass the complete worker as {worker}: a Worker, or the URL of rapier-worker.js.');
  const plain = source instanceof Blob || typeof ImageData === 'function' && source instanceof ImageData;
  const picture = plain ? source : await createImageBitmap(source);
  const own = typeof worker === 'string' || worker instanceof URL, thread = own ? new Worker(worker) : worker, id = 'image' + ++next;
  try {
    return await new Promise((resolve, reject) => {
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
    });
  } finally {
    if (own) thread.terminate();
  }
}
