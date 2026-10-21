// SPDX-License-Identifier: MIT
// The same complete-encoder caller in Node worker_threads and a real browser Worker.
const isNode = Boolean(globalThis.process?.versions?.node);
let Port, Thread, hash;
if (isNode) {
  ({parentPort: Port, Worker: Thread} = await import('node:worker_threads'));
  const {createHash} = await import('node:crypto');
  hash = async bytes => createHash('sha256').update(bytes).digest('hex');
} else {
  hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}
const send = (message, transfer = []) => isNode ? Port.postMessage(message, transfer) : globalThis.postMessage(message, transfer);
let codec, module, root, helpers, image, members = new Set(), spawned = 0, errors = 0, tasks = 0, peak = 0;

function spawn() {
  const thread = isNode ? new Thread(new URL(import.meta.url), {type: 'module'}) : new Worker(import.meta.url, {type: 'module'});
  spawned++; members.add(thread); peak = Math.max(peak, members.size);
  thread.postMessage({kind: 'pool-init', root});
  if (!isNode) {
    const terminate = thread.terminate.bind(thread);
    thread.terminate = () => { members.delete(thread); terminate(); };
    const post = thread.postMessage.bind(thread);
    thread.postMessage = (message, transfer) => { if (message.pool === 'task' || message.pool === 'candidate' || message.pool === 'photo') tasks++; post(message, transfer || []); };
    thread.addEventListener('error', () => { errors++; });
    return thread;
  }
  let ended = false;
  const worker = {
    postMessage(message, transfer) { if (message.pool === 'task' || message.pool === 'candidate' || message.pool === 'photo') tasks++; thread.postMessage(message, transfer); },
    terminate() { ended = true; members.delete(thread); return thread.terminate(); },
    onmessage: null, onerror: null, onmessageerror: null,
  };
  thread.on('message', data => worker.onmessage?.({data}));
  thread.on('error', error => { errors++; worker.onerror?.(error); });
  thread.on('exit', code => { if (!ended) { errors++; worker.onerror?.(new Error('Worker exited: ' + code)); } });
  return worker;
}

async function command(message) {
  if (message.kind === 'init' || message.kind === 'pool-init') {
    root = message.root; helpers = message.helpers || 0;
    Object.defineProperty(globalThis, 'navigator', {value: {hardwareConcurrency: helpers + 1}, configurable: true});
    const started = performance.now();
    module = await import(root + '/rapier.mjs');
    codec = module.createEncoder({spawn});
    return {ready: true, importMs: performance.now() - started, runtime: isNode ? process.version : navigator.userAgent};
  }
  if (message.pool) {
    const reply = codec.serve(message, report => send(report));
    if (reply) send(...reply);
    return null;
  }
  if (message.kind === 'input') {
    const {buffer, descriptor} = message;
    const data = descriptor.bitDepth === 16 ? new Uint16Array(buffer) : new Uint8Array(buffer);
    if (data.length !== descriptor.width * descriptor.height * 4) throw new Error('Input extent mismatch');
    image = {...descriptor, data};
    return {input: descriptor.id, hash: await hash(new Uint8Array(buffer))};
  }
  if (message.kind === 'measure') {
    const {warmups, repeats, options} = message, samples = [], warmupSamples = [];
    let bytes, expected;
    const before = {spawned, errors, tasks};
    peak = members.size;
    for (let i = 0; i < warmups + repeats; i++) {
      const data = image.data.slice();
      const counts = {spawned, errors, tasks};
      const cpu = isNode ? process.cpuUsage() : null, started = performance.now();
      bytes = await codec.encode({data, width: image.width, height: image.height}, {...options, parallel: helpers > 0});
      const ms = performance.now() - started, used = cpu ? process.cpuUsage(cpu) : null;
      const sample = {ms, ...(used ? {cpuMs: (used.user + used.system) / 1000} : {}),
        workersStarted: spawned - counts.spawned, workerErrors: errors - counts.errors, workerTasks: tasks - counts.tasks};
      const outputHash = await hash(bytes);
      expected ??= outputHash;
      if (outputHash !== expected) throw new Error('Encoder output changed between repeats');
      (i < warmups ? warmupSamples : samples).push(sample);
    }
    return {samples, warmupSamples, bytes, sha256: expected, kernelMode: module.kernelMode(),
      workersStarted: spawned - before.spawned, workerErrors: errors - before.errors, workerTasks: tasks - before.tasks,
      peakHelpers: peak,
      inputHash: await hash(new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength))};
  }
  throw new Error('Unknown benchmark command');
}

let queue = Promise.resolve();
function receive(message) {
  queue = queue.then(async () => {
    try {
      const result = await command(message);
      if (result) send({requestId: message.requestId, ...result}, result.bytes ? [result.bytes.buffer] : []);
    } catch (error) {
      send({requestId: message.requestId, failed: {message: String(error), stack: error.stack, code: error.code}});
    }
  });
}
if (isNode) Port.on('message', receive);
else globalThis.onmessage = ({data}) => receive(data);
