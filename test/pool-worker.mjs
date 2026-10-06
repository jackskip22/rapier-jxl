// SPDX-License-Identifier: MIT
// A pool member under Node: worker_threads in place of a browser's Worker, the same message protocol (pool.mjs).
import {parentPort, workerData} from 'node:worker_threads';
import {servePool} from '../src/pool.mjs';

// A member told to fail does so at its nth task, as a worker that crashes mid-encode.
let tasks = 0;
parentPort.on('message', message => {
  if (message.pool === 'task' && ++tasks === workerData?.crashAt) process.exit(3);
  const reply = servePool(message);
  if (reply) parentPort.postMessage(...reply);
});
