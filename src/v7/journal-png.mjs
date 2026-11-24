// SPDX-License-Identifier: MIT
import {pngLayout, pngRows, unfilterRow, pngRowKernels} from '../source.mjs';
import {pngWalk} from '../png-chunks.mjs';
import {shapeScan, shapeScanPixels} from '../lossless.mjs';
import {flatSampleX, flatSampleY} from '../screen-samples.mjs';
import {rankingPositions} from '../capture-trees.mjs';
import {photoPreferenceDifference} from '../photo-preference.mjs';
import {smoothProbes, smoothProbe} from '../smooth-sample.mjs';
import {grainSteps, grainRow, grainShares} from '../photo-v6-settings.mjs';
import {gradientRows} from './intent-quality.mjs';
import {fail, dimensions} from './primitives.mjs';

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
export async function journalPNG(file, readAs, maxPixels, journal) {
  const head = file.subarray(0, Math.min(file.length, 32));
  if (!journal.tools?.pngPixels || !PNG_SIGNATURE.every((byte, i) => head[i] === byte)) return null;
  if (head.length < 29 || head[12] !== 73 || head[13] !== 72 || head[14] !== 68 || head[15] !== 82) throw fail('JXL_INPUT', "PNG header: incomplete");
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  dimensions(view.getUint32(16), view.getUint32(20), maxPixels);
  const deep = typeof createImageBitmap !== 'function' || head[25] === 4 || head[25] === 6 || ownReadingChunk(file);
  await pngRowKernels();
  return journal.tools.pngPixels(journal, file, {readAs, deep, reader: {pngWalk, pngLayout, pngRows, unfilterRow, smoothProbes, smoothProbe, grainSteps, grainRow, grainShares, gradientRows, shapeScan, shapeScanPixels, flatSampleX, flatSampleY, rankingPositions, photoPreferenceDifference}});
}

const OWN_READING = new Set(['tRNS', 'gAMA', 'cHRM', 'iCCP', 'cICP']);
function ownReadingChunk(file) {
  for (let offset = 8, n = 0; n < 64; n++) {
    if (offset + 8 > file.length) return false;
    const head = file.subarray(offset, Math.min(file.length, offset + 9));
    if (head.length < 8) return false;
    const name = String.fromCharCode(head[4], head[5], head[6], head[7]);
    if (OWN_READING.has(name)) return true;
    if (name === 'sRGB' && (head.length < 9 || head[8] !== 1)) return true;
    if (name === 'IDAT' || name === 'IEND') return false;
    offset += 12 + (head[0] << 24 >>> 0) + (head[1] << 16) + (head[2] << 8) + head[3];
  }
  return true;
}
