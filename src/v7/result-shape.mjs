// SPDX-License-Identifier: MIT
import {declared} from './primitives.mjs';
const digest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const reason = value => value && typeof value.code === 'string' && /^JXL_[A-Z_0-9]+$/.test(value.code) &&
  typeof value.message === 'string' && declared(value) === value;
const positive = value => Number.isSafeInteger(value) && value > 0;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const quality = value => finite(value) && value >= 1 && value <= 100;
export function isResultFidelity(value, missed = false) {
  if (value === 'exact') return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1) return false;
  const key = keys[0], amount = value[key];
  if (key === 'quality') {
    if (quality(amount)) return true;
    return !!(missed && amount && typeof amount === 'object' && !Array.isArray(amount) &&
      Object.keys(amount).length === 2 && Object.hasOwn(amount, 'min') && Object.hasOwn(amount, 'max') &&
      quality(amount.min) && quality(amount.max) && amount.min <= amount.max);
  }
  if (key === 'maxError') return finite(amount) && amount >= 0;
  if (key === 'ssimulacra2') return finite(amount) && amount <= 100;
  if (key === 'butteraugli' || key === 'butteraugli3') return finite(amount) && amount > 0;
  return false;
}
function measurement(value) {
  if (!value || !['ssimulacra2', 'butteraugli', 'butteraugli3', 'max-error'].includes(value.metric) ||
      !Number.isFinite(value.score) || !['encoder-reconstruction', 'decoded-output'].includes(value.domain)) return false;
  if (value.floor !== undefined && (!Number.isFinite(value.floor) || value.metric !== 'ssimulacra2') ||
      value.limit !== undefined && (!Number.isFinite(value.limit) || value.metric === 'ssimulacra2')) return false;
  const area = value.region;
  return area === undefined || area && Number.isSafeInteger(area.x) && area.x >= 0 && Number.isSafeInteger(area.y) && area.y >= 0 &&
    positive(area.width) && positive(area.height);
}
export function isImageResultShape(value) {
  if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.width) || value.width < 1 ||
      !Number.isSafeInteger(value.height) || value.height < 1 || !['jxl', 'jpeg', 'png'].includes(value.format) ||
      value.source !== null && (!['bytes', 'pixels'].includes(value.source?.kind) || !digest(value.source.digest)) || typeof value.fits !== 'boolean' ||
      !isResultFidelity(value.fidelity, value.bytes === null) ||
      !Array.isArray(value.measurements) || !value.measurements.every(measurement)) return false;
  if (value.transform !== undefined && (!positive(value.transform?.width) || !positive(value.transform?.height) ||
      value.transform.frame !== undefined && (!Number.isSafeInteger(value.transform.frame) || value.transform.frame < 0))) return false;
  if (value.readAs !== undefined && !['srgb', 'display-p3'].includes(value.readAs)) return false;
  if (value.bytes === null) return value.kept === null && value.fits === false &&
    reason(value.reason) && value.reason.code === 'JXL_TARGET';
  if (Object.prototype.toString.call(value.bytes) !== '[object Uint8Array]' || !value.bytes.byteLength ||
      !['jpeg-bytes', 'pixels', 'lossy'].includes(value.kept)) return false;
  if (!value.fits && !reason(value.reason) || value.fits && value.reason !== undefined) return false;
  return true;
}
export function isImageResult(value) {
  if (!isImageResultShape(value)) return false;
  if (value.fits) {
    const fidelity = value.fidelity;
    if ((fidelity === 'exact' || fidelity?.quality === 100 || fidelity?.maxError === 0) && value.kept === 'lossy') return false;
    for (const m of value.measurements)
      if (m.floor !== undefined && m.score < m.floor || m.limit !== undefined && m.score > m.limit) return false;
    if (value.kept === 'lossy' && fidelity && typeof fidelity === 'object') for (const metric of ['ssimulacra2', 'butteraugli', 'butteraugli3']) {
      if (typeof fidelity[metric] !== 'number') continue;
      const m = value.measurements.find(item => item.metric === metric && item.region === undefined);
      if (!m || (metric === 'ssimulacra2' ? m.score < fidelity[metric] : m.score > fidelity[metric])) return false;
    }
  }
  return true;
}
