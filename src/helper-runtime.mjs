// SPDX-License-Identifier: MIT
import {configureModules} from './wasm-modules.mjs';
import {configureKernels, disableEntropyKernels} from './kernels.mjs';

disableEntropyKernels();

const helperPort = () => {
  try { const port = globalThis.process?.getBuiltinModule?.('node:worker_threads')?.parentPort; if (port) return port; } catch {}
  return typeof WorkerGlobalScope === 'function' && globalThis instanceof WorkerGlobalScope ? globalThis : null;
};
const described = error => ({name: String(error?.name ?? 'Error'), ...(typeof error?.code === 'string' ? {code: error.code} : {}), message: String(error?.message ?? error)});

export function serveHelper(load, port = helperPort()) {
  if (!port || typeof port.postMessage !== 'function') return;
  const fatal = error => setTimeout(() => { throw error; });
  const post = (reply, transfer, answer) => { try { port.postMessage(reply, transfer); } catch (error) { port.postMessage(answer(error)); } };
  const loaded = Promise.resolve().then(load);
  loaded.catch(fatal);
  const ok = loaded.then(() => true, () => false);
  let order = Promise.resolve();
  const next = step => { order = order.then(async () => { if (await ok) await step(await loaded); }).catch(fatal); };
  async function whole({id, task}, {run}) {
    try {
      const result = await run(task.operation, task.input, task.options, {maxPixels: task.maxPixels, webgpu: task.webgpu, onProgress: progress => port.postMessage({id, progress})});
      post({id, result}, ArrayBuffer.isView(result) ? [result.buffer] : [], error => ({id, error: described(error)}));
    } catch (error) { port.postMessage({id, error: described(error)}); }
  }
  const serve = data => {
    if (data?.kernels !== undefined && data.input === undefined && data.task === undefined) {
      next(({name, protocol}) => { if (data.wasmModules) configureModules(data.wasmModules); configureKernels(data.kernels);
        port.postMessage({ready: true, ...(name && {module: name}), ...(protocol && {protocol})}); });
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
    next(({serveParallel}) => {
      let reply;
      if (!serveParallel) { if (data?.task === undefined) return; reply = [{id: data?.id, error: described(Object.assign(new Error('This helper runs no stage task.'), {code: 'JXL_INTERNAL'}))}, []]; }
      else try { reply = serveParallel(data); } catch (error) { reply = [{id: data?.id, error: described(error)}, []]; }
      if (reply) post(reply[0], reply[1], error => ({id: data?.id, error: described(error)}));
    });
  };
  if (port.on) port.on('message', serve); else port.onmessage = event => serve(event.data);
}
