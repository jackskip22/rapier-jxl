// SPDX-License-Identifier: MIT
// Run the packed browser worker protocol with real Node helper threads.
import {Worker, parentPort, workerData} from 'node:worker_threads';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const {file, classic, helper = false} = workerData;
Object.defineProperty(globalThis, 'navigator', {value: {hardwareConcurrency: 3}, configurable: true});
globalThis.location = {href: import.meta.url};
class BrowserWorker {
  constructor() {
    if (!helper) parentPort.postMessage({spawn: true});
    this.thread = new Worker(new URL(import.meta.url), {workerData: {file, classic, helper: true}});
    this.thread.on('message', data => this.onmessage?.({data}));
    this.thread.on('error', error => this.onerror?.(error));
  }
  postMessage(message, transfer) { this.thread.postMessage(message, transfer); }
  terminate() { return this.thread.terminate(); }
}
globalThis.Worker = BrowserWorker;
globalThis.postMessage = (...args) => parentPort.postMessage(...args);
if (classic) (0, eval)(readFileSync(file, 'utf8'));
else (await import(pathToFileURL(file))).installWorker({spawn: () => new BrowserWorker()});
parentPort.on('message', data => globalThis.onmessage({data}));
