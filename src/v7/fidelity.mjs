import {fail} from './primitives.mjs';

const MEASURES = new Set(['ssimulacra2', 'butteraugli', 'butteraugli3']);

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

const hundredfold = value => Math.round(value * 1e8) / 1e6;
export const fidelityHint = value => ' Write fidelity: ' + `{quality: ${typeof value === 'number' && value > 0 && value < 1 ? Math.max(1, hundredfold(value))
  : typeof value === 'number' && value >= 1 && value <= 100 ? value : 90}}.`;

function retiredWebp(value) {
  const webp = value.webp, number = typeof webp === 'number' && Number.isFinite(webp) && webp >= 0 && webp <= 1;
  return fail('JXL_OPTIONS', 'webp is not a fidelity. Write fidelity: ' + (number ? webp === 1 ? "'exact'." : `{quality: ${Math.max(1, hundredfold(webp))}}.` : '{quality: 1 to 100}.'));
}

function qualityOf({quality}) {
  if (typeof quality !== 'number' || !Number.isFinite(quality) || quality < 1 || quality > 100)
    throw fail('JXL_OPTIONS', 'quality is a number from 1 to 100; 100 is exact.' + (quality > 0 && quality < 1 ? fidelityHint(quality) : ''));
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
    if (typeof score !== 'number' || !Number.isFinite(score)) throw fail('JXL_OPTIONS', `${key} is a finite number.`);
    return {quality: 90, target: {[key]: score}};
  }
  if (key === 'maxError') throw fail('JXL_OPTIONS', 'maxError is a capture setting: capture(screen, {fidelity: {maxError}}).');
  if (key === 'webp') throw retiredWebp(value);
  throw fail('JXL_OPTIONS', "fidelity is 'exact', {quality}, {ssimulacra2}, {butteraugli} or {butteraugli3}." + (typeof value === 'number' ? fidelityHint(value) : value === 'lossless' ? " Write fidelity: 'exact'." : ''));
}

export function captureFidelity(value = 'exact') {
  if (value === 'exact') return 0;
  const key = soleKey(value);
  if (key === 'webp') throw retiredWebp(value);
  if (key === 'quality') throw fail('JXL_UNSUPPORTED', 'Photo quality is offered by rapier-jxl/capture-complete.');
  if (key === 'maxError') {
    const {maxError} = value;
    if (!Number.isInteger(maxError) || maxError < 0 || maxError > 8) throw fail('JXL_OPTIONS', 'maxError is an integer from 0 to 8; 0 is exact.');
    return maxError;
  }
  throw fail('JXL_OPTIONS', "fidelity is 'exact' or {maxError: 0 to 8}.");
}

export function capturePhotoFidelity(value = 'exact') {
  const key = soleKey(value);
  if (value === 'exact' || key === 'maxError') return {maxError: captureFidelity(value)};
  if (key === 'quality') {
    const qualityIntent = photoIntent(value);
    return qualityIntent === 1 ? {maxError: 0} : {qualityIntent};
  }
  if (key === 'webp') throw retiredWebp(value);
  throw fail('JXL_OPTIONS', "fidelity is 'exact', {maxError: 0 to 8} or {quality: 1 to 100}." + (typeof value === 'number' ? fidelityHint(value) : ''));
}
