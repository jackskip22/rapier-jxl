import {fail} from './primitives.mjs';

const MEASURES = new Set(['ssimulacra2', 'butteraugli', 'butteraugli3']);

function soleKey(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  return keys.length === 1 ? keys[0] : null;
}

export function exactFidelity(value) {
  return value === 'exact' || (soleKey(value) === 'quality' && value.quality === 100);
}
export function measuredFidelity(value) {
  const key = soleKey(value);
  return MEASURES.has(key);
}

export function encodeFidelity(value = {quality: 90}) {
  if (value === 'exact') return {quality: 100};
  const key = soleKey(value);
  if (key === 'quality') {
    const {quality} = value;
    if (typeof quality !== 'number' || !Number.isFinite(quality) || quality < 1 || quality > 100)
      throw fail('JXL_OPTIONS', 'quality is a number from 1 to 100; 100 is exact.');
    return {quality};
  }
  if (MEASURES.has(key)) {
    const score = value[key];
    if (typeof score !== 'number' || !Number.isFinite(score)) throw fail('JXL_OPTIONS', `${key} is a finite number.`);
    return {quality: 90, target: {[key]: score}};
  }
  if (key === 'maxError') throw fail('JXL_OPTIONS', 'maxError is a capture fidelity: capture(screen, {fidelity: {maxError}}).');
  throw fail('JXL_OPTIONS', "fidelity is 'exact', {quality}, {ssimulacra2}, {butteraugli} or {butteraugli3}.");
}

export function captureFidelity(value = 'exact') {
  if (value === 'exact') return 0;
  if (soleKey(value) === 'maxError') {
    const {maxError} = value;
    if (!Number.isInteger(maxError) || maxError < 0 || maxError > 8) throw fail('JXL_OPTIONS', 'maxError is an integer from 0 to 8; 0 is exact.');
    return maxError;
  }
  throw fail('JXL_OPTIONS', "fidelity is 'exact' or {maxError: 0 to 8}.");
}
