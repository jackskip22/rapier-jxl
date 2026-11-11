// SPDX-License-Identifier: MIT
import {fail} from './primitives.mjs';
import {isResultFidelity, isImageResult} from './result-shape.mjs';
import {imageResultRecord, targetMiss} from './result-record.mjs';
export {resultJSON, useJpegDisplay} from './result-record.mjs';
const METRICS = ['ssimulacra2', 'butteraugli', 'butteraugli3', 'max-error'];
function measurementsOf(given = []) {
  if (!Array.isArray(given)) throw fail('JXL_INTERNAL', 'Image result measurements are an array.');
  return given.map(measurement => {
    if (!measurement || !METRICS.includes(measurement.metric) || !Number.isFinite(measurement.score) ||
        !['encoder-reconstruction', 'decoded-output'].includes(measurement.domain))
      throw fail('JXL_INTERNAL', 'A measurement names its metric, finite score, and measurement domain.');
    const out = {metric: measurement.metric, score: measurement.score, domain: measurement.domain};
    for (const key of ['floor', 'limit']) if (measurement[key] !== undefined) {
      if (!Number.isFinite(measurement[key])) throw fail('JXL_INTERNAL', 'Measurement bounds are finite.');
      if ((key === 'floor') !== (measurement.metric === 'ssimulacra2'))
        throw fail('JXL_INTERNAL', 'SSIMULACRA2 uses a floor; error metrics use a limit.');
      out[key] = measurement[key];
    }
    if (measurement.region !== undefined) {
      const {x, y, width, height} = measurement.region;
      if (![x, y, width, height].every(Number.isSafeInteger) || x < 0 || y < 0 || width < 1 || height < 1)
        throw fail('JXL_INTERNAL', 'A measurement region is a positive pixel rectangle.');
      out.region = {x, y, width, height};
    }
    return out;
  });
}
function targetReason(fidelity, measurements, kept) {
  if (fidelity === 'exact' || kept === 'pixels' || kept === 'jpeg-bytes') return;
  for (const metric of ['ssimulacra2', 'butteraugli', 'butteraugli3']) {
    if (typeof fidelity?.[metric] !== 'number') continue;
    const measurement = measurements.find(item => item.metric === metric && item.region === undefined);
    if (!measurement) return {code: 'JXL_UNSUPPORTED', message: 'The selected output has no encoder measurement for the explicit ' + metric + ' target.'};
    const bound = fidelity[metric];
    if (metric === 'ssimulacra2') measurement.floor = bound; else measurement.limit = bound;
    if (metric === 'ssimulacra2' ? measurement.score < bound : measurement.score > bound)
      return targetMiss('The selected output did not meet the explicit ' + metric + ' target.');
  }
  const unmet = measurements.find(item => item.floor !== undefined && item.score < item.floor || item.limit !== undefined && item.score > item.limit);
  if (unmet) return targetMiss('The selected output did not reach the look of its quality.');
  if (typeof fidelity?.maxError === 'number') {
    const measurement = measurements.find(item => item.metric === 'max-error' && item.region === undefined);
    if (measurement) { measurement.limit = fidelity.maxError; if (measurement.score > fidelity.maxError) return targetMiss('The selected output did not meet the maximum-error target.'); }
  }
}


function describe(settings, fidelity, kept) {
  const measurements = measurementsOf(settings.measurements);
  return {measurements, reason: targetReason(fidelity, measurements, kept)};
}
function resultFidelity(requested = {quality: 90}, missed) {
  if (!isResultFidelity(requested, missed))
    throw fail('JXL_OPTIONS', 'Result fidelity must name one valid preservation or fidelity target; a quality range describes only a missed output.');
  return requested === 'exact' || requested?.maxError === 0 || requested?.quality === 100 ? 'exact' : requested;
}
export async function imageResult(bytes, reference, options) {
  const result = await imageResultRecord(bytes, reference, options, describe, resultFidelity);
  if (result.bytes && !isImageResult(result)) throw fail('JXL_INTERNAL', 'An image job produced a result that contradicts itself.');
  return result;
}
export function missedResult(reference, options = {}) { return imageResult(null, reference, options); }
