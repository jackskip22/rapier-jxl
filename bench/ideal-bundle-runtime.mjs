// SPDX-License-Identifier: MIT
// Run the unmodified classic distribution worker with worker_threads.
import {Worker, parentPort, workerData} from 'node:worker_threads';
import {readFileSync} from 'node:fs';

const {file, helpers, helper = false} = workerData;
Object.defineProperty(globalThis, 'navigator', {value: {hardwareConcurrency: helpers + 1}, configurable: true});
globalThis.location = {href: import.meta.url};
let started, cpu, activeId, spawned = 0, errors = 0, tasks = 0;
const responders = new Set();
class BrowserWorker {
  constructor() {
    spawned++;
    this.thread = new Worker(new URL(import.meta.url), {workerData: {file, helpers, helper: true}});
    this.thread.on('message', data => {
      if (data.pool === 'photo-done') responders.add(this);
      this.onmessage?.({data});
    });
    this.thread.on('error', error => { errors++; this.onerror?.(error); });
    this.thread.on('messageerror', error => { errors++; this.onmessageerror?.(error); });
  }
  postMessage(message, transfer) {
    if (message.pool === 'task' || message.pool === 'candidate' || message.pool === 'photo') tasks++;
    this.thread.postMessage(message, transfer);
  }
  terminate() { return this.thread.terminate(); }
}
globalThis.Worker = BrowserWorker;
globalThis.postMessage = (message, transfer) => {
  if (message.id === activeId && message.ok !== undefined) {
    const used = process.cpuUsage(cpu);
    message = {...message, measured: {ms: performance.now() - started, cpuMs: (used.user + used.system) / 1000,
      workersStarted: spawned, workerErrors: errors, workerTasks: tasks, photoResponders: responders.size}};
  }
  parentPort.postMessage(message, transfer);
};
(0, eval)(readFileSync(file, 'utf8'));
parentPort.on('message', data => {
  if (data.operation === 'encode') {
    started = performance.now(); cpu = process.cpuUsage(); activeId = data.id;
    spawned = 0; errors = 0; tasks = 0; responders.clear();
  }
  globalThis.onmessage({data});
});
if (!helper) parentPort.postMessage({ready: true});
