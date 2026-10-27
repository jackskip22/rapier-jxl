// SPDX-License-Identifier: MIT
import {BitWriter} from './bits.mjs';
import {ansGroupWriter} from './ans.mjs';
import {prefixGroupWriter} from './entropy.mjs';
import {acContexts, walkACGroup} from './vardct.mjs';
import {claimWorkerReservation, workerBackingBytes} from './worker-reservation.mjs';

export function acGroupEncoder(model, maxOutputBytes = Infinity) {
  if (maxOutputBytes !== Infinity && (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0))
    throw new RangeError('Invalid AC output reservation.');
  const coding = model.coding.kind === 'ans' ? ansGroupWriter(model.coding) : prefixGroupWriter(model.coding);
  const {contexts} = model;
  const state = {...model, contexts: {...contexts, ...acContexts(contexts.map, contexts.numDc, contexts.numCtxs)},
    nzeros: [0, 1, 2].map(() => new Int32Array(32 * 32)), groupsX: 1, map: [0, 1, 2], counted: true};
  return data => {
    const w = new BitWriter(Math.min(4096, maxOutputBytes), maxOutputBytes);
    try {
      walkACGroup({...state, ...data}, 0, (ctx, value) => coding.write(w, ctx, value));
      coding.flush?.(w);
      return {bytes: w.bytes, at: w.at, pending: w.pending, acc: w.acc};
    } finally { coding.reset?.(); }
  };
}

let current;
export function serveAcGroup(message) {
  const {id, g} = message;
  try {
    if (message.pool === 'ac-model') {
      current = null;
      if (!Number.isSafeInteger(message.maxOutputBytes) || message.maxOutputBytes <= 0)
        throw new RangeError('AC helpers require a bounded output reservation.');
      current = {id, encode: acGroupEncoder(message.model, message.maxOutputBytes)};
      return null;
    }
    if (message.pool !== 'ac-group') throw new Error('Unknown AC worker message.');
    if (!current || current.id !== id) throw new Error('AC group has no selected model.');
    const result = current.encode(message.data);
    return [{pool: 'ac-done', id, g, result}, [result.bytes.buffer]];
  } catch (error) {
    return [{pool: 'ac-done', id, g: g ?? -1, error: {name: String(error?.name ?? 'Error'),
      ...(typeof error?.code === 'string' ? {code: error.code} : {}), message: String(error?.message ?? error)}}, []];
  }
}

const validParts = result => result?.bytes instanceof Uint8Array && result.bytes.buffer instanceof ArrayBuffer
  && Number.isInteger(result.at) && result.at >= 0
  && result.at <= result.bytes.length && Number.isInteger(result.pending) && result.pending >= 0 && result.pending < 8
  && Number.isInteger(result.acc) && result.acc >= 0 && result.acc < (1 << result.pending);
const fatalAdmission = error => error?.code === 'JXL_MEMORY' || error?.code === 'JXL_WORKER_LEASE';

