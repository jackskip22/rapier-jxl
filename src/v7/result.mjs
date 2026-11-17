// SPDX-License-Identifier: MIT
import {fail} from './primitives.mjs';
import {isResultFidelity, isImageResult} from './result-shape.mjs';
import {imageResultRecord, targetMiss} from './result-record.mjs';
import {qualityTarget} from '../photo-quality-table.mjs';
export {resultJSON, useJpegDisplay} from './result-record.mjs';
const METRICS = ['ssimulacra2', 'max-error'];
function measurementsOf(given = []) {
  if (!Array.isArray(given)) throw fail('JXL_INTERNAL', "result:measurements-array");
  return given.map(measurement => {
    if (measurement?.domain === 'predicted') {
      if (measurement.metric !== 'ssimulacra2' || !Number.isFinite(measurement.floor) || measurement.score !== undefined || measurement.region !== undefined ||
          measurement.view !== undefined && measurement.view !== 'pu21' && measurement.view !== 'without-noise')
        throw fail('JXL_INTERNAL', "result:prediction");
      return {metric: 'ssimulacra2', domain: 'predicted', floor: measurement.floor, ...(measurement.view && {view: measurement.view})};
    }
    if (!measurement || !METRICS.includes(measurement.metric) || !Number.isFinite(measurement.score) ||
        !['encoder-reconstruction', 'decoded-output', 'predicted'].includes(measurement.domain))
      throw fail('JXL_INTERNAL', "result:measurement-entry");
    const out = {metric: measurement.metric, score: measurement.score, domain: measurement.domain};
    if (measurement.view !== undefined) { if (measurement.view !== 'pu21' && measurement.view !== 'without-noise') throw fail('JXL_INTERNAL', "result:measurement-view"); out.view = measurement.view; }
    for (const key of ['floor', 'limit']) if (measurement[key] !== undefined) {
      if (!Number.isFinite(measurement[key])) throw fail('JXL_INTERNAL', "result:measurement-value");
      if ((key === 'floor') !== (measurement.metric === 'ssimulacra2'))
        throw fail('JXL_INTERNAL', "result:measurement-bound");
      out[key] = measurement[key];
    }
    if (measurement.region !== undefined) {
      const {x, y, width, height} = measurement.region;
      if (![x, y, width, height].every(Number.isSafeInteger) || x < 0 || y < 0 || width < 1 || height < 1)
        throw fail('JXL_INTERNAL', "result:measurement-region");
      out.region = {x, y, width, height};
    }
    return out;
  });
}
function targetReason(fidelity, measurements, kept) {
  if (fidelity === 'exact' || kept === 'pixels' || kept === 'jpeg-bytes') return;
  for (const metric of ['ssimulacra2']) {
    if (typeof fidelity?.[metric] !== 'number') continue;
    const measurement = measurements.find(item => item.metric === metric && item.region === undefined);
    if (!measurement) return {code: 'JXL_UNSUPPORTED', message: 'measurement: missing ' + metric + ', use exact or quality'};
    const bound = fidelity[metric];
    if (metric === 'ssimulacra2') measurement.floor = bound; else measurement.limit = bound;
    if (metric === 'ssimulacra2' ? measurement.score < bound : measurement.score > bound)
      return targetMiss('target: missed ' + metric + ', lower target or raise effort');
  }
  const unmet = measurements.find(item => item.floor !== undefined && item.score < item.floor || item.limit !== undefined && item.score > item.limit);
  if (unmet) return targetMiss("quality: missed, lower or raise effort");
  if (typeof fidelity?.maxError === 'number') {
    const measurement = measurements.find(item => item.metric === 'max-error' && item.region === undefined);
    if (measurement) { measurement.limit = fidelity.maxError; if (measurement.score > fidelity.maxError) return targetMiss("maxError: exceeded, use exact"); }
  }
}


function describe(settings, fidelity, kept) {
  const measurements = measurementsOf(settings.measurements);
  if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && !measurements.length && kept === 'lossy' && typeof fidelity?.quality === 'number' && fidelity.quality < 100)
    measurements.push({metric: 'ssimulacra2', domain: 'predicted', floor: qualityTarget(fidelity.quality)});
  return {measurements, reason: targetReason(fidelity, measurements, kept)};
}
function resultFidelity(requested = {quality: 90}, missed) {
  if (!isResultFidelity(requested, missed))
    throw fail('JXL_OPTIONS', "result fidelity: single target, missed quality only");
  return requested === 'exact' || requested?.maxError === 0 || requested?.quality === 100 ? 'exact' : requested;
}
export async function imageResult(bytes, reference, options) {
  const result = await imageResultRecord(bytes, reference, options, describe, resultFidelity);
  if (result.bytes && !isImageResult(result)) throw fail('JXL_INTERNAL', "result:record");
  return result;
}
export function missedResult(reference, options = {}) { return imageResult(null, reference, options); }
