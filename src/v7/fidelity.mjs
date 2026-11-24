import {fail, snapshotOptions} from './primitives.mjs';
import {isPlainRecord} from './records.mjs';
import {photoTarget} from '../photo-target.mjs';

const MEASURES = /* @__PURE__ */ new Set(['ssimulacra2']);

function soleEntry(value) {
  if (!isPlainRecord(value)) return [null, null];
  const snap = snapshotOptions(value, 'fidelity', [], true);
  const keys = Object.keys(snap);
  return keys.length === 1 ? [keys[0], snap] : [null, null];
}

export function exactFidelity(value) {
  if (value === 'exact') return true;
  const [key, snap] = soleEntry(value);
  return key === 'quality' && snap.quality === 100;
}
export function measuredFidelity(value) {
  const [key] = soleEntry(value);
  return MEASURES.has(key);
}

function qualityOf({quality}) {
  if (typeof quality !== 'number' || !Number.isFinite(quality) || quality < 1 || quality > 100)
    throw fail('JXL_OPTIONS', 'quality: number 1-100');
  return quality;
}

const photoIntent = value => qualityOf(value) / 100;

export function encodeFidelity(value = {quality: 90}) {
  if (value === 'exact') return {quality: 100};
  const [key, snap] = soleEntry(value);
  if (key === 'quality') {
    const qualityIntent = photoIntent(snap);
    return qualityIntent === 1 ? {quality: 100} : {quality: 90, qualityIntent};
  }
  if (MEASURES.has(key)) {
    const score = snap[key];
    if (typeof score !== 'number' || !Number.isFinite(score)) throw fail('JXL_OPTIONS', `${key}: finite number`);
    return {quality: 90, target: photoTarget({[key]: score})};
  }
  throw fail('JXL_OPTIONS', "fidelity: 'exact', {quality} or {ssimulacra2}");
}

export function encodeEffort(effort, _fidelity, ten = false) {
  if (Number.isInteger(effort) && effort >= 1 && effort <= 9) return effort;
  const offersTen = ten && (typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true);
  if (effort === 10) {
    if (offersTen) return 10;
    throw fail('JXL_OPTIONS', "effort 10: import {encode} from 'jpegxl/max'");
  }
  throw fail('JXL_OPTIONS', offersTen ? 'effort: integer 1-10' : 'effort: integer 1-9');
}

export function progressiveSetting(progressive, fidelity) {
  if (progressive !== undefined && typeof progressive !== 'boolean') throw fail('JXL_OPTIONS', 'progressive: boolean');
  if (progressive === true && fidelity.quality === 100) throw fail('JXL_OPTIONS', 'progressive: not with exact');
}

export function captureFidelity(value = 'exact') {
  if (value === 'exact') return 0;
  const [key, snap] = soleEntry(value);
  if (key === 'quality') throw fail('JXL_UNSUPPORTED', 'quality: use jpegxl/capture-complete');
  if (key === 'maxError') {
    const {maxError} = snap;
    if (!Number.isInteger(maxError) || maxError < 0 || maxError > 8) throw fail('JXL_OPTIONS', 'maxError: integer 0-8');
    return maxError;
  }
  throw fail('JXL_OPTIONS', "fidelity: 'exact' or {maxError: 0-8}");
}

export function capturePhotoFidelity(value = 'exact') {
  if (value === 'exact') return {maxError: 0};
  const [key, snap] = soleEntry(value);
  if (key === 'maxError') return {maxError: captureFidelity(snap)};
  if (key === 'quality') {
    const qualityIntent = photoIntent(snap);
    return qualityIntent === 1 ? {maxError: 0} : {qualityIntent};
  }
  throw fail('JXL_OPTIONS', "fidelity: 'exact', {maxError: 0-8} or {quality: 1-100}");
}
