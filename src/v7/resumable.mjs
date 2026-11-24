// SPDX-License-Identifier: MIT
import './engines.mjs';
import {createJournalStepper} from '../resumable-journal.mjs';
import {encodeData, decodeData} from '../resumable-data.mjs';
import {verbSteps, fileSize} from './verb-steps-driver.mjs';
import {tools} from './resumable-tools.mjs';
import {sha256Start, sha256Update, sha256Finish} from '../sha256.mjs';
import {BUILD_VERSION} from '../build-version.mjs';
import {fail, declared, admitSignal, check, snapshotOptions, snapshotArray, callers, pixelLimit} from './primitives.mjs';
import {sourceColor} from './header-intent.mjs';
import {viewBytes} from './bytes.mjs';
import {storedIdentity} from './identity-record.mjs';
import {boundedVerification, BOUNDED_SETUP} from './verify-decode.mjs';
import {configuredDecoder, DECODER_SNAPSHOT} from '../shown-picture.mjs';
import {pixelResultInSteps, restoredInSteps, outputDigest, storedVerificationSteps} from './verify-steps.mjs';
import {journaled} from '../step-journal.mjs';
import {WORKER_ADMISSION} from './worker-admission-table.mjs';

const STEPS = Symbol.for('rapier-jxl.steps'), steppers = new WeakMap();
const STRAIGHT_MARGIN = 1.25;
const VERIFY_STEPS = Symbol.for('rapier-jxl.verify.steps');
const text = new TextEncoder();
const verifierOf = verify => typeof verify === 'function' && typeof verify[VERIFY_STEPS] === 'function' ? verify : null;
const NEEDS_VERIFY = "verify: pass verify from jpegxl/verify";
async function verifyResult(steps, result, plan, data, source, journal, host) {
  const verifier = verifierOf(host?.verify);
  if (!verifier) throw fail('JXL_OPTIONS', NEEDS_VERIFY);
  const file = result instanceof Uint8Array ? result : result.bytes, facts = result instanceof Uint8Array ? null : result.facts;
  const records = await steps.record(file, plan, source, facts);
  let sourceIdentity = await storedIdentity(source), checked = source;
  let original = source.kind === 'file' || source.width === undefined ? data
    : {data, width: source.width, height: source.height, ...sourceColor(source)};
  if (source.kind === 'decode') {
    const named = (Array.isArray(records) ? records[0] : records)?.source;
    if (named?.digest && named.digest !== sourceIdentity.digest) {
      const restore = (host && DECODER_SNAPSHOT in host ? host[DECODER_SNAPSHOT] : configuredDecoder())?.restore;
      if (!restore) throw fail('JXL_PLATFORM', "restore: configureDecoder(decode, restore)");
      const jpeg = await journaled(journal, 'verify-decode-original', async () => (await restore(data)).bytes);
      const digest = sha256Finish(sha256Update(sha256Start(), jpeg));
      if ('sha256:' + digest !== named.digest) throw fail('JXL_INPUT', "stored JPEG: original/result mismatch");
      original = jpeg; sourceIdentity = {kind: 'bytes', digest: named.digest};
      checked = {kind: 'file', generation: source.generation, sha256: digest, byteLength: jpeg.length};
    } else checked = {...source, kind: 'file'};
  }
  const checkRecord = record => journaled(journal, 'verify-output', async () => {
    const named = record.source ? record : {...record, source: sourceIdentity};
    return verifier[VERIFY_STEPS](original, named, {journal, source: checked, sourceIdentity,
      ...(host && DECODER_SNAPSHOT in host && {[DECODER_SNAPSHOT]: host[DECODER_SNAPSHOT]}),
      outputDigest: await outputDigest(record.bytes ?? new Uint8Array(0), journal),
      pixelResult: pixelResultInSteps, restored: restoredInSteps,
      maxPixels: plan.maxPixels ?? plan.options?.maxPixels, restoreSteps: steps.restore ?? (steps.id === 'jpeg:restore' ? steps : undefined)});
  });
  const verification = [];
  for (const record of Array.isArray(records) ? records : [records]) verification.push(await checkRecord(record));
  return {bytes: file, facts, verification: Array.isArray(records) ? verification : verification[0]};
}
const made = new WeakMap(), drivers = {verb: verbSteps, verify: (descriptor, operation) => storedVerificationSteps(operation[VERIFY_STEPS], operation)};
const stepsOfVerb = (descriptor, operation) => made.get(descriptor) ?? made.set(descriptor, drivers[descriptor.kind](descriptor, operation)).get(descriptor);
function stepsOf(operation) {
  if (typeof operation !== 'function') throw fail('JXL_OPTIONS', "operation: imported function");
  const given = typeof operation === 'function' ? operation[STEPS] : undefined, steps = Object.hasOwn(drivers, given?.kind ?? '') ? stepsOfVerb(given, operation) : given;
  if (!steps) throw fail('JXL_UNSUPPORTED', 'operation: resumable verb');
  let stepper = steppers.get(steps);
  if (!stepper) {
    const build = sha256Finish(sha256Update(sha256Start(), text.encode(BUILD_VERSION + '\0' + steps.id)));
    stepper = createJournalStepper({id: steps.id, build, normalize: steps.normalize, open: steps.open, run: steps.run,
      verify: (...args) => verifyResult(steps, ...args), eager: steps.eager, tools, straight: steps.straight});
    steppers.set(steps, stepper);
  }
  return {steps, stepper};
}
function storeOf(store) {
  const methods = snapshotOptions(store, 'store', ['readSource', 'read', 'readMany', 'write', 'writeMany']);
  if (typeof methods.readSource !== 'function' || typeof methods.read !== 'function' ||
      typeof methods.write !== 'function' && typeof methods.writeMany !== 'function' ||
      ['readMany', 'write', 'writeMany'].some(key => methods[key] !== undefined && typeof methods[key] !== 'function'))
    throw fail('JXL_OPTIONS', "store: readSource/read and write/writeMany functions");
  const call = async (name, ...args) => {
    try { return await Reflect.apply(methods[name], store, args); } catch (error) { throw callers(error); }
  };
  const unsaved = new Map();
  const read = async ref => unsaved.get(ref.hash) ?? await call('read', {hash: ref.hash, length: ref.length});
  const readMany = async refs => {
    const away = refs.filter(ref => !unsaved.has(ref.hash));
    const found = !away.length ? [] : methods.readMany ? await call('readMany', away.map(ref => ({hash: ref.hash, length: ref.length})))
      : await Promise.all(away.map(ref => call('read', {hash: ref.hash, length: ref.length})));
    if (!Array.isArray(found) || found.length !== away.length)
      throw fail('JXL_INPUT', "readMany: one part per reference");
    let i = 0;
    return refs.map(ref => unsaved.get(ref.hash) ?? found[i++]);
  };
  return {unsaved, read, readMany, readSource: (offset, length) => call('readSource', offset, length),
    write: (ref, bytes) => call('write', ref, bytes), ...(methods.writeMany && {writeMany: parts => call('writeMany', parts)})};
}
const hold = (io, parts) => { for (const {ref, bytes} of parts ?? []) io.unsaved.set(ref.hash, bytes); };
async function keep(io) {
  const parts = [...io.unsaved].map(([hash, bytes]) => ({ref: {hash, length: bytes.length}, bytes}));
  if (!parts.length) return;
  if (io.writeMany) await io.writeMany(parts);
  else for (const {ref, bytes} of parts) await io.write(ref, bytes);
  io.unsaved.clear();
}
const host = (checkpoint, input, io, extra) => ({source: input, expectedRevision: checkpoint?.revision, read: io.read, readMany: io.readMany, readSource: io.readSource, ...extra});

