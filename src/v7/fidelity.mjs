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

export const fidelityHint = value => ' Write fidelity: ' + (typeof value === 'number' && value > 0 && value < 1 ? `{webp: ${value}}.`
  : `{quality: ${typeof value === 'number' && value >= 1 && value <= 100 ? value : 90}}.`);

function qualityOf({quality}) {
  if (typeof quality !== 'number' || !Number.isFinite(quality) || quality < 1 || quality > 100)
    throw fail('JXL_OPTIONS', 'quality is a number from 1 to 100; 100 is exact.' + (quality > 0 && quality < 1 ? fidelityHint(quality) : ''));
  return quality;
}

function webpOf({webp}) {
  if (typeof webp !== 'number' || !Number.isFinite(webp) || webp < 0 || webp > 1) throw fail('JXL_OPTIONS', 'webp is a number from 0 to 1.');
  return webp;
}

export function encodeFidelity(value = {quality: 90}) {
  if (value === 'exact') return {quality: 100};
  const key = soleKey(value);
  if (key === 'quality') return {quality: qualityOf(value)};
  if (key === 'webp') {
    const webp = webpOf(value);
    return {quality: webp - 1 ? 90 : 100, webp};
  }
  if (MEASURES.has(key)) {
    const score = value[key];
    if (typeof score !== 'number' || !Number.isFinite(score)) throw fail('JXL_OPTIONS', `${key} is a finite number.`);
    return {quality: 90, target: {[key]: score}};
  }
  if (key === 'maxError') throw fail('JXL_OPTIONS', 'maxError is a capture setting: capture(screen, {fidelity: {maxError}}).');
  throw fail('JXL_OPTIONS', "fidelity is 'exact', {quality}, {webp}, {ssimulacra2}, {butteraugli} or {butteraugli3}." + (typeof value === 'number' ? fidelityHint(value) : value === 'lossless' ? " Write fidelity: 'exact'." : ''));
}

export function captureFidelity(value = 'exact') {
  if (value === 'exact') return 0;
  const key = soleKey(value);
  if (key === 'quality' || key === 'webp') throw fail('JXL_UNSUPPORTED', 'Photo quality is offered by rapier-jxl/capture-complete.');
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
    const quality = qualityOf(value);
    return quality === 100 ? {maxError: 0} : {quality};
  }
  if (key === 'webp') {
    const webp = webpOf(value);
    return webp === 1 ? {maxError: 0} : {webp};
  }
  throw fail('JXL_OPTIONS', "fidelity is 'exact', {maxError: 0 to 8}, {quality: 1 to 100} or {webp: 0 to 1}." + (typeof value === 'number' ? fidelityHint(value) : ''));
}
