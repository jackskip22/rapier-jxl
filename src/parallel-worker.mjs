// SPDX-License-Identifier: MIT
import {serveParallel} from './parallel-serve.mjs';
import {serveSplit} from './photo-split.mjs';

const port = typeof WorkerGlobalScope === 'function' ? self : globalThis.process.getBuiltinModule('node:worker_threads').parentPort;
async function whole({id, task}) {
  try {
    const {runCodec} = await import('./v7/run-codec.mjs');
    const result = await runCodec(task.operation, task.input, task.options, {maxPixels: task.maxPixels, onProgress: progress => port.postMessage({id, progress})});
    port.postMessage({id, result}, ArrayBuffer.isView(result) ? [result.buffer] : []);
  } catch (error) { port.postMessage({id, error: {name: error?.name, code: error?.code, message: error?.message}}); }
}
const serve = data => {
  if (data?.task?.kind === 'whole') { whole(data); return; }
  if (data?.split !== undefined) { const [reply, transfer] = serveSplit(data); port.postMessage(reply, transfer); return; }
  const reply = serveParallel(data);
  if (reply) port.postMessage(reply[0], reply[1]);
};
if (port.on) port.on('message', serve); else port.onmessage = event => serve(event.data);
