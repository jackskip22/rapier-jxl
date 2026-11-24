import {encodeLayersSteps} from '../layers-core.mjs';
import {readStill, compositionMetadataKey} from '../framing.mjs';
import {prepareICC} from '../icc-write.mjs';
import {exactAnswer} from '../effort-job.mjs';
import {check, fail} from './primitives.mjs';

import {WHOLE, BANDED_LIMITS, bandRows} from './band-size.mjs';
export {WHOLE};

const shapeOf = (bytes, frameRead) => {
  const {image, frames} = readStill(bytes, frameRead), one = frames.length === 1;
  return {xyb: image.xyb, alpha: image.alpha, gray: image.colorChannels === 1, one, text: !image.xyb && (!one || exactAnswer(bytes))};
};

export async function encodeBands({width, height, read}, encodeBand, recode, drain, hooks, run = fn => fn()) {
  const rows = bandRows(width), count = Math.ceil(height / rows), bands = [];
  if (count === 1) { const pixels = await read(0, height); check(hooks.signal); return run(() => encodeBand(pixels, hooks)); }
  const share = i => hooks.onProgress && (f => hooks.onProgress(Math.min(0.999, (i + f) / (count + 1))));
  let float = false, icc, frameRead;
  for (let i = 0, y = 0; y < height; i++, y += rows) {
    const h = Math.min(rows, height - y), pixels = await read(y, h);
    check(hooks.signal);
    float ||= pixels.data instanceof Float32Array || pixels.sampleFormat === 'float16';
    await run(async () => {
      const bytes = await encodeBand(pixels, {...hooks, preview: undefined, onProgress: share(i)});
      if (!i && pixels.icc !== undefined) {
        icc = pixels.icc; frameRead = {iccBits: prepareICC(icc).iccData.bitLength};
      }
      bands.push({y, h, bytes, shape: shapeOf(bytes, frameRead)});
    });
  }
  const target = {xyb: !bands.some(b => b.shape.text) && (float ? bands.every(b => b.shape.xyb) : bands.some(b => b.shape.xyb)),
    alpha: bands.some(b => b.shape.alpha), gray: bands.every(b => b.shape.gray)};
  for (const band of bands) {
    if (band.shape.one && band.shape.xyb === target.xyb && band.shape.alpha === target.alpha && band.shape.gray === target.gray) continue;
    const pixels = await read(band.y, band.h);
    check(hooks.signal);
    band.bytes = await run(() => drain(recode(pixels, {...target, exact: band.shape.text}), {...hooks, preview: undefined, onProgress: undefined}));
  }
  const key = bytes => compositionMetadataKey(readStill(bytes, frameRead)), apart = () => bands.some(band => key(band.bytes) !== key(bands[0].bytes));
  if (apart() && target.gray) for (const band of bands) {
    const pixels = await read(band.y, band.h);
    check(hooks.signal);
    band.bytes = await run(() => drain(recode(pixels, {...target, gray: false, exact: band.shape.text}), {...hooks, preview: undefined, onProgress: undefined}));
  }
  if (apart()) throw fail('JXL_INTERNAL', 'bands:result');
  const layers = bands.map(({bytes, y}) => ({bytes, y}));
  return run(() => drain(encodeLayersSteps({width, height, layers}, {icc}, null, BANDED_LIMITS), hooks));
}