function takes(params, name, keys) {
  params = snapshotOptions(params, `${name} options`);
  if (keys) for (const key of Reflect.ownKeys(params)) if (!keys.includes(key)) throw fail('JXL_OPTIONS', `unknown option: ${name}.${String(key)}`);
  return params;
}
function plainOptions(value, depth = 0) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw fail('JXL_OPTIONS', 'resumable options: finite numbers');
    return value;
  }
  if (depth > 8 || typeof value !== 'object') throw fail('JXL_OPTIONS', 'resumable options: plain data');
  if (Array.isArray(value)) return snapshotArray(value, 'options', undefined, 'JXL_OPTIONS').map(item => plainOptions(item, depth + 1));
  let proto, descriptors;
  try { proto = Object.getPrototypeOf(value); descriptors = Object.getOwnPropertyDescriptors(value); }
  catch (error) { throw callers(error); }
  if (proto !== Object.prototype && proto !== null) throw fail('JXL_OPTIONS', 'resumable options: plain data');
  const out = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    const d = descriptors[key];
    if (!d.enumerable) continue;
    if (typeof key === 'symbol') throw fail('JXL_OPTIONS', `unknown option: ${String(key)}`);
    if (!('value' in d)) throw fail('JXL_OPTIONS', 'resumable options: plain data');
    out[key] = plainOptions(d.value, depth + 1);
  }
  return out;
}
export async function start(params) {
  const decoder = configuredDecoder();
  try {
    const {operation, input, options: rawOptions = {}, store, verify, memoryBytes} = takes(params, 'start', ['operation', 'input', 'options', 'store', 'verify', 'memoryBytes']);
    if (verify !== undefined && !verifierOf(verify)) throw fail('JXL_OPTIONS', "verify: pass verify from jpegxl/verify");
    const {steps, stepper} = stepsOf(operation), io = storeOf(store);
    if (steps.id === 'verify' && verify) throw fail('JXL_OPTIONS','verify: omit for verify operation');
    const options = steps.id === 'verify' ? rawOptions : plainOptions(rawOptions);
    if (verify && !boundedVerification({[DECODER_SNAPSHOT]: decoder})) throw fail('JXL_PLATFORM', BOUNDED_SETUP);
    const admit = memoryAdmission(steps, io, memoryBytes);
    const {checkpoint, parts} = await stepper.start({source: input, options, verify: !!verify, admit});
    if (checkpoint.source.kind === 'decode' && !decoder?.decode) throw fail('JXL_PLATFORM', "decoder: configureDecoder(decode) with decode from jpegxl/decode");
    const planOptions = checkpoint.plan.options ?? options, fidelity = planOptions.fidelity;
    const canReadJpegPixels = (typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function') ||
      typeof decoder?.recompress?.[Symbol.for('rapier-jxl.jpeg.pixels')] === 'function';
    if (checkpoint.source.kind === 'file' && /^(encode|fit|variants):/.test(steps.id) &&
        (fidelity !== 'exact' && fidelity?.quality !== 100 || planOptions.jpeg === 'pixels') && !canReadJpegPixels) {
      const head = await io.readSource(0, Math.min(2, checkpoint.source.byteLength));
      if (head?.[0] === 0xff && head[1] === 0xd8)
        throw fail('JXL_PLATFORM', "JPEG: use jpegxl/jpeg or RGBA8");
    }
    hold(io, parts); await keep(io);
    return checkpoint;
  } catch (error) { throw declared(error); }
}

export async function advance(checkpoint, params) {
  const decoder = configuredDecoder();
  try {
    const {operation, input, store, verify, budget = {ms: 30}, signal, memoryBytes} = takes(params, 'advance', ['operation', 'input', 'options', 'store', 'verify', 'budget', 'signal', 'memoryBytes']);
    checkpoint = decodeData(encodeData(checkpoint));
    admitSignal(signal);
    if (budget === null || typeof budget !== 'object' || Array.isArray(budget)) throw fail('JXL_OPTIONS', "budget.ms: 1-60000");
    const {ms, reads} = takes(budget, 'budget', ['ms', 'reads']);
    if (!Number.isFinite(ms) || ms <= 0 || ms > 60000) throw fail('JXL_OPTIONS', "budget.ms: 1-60000");
    if (reads !== undefined && (!Number.isSafeInteger(reads) || reads < 1 || reads > 1e6)) throw fail('JXL_OPTIONS', "budget.reads: positive integer");
    const {steps, stepper} = stepsOf(operation), io = storeOf(store), started = performance.now(), admit = memoryAdmission(steps, io, memoryBytes);
    check(signal);
    if (checkpoint?.plan?.verify && !verifierOf(verify)) throw fail('JXL_OPTIONS', NEEDS_VERIFY);
    const options = checkpoint?.plan?.options, source = checkpoint?.source, fits = (measured, budget) => !!measured && budget >= measured.ms * STRAIGHT_MARGIN;
    const smallest = admission(steps, options, 1, 1, true, source?.kind, memoryBytes);
    const straight = smallest.admitted && fits(smallest.measured, ms * 0.7) && ((head, budget) => {
      const size = source?.kind === 'file' || source?.kind === 'decode' ? headSize(head) : {width: source?.width, height: source?.height}, row = size && admission(steps, options, size.width, size.height, true, source?.kind, memoryBytes);
      return !!row?.admitted && fits(row.measured, budget);
    });
    const prepare = async (plan, source, readSource) => {
      await memoryAdmission(steps, {readSource}, memoryBytes)?.(plan, source);
      await steps.prepare?.(); check(signal);
    };
    const result = await stepper.advance(checkpoint, host(checkpoint, input, io, {signal, verify, admit, prepare, [DECODER_SNAPSHOT]: decoder, deadline: started + ms * 0.7, ...(straight && {straight}), ...(reads && {reads}), ...(memoryBytes !== undefined && {memoryBytes})}), {units: 64});
    hold(io, result.parts);
    await keep(io);
    return {checkpoint: result.checkpoint, done: result.done, released: result.released};
  } catch (error) { throw declared(error); }
}

export async function finish(checkpoint, params) {
  try {
    const {operation, input, store, signal, memoryBytes} = takes(params, 'finish', ['operation', 'input', 'options', 'store', 'verify', 'budget', 'signal', 'memoryBytes']);
    checkpoint = decodeData(encodeData(checkpoint));
    admitSignal(signal);
    check(signal);
    const {steps, stepper} = stepsOf(operation), io = storeOf(store), h = host(checkpoint, input, io, {signal, admit: memoryAdmission(steps, io, memoryBytes), ...(memoryBytes !== undefined && {memoryBytes})});
    const {byteLength, result} = await stepper.completion(checkpoint, h);
    if (memoryBytes !== undefined && byteLength + MEMORY_HOST_BYTES > memoryBytes)
      throw fail('JXL_MEMORY', `memoryBytes ${memoryBytes}: need ${byteLength} or store parts`);
    const bytes = await stepper.output(checkpoint, h, length => {
      if (length !== byteLength) throw fail('JXL_INPUT', "saved output: incomplete parts");
      try { return new Uint8Array(length); } catch { throw fail('JXL_MEMORY', "allocation: store output parts"); }
    });
    check(signal);
    const made = await steps.record(bytes, checkpoint.plan, checkpoint.source, result?.facts ?? null);
    const source = await storedIdentity(checkpoint.source), named = (record, index = 0) => {
      const value = record.source ? record : {...record, source};
      if (!checkpoint.plan.verify) return value;
      const verification = Array.isArray(made) ? result?.verification?.[index] : result?.verification;
      if (!verification?.verified || verification.source?.kind !== value.source?.kind || verification.source?.digest !== value.source?.digest ||
          verification.width !== value.width || verification.height !== value.height || verification.format !== value.format)
        throw fail('JXL_INPUT', "verification: missing result");
      return {...value, verification};
    };
    return Array.isArray(made) ? made.map(named) : named(made);
  } catch (error) { throw declared(error); }
}

export function workerAdmission(params) {
  try {
    const {operation, options: given = {}, width, height, kind} = takes(params, 'workerAdmission', ['operation', 'options', 'width', 'height', 'kind']);
    const {steps} = stepsOf(operation);
    const options = steps.id === 'verify' ? takes(given, 'workerAdmission.options', ['result', 'parts', 'maxPixels']) : plainOptions(given);
    if (kind !== undefined && kind !== 'pixels' && kind !== 'file' && kind !== 'decode') throw fail('JXL_OPTIONS', "source kind: pixels|file|decode");
    if (steps.id !== 'verify') steps.normalize?.(options, {kind: kind ?? 'pixels', width: 1, height: 1, byteLength: 4});
    else pixelLimit(options.maxPixels);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
      throw fail('JXL_OPTIONS', "dimensions: positive integer pixels");
    return admission(steps, options, width, height, false, kind);
  } catch (error) { throw declared(error); }
}
function admission(steps, options, width, height, straight = false, kind, memoryBytes) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return {admitted: false, measured: null};
  const fidelity = options?.fidelity, exact = fidelity === 'exact' || fidelity?.quality === 100;
  const upload = steps.id === 'encode:rapier-jxl/upload' || steps.id === 'fit:rapier-jxl/upload';
  const key = upload || steps.id === 'encode:rapier-jxl' || steps.id === 'fit:rapier-jxl' ? `${steps.id} ${exact ? 'exact' : 'lossy'}`
    : steps.id === 'verify' ? `verify ${options?.result?.kept === 'jpeg-bytes' ? 'jpeg' : 'pixels'}` : steps.id;
  const efforts = WORKER_ADMISSION[kind === 'decode' ? key + ' decode' : key], rows = efforts?.any ?? efforts?.[options?.effort ?? (upload ? 3 : 7)] ?? [], pixels = width * height;
  for (const row of rows) {
    const [at] = row, [estimate, recorded, ms] = straight ? row.slice(3) : row.slice(1);
    const admitted = memoryBytes === undefined ? recorded : estimate * 1.1 + MEMORY_HOST_BYTES <= memoryBytes;
    if (estimate === undefined) return {admitted: false, measured: null};
    if (!admitted || at >= pixels) return {admitted: !!admitted, measured: {pixels: at, estimate, ...(straight && {ms: ms ?? Infinity})}};
  }
  return {admitted: false, measured: null};
}
const MEMORY_HOST_BYTES = 32_000_000, MEMORY_HEAD_BYTES = 65536;
function memoryAdmission(steps, io, memoryBytes) {
  if (memoryBytes === undefined) return undefined;
  if (!Number.isSafeInteger(memoryBytes) || memoryBytes < 1) throw fail('JXL_OPTIONS', "memoryBytes: positive safe integer");
  return async (plan, source) => {
    let size = source.kind === 'file' || source.kind === 'decode' ? null : {width: source.width, height: source.height};
    let format;
    if (!size) {
      const length = Math.min(source.byteLength, MEMORY_HEAD_BYTES), head = viewBytes(await io.readSource(0, length));
      if (head.length !== length) throw fail('JXL_INPUT', "source header: incomplete");
      size = headSize(head);
      format = size?.jpeg420 ? 'jpeg420'
        : head.length >= 29 && head[0] === 0x89 && head[1] === 0x50 && head[24] === 8 ? 'png8' : undefined;
    }
    const shape = size ? `${size.width}x${size.height} (${size.width * size.height} pixels)` : 'a picture with dimensions beyond its first 65536 bytes';
    const measuredSource = !plan.verify && source.kind === 'file' &&
      (steps.id === 'jpeg:recompress' ? format === 'jpeg420' : /^(encode|fit):rapier-jxl(?:\/upload)?$/.test(steps.id) && format === 'png8');
    const row = measuredSource && size && admission(steps, plan.options ?? plan, size.width, size.height, false, source.kind, memoryBytes);
    if (!row?.admitted) throw fail('JXL_MEMORY', `${shape}: memoryBytes ${memoryBytes}; ` +
      (row?.measured ? `${row.measured.pixels} pixels: ${Math.ceil(row.measured.estimate * 1.1 + MEMORY_HOST_BYTES)} bytes needed` : 'no measured bound'));
  };
}
function headSize(b) {
  const u16 = i => b[i] << 8 | b[i + 1], u32 = i => (u16(i) * 65536 + u16(i + 2));
  if (b.length >= 24 && u32(0) === 0x89504e47 && u32(4) === 0x0d0a1a0a && u32(12) === 0x49484452) return {width: u32(16), height: u32(20)};
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let at = 2; at + 9 <= b.length;) {
      if (b[at] !== 0xff) return null;
      const m = b[at + 1];
      if (m === 0xff) { at++; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return {
        width: u16(at + 7), height: u16(at + 5),
        jpeg420: m === 0xc0 && at + 19 <= b.length && u16(at + 2) === 17 && b[at + 4] === 8 && b[at + 9] === 3 &&
          b[at + 11] === 0x22 && b[at + 14] === 0x11 && b[at + 17] === 0x11,
      };
      if (m === 0xd9 || m === 0xda) return null;
      at += 2 + u16(at + 2);
    }
    return null;
  }
  if (!(b[0] === 0xff && b[1] === 0x0a)) for (let at = 0; at + 8 <= b.length;) {
    let length = u32(at), body = at + 8;
    const type = u32(at + 4);
    if (length === 1) { if (at + 16 > b.length) return null; length = u32(at + 8) * 4294967296 + u32(at + 12); body += 8; }
    if (type === 0x6a786c63) return fileSize(b.subarray(body));
    if (type === 0x6a786c70) return fileSize(b.subarray(body + 4));
    if (!length || length < body - at) return null;
    at += length;
  }
  return fileSize(b);
}
