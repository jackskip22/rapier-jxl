import {fail} from './primitives.mjs';
import {photoTarget} from '../photo-target.mjs';

const MEASURES = /* @__PURE__ */ new Set(['ssimulacra2']);

function soleKey(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  return keys.length === 1 ? keys[0] : null;
}

export function exactFidelity(value) {
  const key = soleKey(value);
  return value === 'exact' || key === 'quality' && value.quality === 100;
}
export function measuredFidelity(value) {
  const key = soleKey(value);
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
  const key = soleKey(value);
  if (key === 'quality') {
    const qualityIntent = photoIntent(value);
    return qualityIntent === 1 ? {quality: 100} : {quality: 90, qualityIntent};
  }
  if (MEASURES.has(key)) {
    const score = value[key];
    if (typeof score !== 'number' || !Number.isFinite(score)) throw fail('JXL_OPTIONS', `${key}: finite number`);
    return {quality: 90, target: photoTarget({[key]: score})};
  }
  throw fail('JXL_OPTIONS', "fidelity: 'exact', {quality} or {ssimulacra2}");
}

export function captureFidelity(value = 'exact') {
  if (value === 'exact') return 0;
  const key = soleKey(value);
  if (key === 'quality') throw fail('JXL_UNSUPPORTED', 'quality: use jpegxl/capture-complete');
  if (key === 'maxError') {
    const {maxError} = value;
    if (!Number.isInteger(maxError) || maxError < 0 || maxError > 8) throw fail('JXL_OPTIONS', 'maxError: integer 0-8');
    return maxError;
  }
  throw fail('JXL_OPTIONS', "fidelity: 'exact' or {maxError: 0-8}");
}

export function capturePhotoFidelity(value = 'exact') {
  const key = soleKey(value);
  if (value === 'exact' || key === 'maxError') return {maxError: captureFidelity(value)};
  if (key === 'quality') {
    const qualityIntent = photoIntent(value);
    return qualityIntent === 1 ? {maxError: 0} : {qualityIntent};
  }
  throw fail('JXL_OPTIONS', "fidelity: 'exact', {maxError: 0-8} or {quality: 1-100}");
}
