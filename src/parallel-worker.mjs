// SPDX-License-Identifier: MIT
const port = typeof WorkerGlobalScope === 'function' ? self : globalThis.process.getBuiltinModule('node:worker_threads').parentPort;
const fatal = error => setTimeout(() => { throw error; });
const described = error => ({name: String(error?.name ?? 'Error'), ...(typeof error?.code === 'string' ? {code: error.code} : {}), message: String(error?.message ?? error)});
const post = (reply, transfer, answer) => {
  try { port.postMessage(reply, transfer); }
  catch (error) { port.postMessage(answer(error)); }
};
const kernels = import('./kernels.mjs').then(module => { module.disableEntropyKernels(); return module; }), split = import('./photo-split.mjs'), codec = import('./v7/run-codec.mjs');
const loaded = Promise.all([kernels, split, codec, import('./v7/common.mjs'), import('./v7/input.mjs'), import('./v7/acceleration.mjs'), import('./effort-job.mjs')]);
loaded.then(() => port.postMessage({ready: true}), fatal);
const ok = loaded.then(() => true, () => false);
let serving;
let order = Promise.resolve();
const next = step => { order = order.then(async () => { if (await ok) await step(); }).catch(fatal); };
async function whole({id, task}) {
  try {
    const {runCodec} = await codec;
    const result = await runCodec(task.operation, task.input, task.options, {maxPixels: task.maxPixels, onProgress: progress => port.postMessage({id, progress})});
    post({id, result}, ArrayBuffer.isView(result) ? [result.buffer] : [], error => ({id, error: described(error)}));
  } catch (error) { port.postMessage({id, error: described(error)}); }
}
const serve = data => {
  if (data?.kernels !== undefined && data.input === undefined && data.task === undefined) { next(async () => (await kernels).configureKernels(data.kernels)); return; }
  if (data?.task?.kind === 'whole') { order.then(async () => { if (await ok) await whole(data); }).catch(fatal); return; }
  if (data?.split !== undefined) {
    const answer = error => ({split: data.split, key: data.key, ticket: data.ticket, error: described(error)});
    next(async () => {
      let reply, transfer = [];
      try { [reply, transfer] = (await split).serveSplit(data); }
      catch (error) { reply = answer(error); }
      post(reply, transfer, answer);
    });
    return;
  }
  next(async () => {
    let module;
    try { module = await (serving ||= import('./parallel-serve.mjs')); }
    catch (error) { serving = null; throw error; }
    let reply;
    try { reply = module.serveParallel(data); }
    catch (error) { reply = [{id: data?.id, error: described(error)}, []]; }
    if (reply) post(reply[0], reply[1], error => ({id: data?.id, error: described(error)}));
  });
};
if (port.on) port.on('message', serve); else port.onmessage = event => serve(event.data);
