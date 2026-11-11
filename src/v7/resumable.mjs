// SPDX-License-Identifier: MIT
import {createJournalStepper} from '../resumable-journal.mjs';
import {encodeData, decodeData} from '../resumable-data.mjs';
import {verbSteps, fileSize} from './verb-steps-driver.mjs';
import {bandSummaryTool} from '../band-summary.mjs';
import {settleFacts} from './settle-facts.mjs';
import {pngPixels} from './png-bands.mjs';
import {prepareICC, varDCTFile, inspectICC} from '../resumable-icc.mjs';
import {jpegProgressive, jpegSummary} from '../resumable-jpeg-source.mjs';
import {containerBoxes, jpegContainer, containerRead, boundedHeader} from '../resumable-container.mjs';
import {jpegScanRows, jpegMarker, jpegScan, jpegEnd, jpegStructure, jpegSyntax, jpegPayload, jpegICC, jpegICCEntropy} from '../resumable-reconstruction.mjs';
import {metadataTools} from '../resumable-metadata.mjs';
const tools = Object.freeze({'band-summary': bandSummaryTool, settleFacts, pngPixels, prepareICC, varDCTFile, inspectICC,
  jpegProgressive, jpegSummary, containerBoxes, jpegContainer, containerRead, boundedHeader,
  jpegScanRows, jpegMarker, jpegScan, jpegEnd, jpegStructure, jpegSyntax, jpegPayload, jpegICC, jpegICCEntropy, ...metadataTools});
import {sha256Start, sha256Update, sha256Finish} from '../sha256.mjs';
import {BUILD_VERSION} from '../build-version.mjs';
import {fail, declared, admitSignal, check} from './primitives.mjs';
import {copyBytes} from './bytes.mjs';
import {storedIdentity} from './identity-record.mjs';
import {boundedVerification, BOUNDED_SETUP} from './verify-decode.mjs';
import {configuredDecoder} from '../shown-picture.mjs';
import {pixelResultInSteps, restoredInSteps, outputDigest, storedVerificationSteps} from './verify-steps.mjs';
import {journaled} from '../step-journal.mjs';
export {configureWasm} from '../wasm-modules.mjs';
import {WORKER_ADMISSION} from './worker-admission-table.mjs';

