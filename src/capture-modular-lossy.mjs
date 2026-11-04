// replaced or blended through the mask). MIT (images/jxl/LICENSE).
import {BitWriter, complete} from './bits.mjs';
import {writeFrameHeaderEnd, assembleCodestream} from './frame.mjs';
import {lossySections} from './lossy.mjs';

const regionQuality = quality => Math.min(99, quality < 90 ? quality + 0.25 * (90 - quality) : quality);

export const lossyModularSections = (rgba, width, height, quality, alpha) =>
  complete(lossySections(rgba, width, height, regionQuality(quality), {colour: 3, alpha, channels: alpha ? 4 : 3}));

export function lossyModularFrame(rgba, width, height, quality, placement, sections) {
  const {crop, imageWidth, imageHeight, isLastFrame: last, saveAsReference: reference, alphaChannel: alpha, mask = false} = placement;
  sections ??= lossyModularSections(rgba, width, height, quality, alpha);
  const header = new BitWriter(256);
  header.write(7, 0b0_00_1_00_0 | (last ? 0 : 6));
  header.writeU32([[0, 1], [0, 2], [0, 4], [0, 8]], 1);
  if (alpha) header.writeU32([[0, 1], [0, 2], [0, 4], [0, 8]], 1);
  header.write(2, width > 256 || height > 256 ? 3 : 1);
  writeFrameHeaderEnd(header, alpha ? 1 : 0, 0, null, 1, null, {crop, canvas: {width: imageWidth, height: imageHeight}, last, reference, mask});
  return assembleCodestream(header, sections);
}
