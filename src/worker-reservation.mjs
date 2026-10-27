// SPDX-License-Identifier: MIT
const AC_SCRATCH_BYTES = 1376256 + 12288;
const ZERO = Object.freeze({count: 0, runtimeBytes: 0, jobBytes: 0, inputBytes: 0, outputBytes: 0,
  scratchBytes: AC_SCRATCH_BYTES, totalBytes: 0});
const FIELDS = ['count', 'runtimeBytes', 'jobBytes', 'inputBytes', 'outputBytes', 'scratchBytes', 'totalBytes'];
const BUFFER_BYTES = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
const RESERVATION_TYPED_BUFFER = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'buffer').get;
const VIEW_BUFFER = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer').get;
const STAGE_GRANTS = new WeakMap();
const leaseRefusal = message => Object.assign(new Error(message), {code: 'JXL_WORKER_LEASE'});

export function claimWorkerReservation(value, spawn, role) {
  let reservation;
  try { reservation = validateWorkerReservation(value); }
  catch (error) { throw Object.assign(leaseRefusal('Worker reservation is malformed.'), {cause: error}); }
  if (!reservation.count) return {reservation, check() {}, release() {}, fail() {}};
  const grant = STAGE_GRANTS.get(value);
  if (!grant || grant.spawn !== spawn || grant.role !== role || grant.used)
    throw leaseRefusal('Worker reservation is not a current grant for this stage.');
  grant.check();
  grant.used = true;
  return {reservation: value, check: grant.check, release: grant.release, fail: grant.fail};
}

export function validateWorkerReservation(value) {
  if (value === undefined) return ZERO;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid worker reservation.');
  const reservation = Object.fromEntries(FIELDS.map(name => [name, value[name]]));
  if (FIELDS.some(name => !Number.isSafeInteger(reservation[name]) || reservation[name] < 0))
    throw new TypeError('Worker reservation values must be nonnegative safe integers.');
  const {count, runtimeBytes, jobBytes, inputBytes, outputBytes, scratchBytes, totalBytes} = reservation;
  const perWorker = runtimeBytes + jobBytes, total = count * perWorker;
  if (!Number.isSafeInteger(perWorker) || !Number.isSafeInteger(total) || totalBytes !== total)
    throw new RangeError('Worker reservation total does not match its instance count.');
  if (scratchBytes < AC_SCRATCH_BYTES)
    throw new RangeError('Worker reservation does not cover the helper AC scratch floor.');
  if (count && (!runtimeBytes || !inputBytes || !outputBytes ||
      !Number.isSafeInteger(inputBytes + 2 * outputBytes + scratchBytes) ||
      jobBytes < inputBytes + 2 * outputBytes + scratchBytes))
    throw new RangeError('Worker reservation does not cover its input, output growth and AC scratch.');
  return Object.freeze(reservation);
}

export function workerBackingBytes(payload) {
  const objects = new Set(), buffers = new Set(); let bytes = 0;
  const buffer = value => {
    if (!(value instanceof ArrayBuffer)) throw new TypeError('Worker payloads require owned ArrayBuffers.');
    if (buffers.has(value)) return;
    buffers.add(value); bytes += BUFFER_BYTES.call(value);
    if (!Number.isSafeInteger(bytes)) throw new RangeError('Worker backing storage exceeds a safe byte count.');
  };
  const visit = value => {
    if (value === null || value === undefined) return;
    const type = typeof value;
    if (type === 'function' || type === 'symbol') throw new TypeError('Worker payloads must contain cloneable data.');
    if (type !== 'object') return;
    if (ArrayBuffer.isView(value)) { buffer((value instanceof DataView ? VIEW_BUFFER : RESERVATION_TYPED_BUFFER).call(value)); return; }
    if (value instanceof ArrayBuffer) { buffer(value); return; }
    if (typeof SharedArrayBuffer === 'function' && value instanceof SharedArrayBuffer)
      throw new TypeError('Shared worker buffers are not admitted.');
    if (objects.has(value)) return;
    objects.add(value);
    if (value instanceof Map) { for (const [key, entry] of Map.prototype.entries.call(value)) { visit(key); visit(entry); } return; }
    if (value instanceof Set) { for (const entry of Set.prototype.values.call(value)) visit(entry); return; }
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
      throw new TypeError('Opaque worker payloads are not admitted.');
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) throw new TypeError('Worker payload accessors are not admitted.');
      visit(descriptor.value);
    }
  };
  visit(payload); return bytes;
}