const STEPS = Symbol.for('rapier-jxl.steps'), steppers = new WeakMap();
const STRAIGHT_MARGIN = 1.25;
const VERIFY_STEPS = Symbol.for('rapier-jxl.verify.steps');
const text = new TextEncoder();
const verifierOf = verify => typeof verify === 'function' && typeof verify[VERIFY_STEPS] === 'function' ? verify : null;
const NEEDS_VERIFY = 'This job verifies: pass verify from rapier-jxl/verify with each call.';
async function verifyResult(steps, result, plan, data, source, journal, host) {
  const verifier = verifierOf(host?.verify);
  if (!verifier) throw fail('JXL_OPTIONS', NEEDS_VERIFY);
  const file = result instanceof Uint8Array ? result : result.bytes, facts = result instanceof Uint8Array ? null : result.facts;
  const records = await steps.record(file, plan, source, facts);
  let sourceIdentity = await storedIdentity(source), checked = source;
  let original = source.kind === 'file' || source.width === undefined ? data
    : {data, width: source.width, height: source.height, ...(source.colorSpace && {colorSpace: source.colorSpace})};
  if (source.kind === 'decode') {
    const named = (Array.isArray(records) ? records[0] : records)?.source;
    if (named?.digest && named.digest !== sourceIdentity.digest) {
      const restore = configuredDecoder()?.restore;
      if (!restore) throw fail('JXL_UNSUPPORTED', 'Verifying a decode job that names its JPEG needs configureDecoder(decode, restore).');
      const jpeg = await journaled(journal, 'verify-decode-original', async () => (await restore(data)).bytes);
      const digest = sha256Finish(sha256Update(sha256Start(), jpeg));
      if ('sha256:' + digest !== named.digest) throw fail('JXL_INPUT', 'The stored JPEG XL does not restore the JPEG its result names.');
      original = jpeg; sourceIdentity = {kind: 'bytes', digest: named.digest};
      checked = {kind: 'file', generation: source.generation, sha256: digest, byteLength: jpeg.length};
    } else checked = {...source, kind: 'file'};
  }
  const checkRecord = record => journaled(journal, 'verify-output', async () => {
    const named = record.source ? record : {...record, source: sourceIdentity};
    return verifier[VERIFY_STEPS](original, named, {journal, source: checked, sourceIdentity,
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
  const given = typeof operation === 'function' ? operation[STEPS] : undefined, steps = Object.hasOwn(drivers, given?.kind ?? '') ? stepsOfVerb(given, operation) : given;
  if (!steps) throw fail('JXL_UNSUPPORTED', 'This operation has no resumable steps; pass the verb itself, such as capture from rapier-jxl/capture.');
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

export async function start({operation, input, options = {}, store, verify} = {}) {
  try {
    if (verify !== undefined && !verifierOf(verify)) throw fail('JXL_OPTIONS', 'verify is rapier-jxl/verify\'s verify.');
    const {steps, stepper} = stepsOf(operation), io = storeOf(store);
    if (steps.id === 'verify' && verify) throw fail('JXL_OPTIONS','A verify operation already returns its verification receipt.');
    if (verify && !boundedVerification()) throw fail('JXL_UNSUPPORTED', BOUNDED_SETUP);
    const {checkpoint, parts} = await stepper.start({source: input, options, verify: !!verify});
    if (checkpoint.source.kind === 'decode' && !configuredDecoder()?.decode) throw fail('JXL_PLATFORM', 'A decode source needs configureDecoder(decode) from rapier-jxl/decode.');
    hold(io, parts); await keep(io);
    return checkpoint;
  } catch (error) { throw declared(error); }
}

export async function advance(checkpoint, {operation, input, store, verify, budget = {ms: 30}, signal} = {}) {
  try {
    checkpoint = decodeData(encodeData(checkpoint));
    admitSignal(signal);
    const ms = budget?.ms, reads = budget?.reads;
    if (!Number.isFinite(ms) || ms <= 0 || ms > 60000) throw fail('JXL_OPTIONS', 'budget is {ms} from 1 to 60000.');
    if (reads !== undefined && (!Number.isSafeInteger(reads) || reads < 1 || reads > 1e6)) throw fail('JXL_OPTIONS', 'budget.reads is a whole number from 1.');
    const {steps, stepper} = stepsOf(operation), io = storeOf(store), started = performance.now();
    await steps.prepare?.();
    check(signal);
    if (checkpoint?.plan?.verify && !verifierOf(verify)) throw fail('JXL_OPTIONS', NEEDS_VERIFY);
    const options = checkpoint?.plan?.options, source = checkpoint?.source, fits = (measured, budget) => !!measured && budget >= measured.ms * STRAIGHT_MARGIN;
    const smallest = admission(steps, options, 1, 1, true, source?.kind);
    const straight = smallest.admitted && fits(smallest.measured, ms * 0.7) && ((head, budget) => {
      const size = source?.kind === 'file' || source?.kind === 'decode' ? headSize(head) : {width: source?.width, height: source?.height}, row = size && admission(steps, options, size.width, size.height, true, source?.kind);
      return !!row?.admitted && fits(row.measured, budget);
    });
    const result = await stepper.advance(checkpoint, host(checkpoint, input, io, {signal, verify, deadline: started + ms * 0.7, ...(straight && {straight}), ...(reads && {reads})}), {units: 64});
    hold(io, result.parts);
    await keep(io);
    return {checkpoint: result.checkpoint, done: result.done, released: result.released};
  } catch (error) { throw declared(error); }
}

export async function finish(checkpoint, {operation, input, store, signal} = {}) {
  try {
    checkpoint = decodeData(encodeData(checkpoint));
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
    const source = await storedIdentity(checkpoint.source), named = (record, index = 0) => {
      const value = record.source ? record : {...record, source};
      if (!checkpoint.plan.verify) return value;
      const verification = Array.isArray(made) ? result?.verification?.[index] : result?.verification;
      if (!verification?.verified || verification.source?.kind !== value.source?.kind || verification.source?.digest !== value.source?.digest ||
          verification.width !== value.width || verification.height !== value.height || verification.format !== value.format)
        throw fail('JXL_INPUT', 'The completed verification does not describe its result.');
      return {...value, verification};
    };
    return Array.isArray(made) ? made.map(named) : named(made);
  } catch (error) { throw declared(error); }
}

export function workerAdmission({operation, options = {}, width, height, kind} = {}) {
  try {
    const {steps} = stepsOf(operation);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
      throw fail('JXL_OPTIONS', 'workerAdmission takes the picture\'s width and height in whole pixels.');
    return admission(steps, options, width, height, false, kind);
  } catch (error) { throw declared(error); }
}
function admission(steps, options, width, height, straight = false, kind) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return {admitted: false, measured: null};
  const fidelity = options?.fidelity, exact = fidelity === 'exact' || fidelity?.quality === 100;
  const key = steps.id === 'encode:rapier-jxl' || steps.id === 'fit:rapier-jxl' ? `${steps.id} ${exact ? 'exact' : 'lossy'}`
    : steps.id === 'verify' ? `verify ${options?.result?.kept === 'jpeg-bytes' ? 'jpeg' : 'pixels'}` : steps.id;
  const efforts = WORKER_ADMISSION[kind === 'decode' ? key + ' decode' : key], rows = efforts?.any ?? efforts?.[options?.effort ?? 7] ?? [], pixels = width * height;
  for (const row of rows) {
    const [at] = row, [estimate, admitted, ms] = straight ? row.slice(3) : row.slice(1);
    if (estimate === undefined) return {admitted: false, measured: null};
    if (!admitted || at >= pixels) return {admitted: !!admitted, measured: {pixels: at, estimate, ...(straight && {ms: ms ?? Infinity})}};
  }
  return {admitted: false, measured: null};
}
function headSize(b) {
  const u16 = i => b[i] << 8 | b[i + 1], u32 = i => (u16(i) * 65536 + u16(i + 2));
  if (b.length >= 24 && u32(0) === 0x89504e47 && u32(4) === 0x0d0a1a0a && u32(12) === 0x49484452) return {width: u32(16), height: u32(20)};
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let at = 2; at + 9 <= b.length;) {
      if (b[at] !== 0xff) return null;
      const m = b[at + 1];
      if (m === 0xff) { at++; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return {width: u16(at + 7), height: u16(at + 5)};
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
