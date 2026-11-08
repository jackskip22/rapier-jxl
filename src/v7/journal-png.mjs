// SPDX-License-Identifier: MIT
import {pngWalk, pngLayout, pngRows, unfilterRow, inflate} from '../source.mjs';
import {shapeScan, shapeScanPixels} from '../lossless.mjs';
import {flatSampleX, flatSampleY} from '../screen-samples.mjs';
import {rankingPositions} from '../capture-trees.mjs';
import {photoPreferenceDifference} from '../photo-preference.mjs';
import {fail, dimensions} from './primitives.mjs';

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
export async function journalPNG(file, readAs, maxPixels, journal) {
  const head = file.subarray(0, Math.min(file.length, 32));
  if (!journal.tools?.pngPixels || !PNG_SIGNATURE.every((byte, i) => head[i] === byte)) return null;
  if (head.length < 29 || head[12] !== 73 || head[13] !== 72 || head[14] !== 68 || head[15] !== 82) throw fail('JXL_INPUT', 'The PNG header is incomplete.');
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  dimensions(view.getUint32(16), view.getUint32(20), maxPixels);
  const deep = typeof createImageBitmap !== 'function' || head[25] === 4 || head[25] === 6;
  return journal.tools.pngPixels(journal, file, {readAs, deep, reader: {pngWalk, pngLayout, pngRows, unfilterRow, inflate, shapeScan, shapeScanPixels, flatSampleX, flatSampleY, rankingPositions, photoPreferenceDifference}});
}
