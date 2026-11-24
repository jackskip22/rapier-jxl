// SPDX-License-Identifier: MIT
import {configureModules} from './wasm-modules.mjs';
import {ensureKernels, disableEntropyKernels, lendEntropy} from './kernels.mjs';
import {holdEntropy, releaseEntropy} from './kernel-hooks.mjs';
import {previewRelay} from './v7/preview-relay.mjs';


const helperPort = () => {
  try { const port = globalThis.process?.getBuiltinModule?.('node:worker_threads')?.parentPort; if (port) return port; } catch {}
  return typeof WorkerGlobalScope === 'function' && globalThis instanceof WorkerGlobalScope ? globalThis : null;
};
const described = error => ({name: String(error?.name ?? 'Error'), ...(typeof error?.code === 'string' ? {code: error.code} : {}), message: String(error?.message ?? error)});

export function serveHelper(load, port = helperPort()) {
  if (!port || typeof port.postMessage !== 'function') return;
  disableEntropyKernels();
  const fatal = error => setTimeout(() => { throw error; });
  const post = (reply, transfer, answer) => { try { port.postMessage(reply, transfer); } catch (error) { port.postMessage(answer(error)); } };
  const loaded = Promise.resolve().then(load);
  loaded.catch(fatal);
  const ok = loaded.then(() => true, () => false);
  let order = Promise.resolve(), previews;
  const next = step => { order = order.then(async () => { if (await ok) await step(await loaded); }).catch(fatal); };
  async function whole({id, task}, {run}) {
    const preview = task.preview === true ? previewRelay((value, sequence, transfer) => port.postMessage({id, preview: value, previewSequence: sequence}, transfer)) : null;
    if (preview) (previews ??= new Map()).set(id, preview);
    holdEntropy(lendEntropy);
    try {
      const result = await run(task.operation, task.input, task.options, {maxPixels: task.maxPixels, webgpu: task.webgpu, onProgress: progress => port.postMessage({id, progress}), ...(preview && {onPreview: preview.send})});
      post({id, result}, ArrayBuffer.isView(result) ? [result.buffer] : [], error => ({id, error: described(error)}));
    } catch (error) { port.postMessage({id, error: described(error)}); }
    finally { releaseEntropy(); preview?.close(); previews?.delete(id); }
  }
  const asked = new Map();
  let asks = 0;
  const relayOf = id => request => new Promise(resolve => { const ask = ++asks; asked.set(ask, resolve); port.postMessage({id, gpu: request, ask}); });
  const serve = data => {
    if (data?.previewAck !== undefined) { previews?.get(data.id)?.ack(data.previewAck); return; }
    if (data?.gpuAnswer !== undefined) { const resolve = asked.get(data.ask); asked.delete(data.ask); resolve?.(data.gpuAnswer); return; }
    if (data?.kernels !== undefined && data.input === undefined && data.task === undefined) {
      next(() => { if (data.wasmModules) configureModules(data.wasmModules); ensureKernels(); });
      return;
    }
    if (data?.task?.kind === 'whole') { order.then(async () => { if (await ok) await whole(data, await loaded); }).catch(fatal); return; }
    if (data?.split !== undefined) {
      const answer = error => ({split: data.split, key: data.key, ticket: data.ticket, error: described(error)});
      next(({serveSplit}) => {
        let reply, transfer = [];
        try { [reply, transfer] = serveSplit(data); } catch (error) { reply = answer(error); }
        post(reply, transfer, answer);
      });
      return;
    }
    next(async ({serveParallel}) => {
      let reply;
      if (!serveParallel) { if (data?.task === undefined) return; reply = [{id: data?.id, error: described(Object.assign(new Error('helper-runtime:task'), {code: 'JXL_INTERNAL'}))}, []]; }
      else try { reply = serveParallel(data, relayOf(data?.id)); if (reply?.then) reply = await reply; } catch (error) { reply = [{id: data?.id, error: described(error)}, []]; }
      if (reply) post(reply[0], reply[1], error => ({id: data?.id, error: described(error)}));
    });
  };
  if (port.on) port.on('message', serve); else port.onmessage = event => serve(event.data);
  loaded.then(({name, protocol}) => port.postMessage({ready: true, ...(name && {module: name}), ...(protocol && {protocol})}), () => {});
}
