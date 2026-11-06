// Lossy modular encoding. MIT (images/jxl/LICENSE).
import {BitWriter, complete} from './bits.mjs';
import {writeModularFrameHeader, assembleCodestream} from './frame.mjs';
import {writeImageHeader} from './icc-write.mjs';
import {inspectPixels, nativeSteps} from './lossless.mjs';
import {admitSampleFormat} from './admit-samples.mjs';
import {lossySections} from './lossy-sections.mjs';
export {lossySections, distanceFromQuality, quantiserFor} from './lossy-sections.mjs';

export function encodeLossy(rgba, width, height, options) { return complete(lossySteps(rgba, width, height, options)); }

export function* lossySteps(rgba, width, height, options = {}) {
  const samples = typeof options.colorSpace === 'object' ? {native8: true} : admitSampleFormat(rgba, options), quality = options.quality ?? 90;
  if (!samples.native8) return yield* nativeSteps(rgba, width, height, {quality, samples});
  const {shape = inspectPixels(rgba, width, height, {palette: false}), colorSpace} = options;
  const sections = yield* lossySections(rgba, width, height, quality, shape);
  const {colour, alpha} = shape, header = new BitWriter(256);
  writeImageHeader(header, width, height, colour, alpha, {colorSpace});
  writeModularFrameHeader(header, {alpha, shift: width > 256 || height > 256 ? 3 : 1});
  return assembleCodestream(header, sections);
}

