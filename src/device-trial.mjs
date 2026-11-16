// SPDX-License-Identifier: MIT
import {traced, tracing} from './stage-trace.mjs';
const decided = new Map(), lost = new Set();
const LOSES = 2;
let trying = false, current = null, generation = 0, up = false, callGeneration = 0;
const sizeOf = pixels => pixels <= 1 << 19 ? 0 : pixels <= 1 << 21 ? 1 : pixels <= 1 << 23 ? 2 : 3;
const key = (kind, pixels) => kind + ' ' + sizeOf(pixels);
export function deviceTrials(on, of = 0) { trying = on === true; callGeneration = of; }
export function deviceFor(device) { if (device !== current) { current = device; generation++; decided.clear(); lost.clear(); up = false; } return generation; }
export function deviceLost(device) { if (device && device === current) { current = null; generation++; decided.clear(); lost.clear(); up = false; } }
export function deviceUp(device) { if (device === current) up = true; }
export const trialGeneration = () => callGeneration;
const ours = () => trying && callGeneration === generation;
export const trialDue = (kind, pixels) => ours() && up && !lost.has(sizeOf(pixels)) && !decided.has(key(kind, pixels));
export const leftDevice = (kind, pixels) => ours() && (!up || lost.has(sizeOf(pixels)) || decided.get(key(kind, pixels)) === false);
export const requestPixels = request => (request?.width ?? request?.image?.width ?? 0) * (request?.height ?? request?.image?.height ?? 0);
export function trialRecord(kind, pixels, device, cpu, from = callGeneration) {
  if (from !== generation) { if (tracing()) traced(`trial:${kind}:stale`, 0); return false; }
  const won = device < cpu;
  decided.set(key(kind, pixels), won);
  if (kind !== 'core' && device > LOSES * cpu) lost.add(sizeOf(pixels));
  if (tracing()) { traced(`trial:${kind}:device`, device); traced(`trial:${kind}:cpu`, cpu); traced(`trial:${kind}:${won ? 'keeps-device' : 'leaves-device'}`, 0); }
  return won;
}
export function* tryStage(kind, pixels, ask, cpu, slice = null) {
  const from = callGeneration, t0 = performance.now(), asked = yield {...ask, later: true};
  if (!asked) return yield* cpu();
  let answer = null, ok = false;
  yield {await: Promise.resolve(asked).then(value => { answer = value; ok = value != null; }, () => {})};
  if (!ok) return yield* cpu();
  const t1 = performance.now(), estimate = slice?.estimate() ?? null;
  if (estimate !== null) return trialRecord(kind, pixels, t1 - t0, estimate, from) ? yield* slice.keep(answer) : yield* cpu();
  const own = yield* cpu(), t2 = performance.now();
  trialRecord(kind, pixels, t1 - t0, t2 - t1, from);
  return own;
}
