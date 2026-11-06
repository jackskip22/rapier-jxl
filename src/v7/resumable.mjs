// SPDX-License-Identifier: MIT
import {createJournalStepper} from '../resumable-journal.mjs';
import {sha256Start, sha256Update, sha256Finish} from '../sha256.mjs';
import {BUILD_VERSION} from '../build-version.mjs';
import {fail, declared, admitSignal, check} from './primitives.mjs';
import {copyBytes} from './bytes.mjs';
import {storedIdentity} from './identity-record.mjs';

const STEPS = Symbol.for('rapier-jxl.steps'), steppers = new WeakMap();
const text = new TextEncoder();
function stepsOf(operation) {
  const steps = typeof operation === 'function' ? operation[STEPS] : undefined;
  if (!steps) throw fail('JXL_UNSUPPORTED', 'This operation has no resumable steps; pass the verb itself, such as capture from rapier-jxl/capture.');
  let stepper = steppers.get(steps);
  if (!stepper) {
    const build = sha256Finish(sha256Update(sha256Start(), text.encode(BUILD_VERSION + '\0' + steps.id)));
    stepper = createJournalStepper({id: steps.id, build, normalize: steps.normalize, open: steps.open, run: steps.run, eager: steps.eager});
    steppers.set(steps, stepper);
  }
  return {steps, stepper};
}
function storeOf(store) {
  if (!store || typeof store !== 'object' || typeof store.readSource !== 'function' || typeof store.read !== 'function' ||
      typeof store.write !== 'function' && typeof store.writeMany !== 'function')
    throw fail('JXL_OPTIONS', 'A resumable store has readSource, read and write or writeMany (readMany is optional).');
  const unsaved = new Map();
  const read = async ref => unsaved.get(ref.hash) ?? await store.read({hash: ref.hash, length: ref.length});
  const readMany = async refs => {
    const away = refs.filter(ref => !unsaved.has(ref.hash));
    const found = !away.length ? [] : store.readMany ? await store.readMany(away.map(ref => ({hash: ref.hash, length: ref.length})))
      : await Promise.all(away.map(ref => store.read({hash: ref.hash, length: ref.length})));
    let i = 0;
    return refs.map(ref => unsaved.get(ref.hash) ?? found[i++]);
  };
  return {store, unsaved, read, readMany, readSource: (offset, length) => store.readSource(offset, length)};
}
const hold = (io, parts) => { for (const {ref, bytes} of parts ?? []) io.unsaved.set(ref.hash, bytes); };
async function keep(io) {
  const parts = [...io.unsaved].map(([hash, bytes]) => ({ref: {hash, length: bytes.length}, bytes: copyBytes(bytes)}));
  if (!parts.length) return;
  if (typeof io.store.writeMany === 'function') await io.store.writeMany(parts);
  else for (const {ref, bytes} of parts) await io.store.write(ref, bytes);
  io.unsaved.clear();
}
const host = (checkpoint, input, io, extra) => ({source: input, expectedRevision: checkpoint?.revision, read: io.read, readMany: io.readMany, readSource: io.readSource, ...extra});

export async function start({operation, input, options = {}, store} = {}) {
  try {
    const {stepper} = stepsOf(operation), io = storeOf(store);
    const {checkpoint, parts} = await stepper.start({source: input, options});
    hold(io, parts); await keep(io);
    return checkpoint;
  } catch (error) { throw declared(error); }
}

export async function advance(checkpoint, {operation, input, store, budget = {ms: 30}, signal} = {}) {
  try {
    admitSignal(signal);
    const ms = budget?.ms;
    if (!Number.isFinite(ms) || ms <= 0 || ms > 60000) throw fail('JXL_OPTIONS', 'budget is {ms} from 1 to 60000.');
    const {steps, stepper} = stepsOf(operation), io = storeOf(store), started = performance.now();
    await steps.prepare?.();
    check(signal);
    const result = await stepper.advance(checkpoint, host(checkpoint, input, io, {signal, deadline: started + ms * 0.7}), {units: 64});
    hold(io, result.parts);
    await keep(io);
    return {checkpoint: result.checkpoint, done: result.done};
  } catch (error) { throw declared(error); }
}

export async function finish(checkpoint, {operation, input, store, signal} = {}) {
  try {
    admitSignal(signal);
    const {steps, stepper} = stepsOf(operation), io = storeOf(store), h = host(checkpoint, input, io, {signal});
    const {byteLength, result} = await stepper.completion(checkpoint, h);
    let at = 0, bytes = byteLength ? null : new Uint8Array(0);
    for await (const part of stepper.outputParts(checkpoint, h)) {
      if (!bytes) try { bytes = new Uint8Array(byteLength); } catch { throw fail('JXL_INPUT', 'The finished file is larger than this runtime can hold.'); }
      bytes.set(part, at); at += part.length;
    }
    if (at !== byteLength) throw fail('JXL_INPUT', 'The saved output parts do not cover the finished file.');
    check(signal);
    const made = await steps.record(bytes, checkpoint.plan, checkpoint.source, result?.facts ?? null);
    const source = await storedIdentity(checkpoint.source), named = record => record.source ? record : {...record, source};
    return Array.isArray(made) ? made.map(named) : named(made);
  } catch (error) { throw declared(error); }
}
