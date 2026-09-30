// SPDX-License-Identifier: MIT
import {parentPort, workerData} from 'node:worker_threads';
import {createHash} from 'node:crypto';
const module = await import(workerData.module);
const {rgba, width, height, quality, photo} = workerData;
parentPort.postMessage({started: true});
const start = performance.now(), before = process.memoryUsage();
try {
  const bytes = (photo ? module.encodePhoto : module.encode)(rgba, width, height, {quality});
  const ms = performance.now() - start;
  parentPort.postMessage({bytes: bytes.length, ms, sha256: createHash('sha256').update(bytes).digest('hex'), before, after: process.memoryUsage(), processPeakRSSKiB: process.resourceUsage().maxRSS});
} catch (error) { parentPort.postMessage({error: String(error), code: error.code, ms: performance.now() - start}); }