export function workerLease(value, factory) {
  const reservation = validateWorkerReservation(value), members = new Set();
  let closed = false, closing, failed = false, failure;
  let epoch = 0, activeGrant = null;
  const failedTermination = error => {
    closed = true;
    if (!failed) { failed = true; failure = error; }
  };
  const refusal = message => Object.assign(new Error(message), {code: 'JXL_WORKER_LEASE', ...(failed ? {cause: failure} : {})});
  if (factory !== undefined && typeof factory !== 'function') throw new TypeError('spawn must create a worker.');
  const spawn = (...args) => {
    if (closed || members.size >= reservation.count) throw refusal('Worker reservation is exhausted or closed.');
    if (!factory) throw new Error('Worker creation is unavailable.');
    const slot = {}; members.add(slot);
    let worker, nativeTerminate, ending = false, result;
    const release = () => members.delete(slot);
    const terminate = () => {
      if (ending) return result;
      ending = true;
      try {
        result = nativeTerminate.call(worker);
        if (result && typeof result.then === 'function') result.then(release, failedTermination);
        else release();
        return result;
      } catch (error) { failedTermination(error); throw error; }
    };
    try {
      worker = factory(...args); nativeTerminate = worker?.terminate;
      if (typeof nativeTerminate !== 'function') throw new TypeError('spawn must return a terminable worker.');
      slot.terminate = terminate;
      if (closed || typeof worker.postMessage !== 'function') throw new TypeError('spawn must return an available worker.');
      worker.terminate = terminate;
      if (worker.terminate !== terminate) throw new TypeError('Worker termination cannot be accounted.');
      return worker;
    } catch (error) {
      if (typeof nativeTerminate === 'function') { try { terminate(); } catch {} }
      else if (worker !== null && (typeof worker === 'object' || typeof worker === 'function')) failedTermination(error);
      else release();
      if (closed || members.has(slot)) {
        closed = true;
        throw Object.assign(refusal('Worker runtime release could not be confirmed.'), {cause: error});
      }
      throw error;
    }
  };
  const stage = (role, count = reservation.count) => {
    if (role !== 'ac' && role !== 'exact') throw new TypeError('Unknown worker stage.');
    if (!Number.isSafeInteger(count) || count < 0 || count > reservation.count)
      throw new RangeError('Worker stage count exceeds its coordinator reservation.');
    if (closed || activeGrant || members.size)
      throw refusal('The previous worker stage has not retired.');
    const token = validateWorkerReservation({...reservation, count, totalBytes: count * (reservation.runtimeBytes + reservation.jobBytes)});
    if (!count) return Object.freeze({reservation: token, spawn() { throw refusal('This worker stage has zero capacity.'); }});
    const grant = {role, epoch: ++epoch, used: false, retired: false};
    grant.check = () => {
      if (closed || activeGrant !== grant || grant.epoch !== epoch || grant.retired)
        throw refusal('Worker reservation is stale or closed.');
    };
    grant.spawn = (...args) => {
      grant.check();
      if (!grant.used) throw refusal('The worker stage has not claimed its reservation.');
      if (members.size >= count) throw refusal('Worker stage reservation is exhausted.');
      return spawn(...args);
    };
    grant.release = () => {
      if (grant.retired) return;
      if (failed) throw failure;
      if (members.size) throw refusal('Worker runtimes have not finished retiring.');
      grant.retired = true;
      if (activeGrant === grant) activeGrant = null;
    };
    grant.fail = failedTermination;
    activeGrant = grant;
    STAGE_GRANTS.set(token, grant);
    return Object.freeze({reservation: token, spawn: grant.spawn});
  };
  const close = () => {
    if (closing) return closing;
    closed = true;
    closing = Promise.resolve().then(async () => {
      const pending = [];
      for (const slot of members) {
        try { const result = slot.terminate?.(); if (result) pending.push(result); }
        catch (error) { failedTermination(error); }
      }
      await Promise.allSettled(pending);
      if (failed) throw failure;
      if (members.size) throw new Error('Worker runtime release could not be confirmed.');
    });
    return closing;
  };
  return {reservation, spawn, stage, close};
}