export function acGroupPool({spawn, reservation, signal} = {}) {
  signal?.throwIfAborted();
  const admission = claimWorkerReservation(reservation, spawn, 'ac'), admitted = admission.reservation;
  const workers = admitted.count;
  let members = [], active = null, serial = 0, closed = false, closedReason, disabled = !workers || typeof spawn !== 'function';
  let retirement = Promise.resolve(), retirementState, retirementFailed = false, retirementFailure;
  const failedRetirement = reason => {
    if (!retirementFailed) { retirementFailed = true; retirementFailure = reason; }
  };
  const observed = promise => { promise.catch(() => {}); return promise; };
  const end = () => {
    const retiring = members; members = [];
    if (!retiring.length) return retirement;
    const pending = [retirement];
    for (const member of retiring) {
      for (const event of ['onmessage', 'onerror', 'onmessageerror']) {
        try { member.worker[event] = null; } catch {}
      }
      try {
        const result = member.worker.terminate();
        if (result) pending.push(Promise.resolve(result).catch(reason => { failedRetirement(reason); throw reason; }));
      } catch (reason) { failedRetirement(reason); }
    }
    const state = {done: false, failed: false}; retirementState = state;
    retirement = observed(Promise.allSettled(pending).then(() => {
      state.done = true; state.failed = retirementFailed; state.reason = retirementFailure;
      active?.wake();
      if (state.failed) throw state.reason;
    }));
    return retirement;
  };
  const terminate = (reason = new Error('AC group pool is closed.')) => {
    if (!closed) {
      closed = true; closedReason = reason;
      signal?.removeEventListener('abort', abort);
      active?.cancel(reason); end();
    }
    return observed(Promise.resolve().then(() => retirement).then(() => admission.release(), error => {
      admission.fail(error); throw error;
    }));
  };
  const abort = () => { terminate(signal.reason); };
  signal?.addEventListener('abort', abort, {once: true});
  if (signal?.aborted) abort();
  const start = () => {
    if (closed) throw closedReason;
    const member = {worker: spawn(), g: null, modelId: null, modelBytes: 0, previousModelBytes: 0}, {worker} = member;
    members.push(member);
    if (closed) { end(); throw closedReason; }
    worker.onmessage = ({data}) => { if (members.includes(member)) active?.receive(member, data); };
    worker.onerror = worker.onmessageerror = event => {
      event?.preventDefault?.();
      if (!members.includes(member)) return;
      if (active) active.fail(); else { disabled = true; end(); }
    };
  };

  function pass(request) {
    let settled = false, hurryRequested = false, wakeHurry;
    const it = (async function* () {
      signal?.throwIfAborted();
      if (closed) throw closedReason;
      if (active) throw new Error('AC group passes must run in order.');
      const id = ++serial, results = new Array(request.groups), errors = new Array(request.groups), waiting = new Set(results.keys()), ready = [];
      let next = 0, completed = 0, wake, canceled = false, error, finished = false, modelBytes = 0, localFailed = false;
      let localFailureIndex = Infinity, localFailure, refused = false, refusal;
      const settle = (reason, rejected = false) => {
        const pending = wake; wake = null;
        if (!pending) return;
        clearTimeout(pending.timer);
        rejected ? pending.reject(reason) : pending.resolve();
      };
      const cancel = reason => { canceled = true; error = reason; settle(reason, true); };
      active = {id, cancel, wake: settle};
      const check = () => {
        signal?.throwIfAborted();
        if (canceled || closed) throw canceled ? error : closedReason;
        admission.check();
      };
      const pause = turn => new Promise((resolve, reject) => {
        if (canceled || closed) { reject(canceled ? error : closedReason); return; }
        wake = {resolve, reject};
        if (turn) wake.timer = setTimeout(() => settle(), 0);
      });
      wakeHurry = () => settle();
      const needsDrain = () => retirementState && (!retirementState.done || retirementState.failed);
      const drained = async () => {
        let pending = retirementState;
        while (pending && !pending.done) { check(); await pause(false); pending = retirementState; }
        check();
        if (pending?.failed) {
          const primary = localFailed ? localFailure : pending.reason;
          if (!refused) {
            closed = true; closedReason = primary;
            signal?.removeEventListener('abort', abort);
          }
          throw primary;
        }
      };
      const fail = () => { disabled = true; end(); settle(); };
      const refuse = reported => {
        if (!fatalAdmission(reported)) return false;
        try { check(); }
        catch (reason) { terminate(reason); return true; }
        const failure = new Error(typeof reported.message === 'string' ? reported.message : 'AC worker admission failed.');
        failure.code = reported.code;
        if (typeof reported.name === 'string') failure.name = reported.name;
        refused = true; refusal = failure; disabled = true; end(); settle(); return true;
      };
      const finishRefusal = async () => {
        try { await drained(); }
        catch { check(); }
        check(); terminate(refusal); throw refusal;
      };
      active.fail = fail;
      active.receive = (member, data) => {
        if (Number.isSafeInteger(data?.id) && data.id > 0 && data.id < id) return;
        if (data?.pool !== 'ac-done' || data.id !== id) { fail(); return; }
        if (data.g === -1) {
          if (member.modelId === id && Object.hasOwn(data, 'error') && refuse(data.error)) return;
          fail(); return;
        }
        if (!Number.isInteger(data.g) || data.g < 0 || data.g >= request.groups) { fail(); return; }
        if (data.g !== member.g) {
          if (!waiting.has(data.g) || ready.some(reply => reply.g === data.g)) return;
          fail(); return;
        }
        if (Object.hasOwn(data, 'error')) { if (!refuse(data.error)) fail(); return; }
        if (!validParts(data.result) || data.result.bytes.buffer.byteLength > admitted.outputBytes) { fail(); return; }
        member.previousModelBytes = 0;
        member.g = null; ready.push({g: data.g, result: data.result}); settle();
      };
      const send = (member, message, transfer = []) => {
        try { member.worker.postMessage(message, transfer); return !disabled; }
        catch (error) { check(); if (fatalAdmission(error)) throw error; fail(); return false; }
      };
      const feed = () => {
        for (const member of members) if (member.g === null && next < request.groups) {
          const g = next++;
          try {
            const remaining = admitted.inputBytes - member.previousModelBytes - member.modelBytes;
            const {data, transfer} = request.job(g, remaining);
            check();
            if (member.previousModelBytes + member.modelBytes + workerBackingBytes({data, transfer}) > admitted.inputBytes) { fail(); return; }
            member.g = g;
            if (!send(member, {pool: 'ac-group', id, g, data}, transfer)) return;
          } catch (error) {
            check();
            if (fatalAdmission(error)) throw error;
            fail(); return;
          }
        }
      };
      try {
        if (hurryRequested && request.stop(-1)) return null;
        if (needsDrain()) {
          await drained(); check();
          if (hurryRequested && request.stop(-1)) return null;
        }
        if (!disabled) {
          try { modelBytes = workerBackingBytes(request.model); if (modelBytes > admitted.inputBytes) fail(); }
          catch { fail(); }
        }
        if (!disabled) {
          try {
            const count = Math.min(workers, request.groups - 1);
            while (members.length < count) start();
          } catch (error) { check(); if (fatalAdmission(error)) throw error; fail(); }
          for (const member of members) {
            const previous = member.previousModelBytes + member.modelBytes;
            if (previous + modelBytes > admitted.inputBytes) { fail(); break; }
            member.previousModelBytes = previous; member.modelBytes = modelBytes; member.modelId = id;
            member.g = null;
            if (!send(member, {pool: 'ac-model', id, model: request.model, maxOutputBytes: admitted.outputBytes})) break;
          }
        }
        while (waiting.size) {
          check();
          if (refused) await finishRefusal();
          if (hurryRequested && !localFailed && request.stop(completed - 1) && ready.length < waiting.size) return null;
          feed(); check();
          if (refused) await finishRefusal();
          let result = ready.shift();
          if (!result) {
            if (needsDrain()) {
              try { await drained(); }
              catch (reason) { check(); if (refused) await finishRefusal(); throw reason; }
              check();
              if (refused) await finishRefusal();
              if (ready.length) continue;
              if (hurryRequested && !localFailed && request.stop(completed - 1)) return null;
            }
            check();
            const g = disabled || !members.length ? waiting.values().next().value : next < request.groups ? next++ : undefined;
            if (g === undefined) { await pause(false); continue; }
            try { result = {g, result: request.local(g)}; }
            catch (failure) {
              check(); result = {g, failed: true, error: failure}; localFailed = true;
              if (g < localFailureIndex) { localFailureIndex = g; localFailure = failure; }
              end();
            }
            await pause(true);
          }
          check();
          if (refused) await finishRefusal();
          if (!waiting.delete(result.g)) continue;
          if (result.failed) errors[result.g] = result.error;
          else results[result.g] = result.result;
          const hurry = yield request.at(completed++);
          hurryRequested ||= !!hurry;
          check();
        }
        finished = true;
        return {results, errors, hurried: hurryRequested};
      } finally {
        if (!finished || hurryRequested) end();
        settle(); active = null; settled = true; wakeHurry = null;
      }
    })();
    Object.defineProperty(it, 'hurry', {get: () => hurryRequested, set(value) {
      if (!value || settled) return;
      hurryRequested = true; wakeHurry?.();
    }});
    const advance = it.next.bind(it);
    it.next = value => { if (value) it.hurry = true; return advance(value); };
    const leave = it.return.bind(it);
    it.return = value => { if (!settled) terminate(); return leave(value); };
    return it;
  }
  return {pass, terminate};
}

