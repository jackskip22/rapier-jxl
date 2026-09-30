// SPDX-License-Identifier: MIT
import {parentPort, workerData} from 'node:worker_threads';
const module = await import(workerData.module);
const {rgba, width, height, quality, photo} = workerData;
parentPort.postMessage({started: true});
const start = performance.now(), before = process.memoryUsage();
try {
  const bytes = (photo ? module.encodePhotoRGBA : module.encode)(rgba, width, height, {quality});
  parentPort.postMessage({bytes: bytes.length, ms: performance.now() - start, before, after: process.memoryUsage(), processPeakRSSKiB: process.resourceUsage().maxRSS});
} catch (error) { parentPort.postMessage({error: String(error), code: error.code, ms: performance.now() - start}); }
