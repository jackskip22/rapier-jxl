// SPDX-License-Identifier: MIT
// A browser Worker's shape over Node's worker_threads, for pool.mjs: postMessage, onmessage({data}), onerror, terminate.
import {Worker} from 'node:worker_threads';

export function spawnNode(options = {}) {
  const thread = new Worker(new URL('./pool-worker.mjs', import.meta.url), {workerData: options});
  let ended = false;
  const worker = {
    postMessage: (message, transfer) => thread.postMessage(message, transfer),
    terminate: () => { ended = true; return thread.terminate(); },
    onmessage: null, onerror: null, thread,
  };
  thread.on('message', data => worker.onmessage?.({data}));
  thread.on('error', error => worker.onerror?.(error));
  thread.on('exit', code => { if (!ended) worker.onerror?.(new Error('pool worker exited with ' + code)); });
  return worker;
}
