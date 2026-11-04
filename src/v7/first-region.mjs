import {readFrames, copyBits} from '../framing.mjs';
import {writeTOCPermutation} from '../toc-permutation.mjs';
import {physicalOrder, offsets, regionOrder} from '../section-order.mjs';
import {fileHeader, boxHeader, CODESTREAM} from '../container.mjs';
import {BitWriter} from '../bits.mjs';
import {fail} from './primitives.mjs';
export {takeFirstRegion} from './first-region-option.mjs';

const TOC_ENTRY = [[10, 0], [14, 1024], [22, 17408], [30, 4211712]];
export function orderRegion(bytes, region) {
  if (!region) return bytes;
  let parsed;
  try { parsed = readFrames(bytes); } catch (cause) { throw Object.assign(fail('JXL_UNSUPPORTED', 'firstRegion does not take an ICC profile.'), {cause}); }
  const {codestream, level, image, frames} = parsed;
  if (region.x + region.width > image.width || region.y + region.height > image.height) throw fail('JXL_OPTIONS', 'firstRegion lies inside the picture.');
  const parts = [codestream.subarray(0, image.end)];
  for (const frame of frames) {
    if (frame.dcLevel || frame.sizes.length === 1) { parts.push(codestream.subarray(frame.start, frame.end)); continue; }
    const order = regionOrder(frame, region, 'region-first'), original = physicalOrder(frame), starts = offsets(frame);
    if (order.every((value, i) => value === original[i])) { parts.push(codestream.subarray(frame.start, frame.end)); continue; }
    const inverse = new Array(order.length);
    for (let physical = 0; physical < order.length; physical++) inverse[order[physical]] = physical;
    const writer = new BitWriter(64 + order.length * 4);
    copyBits(writer, codestream, frame.start * 8, frame.tocAt);
    writeTOCPermutation(writer, inverse); writer.zeroPadToByte();
    for (const logical of order) writer.writeU32(TOC_ENTRY, frame.sizes[logical]);
    writer.zeroPadToByte(); parts.push(writer.finish());
    for (const logical of order) parts.push(codestream.subarray(starts[logical], starts[logical] + frame.sizes[logical]));
  }
  if (level === 10) { const stream = join(parts); return join([fileHeader(10), boxHeader(CODESTREAM, stream.length), stream]); }
  return join(parts);
}
function join(parts) {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0; for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
