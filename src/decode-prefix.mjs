// SPDX-License-Identifier: MIT
import {requireDecode} from './decode-bits.mjs';
import {readDecodeFrameHeader, readDecodeTOC} from './decode-header.mjs';
import {decodeFrameSections} from './decode-frame.mjs';
import {frameFeatures} from './decode-parts.mjs';
import {transformColor} from './decode-color.mjs';
import {composeFrame} from './decode-compose.mjs';
import {plainFrame, cropFrame} from './decode-region.mjs';

const SCALE = 8;
const previewable = f => plainFrame(f, true) && f.x0 % SCALE === 0 && f.y0 % SCALE === 0 && f.blending[0].mode === 0;

export function cutPreview(r, h, options, arrived, renderLF) {
  requireDecode(!h.preview && !h.animation && !h.extraChannels.length, 'Truncated JPEG XL data.', r);
  const small = {...h, width: Math.ceil(h.width / SCALE), height: Math.ceil(h.height / SCALE)}, references = new Array(4), headers = [];
  let lfFrame = null;
  let canvas = null, last = null;
  for (;;) {
    const read = arrived(r, () => { const f = readDecodeFrameHeader(r, h, options); return {f, readers: readDecodeTOC(r, f, true)}; });
    if (!read) break;
    const {f, readers} = read;
    headers.push(f);
    if (f.type === 1 && f.lfLevel === 1 && !f.cut) { lfFrame = renderLF(readers, f); last = f; continue; }
    requireDecode(previewable(f) && (!f.useLFFrame || f.lfLevel === 0 && lfFrame), 'Truncated JPEG XL data.', r);
    let lf;
    if (f.useLFFrame) {
      const width = Math.ceil(f.width / SCALE), height = Math.ceil(f.height / SCALE);
      requireDecode(lfFrame.planes.length === 3 && lfFrame.width >= width && lfFrame.height >= height, 'JPEG XL LF reference is too small.', r);
      lf = cropFrame({...lfFrame, extraChannels: []}, {x: 0, y: 0, width, height});
    } else {
      if (readers.length === 1) { if (f.cut || f.isLast) break; continue; }
      if (readers.slice(0, 1 + f.numLFGroups).some(reader => !reader)) break;
      lf = decodeFrameSections(readers, h, f, {readFeatures: (r, h, f) => frameFeatures(r, h, f, options), maxSamples: options.maxSamples,
        maxModularWork: options.maxModularWork, lfOnly: true});
    }
    const {width, height} = lf;
    let frame = {planes: lf.planes, width, height, widths: [width, width, width], heights: [height, height, height], extraChannels: [], features: {}, filtersApplied: true};
    frame = transformColor(frame, small, f, {colorSpace: 'original', inPlace: true});
    canvas = composeFrame(frame, small, {...f, x0: f.x0 / SCALE, y0: f.y0 / SCALE, width, height}, references, false);
    last = f;
    if (!f.isLast && (f.duration === 0 || f.saveAsReference !== 0)) references[f.saveAsReference] = {...canvas, saveBeforeColorTransform: false};
    if (f.cut || f.isLast) break;
  }
  if (!canvas && lfFrame && lfFrame.width === small.width && lfFrame.height === small.height && lfFrame.planes.length === 3) {
    const {width, height} = small;
    canvas = transformColor({planes: lfFrame.planes, width, height, widths: [width, width, width], heights: [height, height, height], extraChannels: [], features: {}, filtersApplied: true},
      small, last, {colorSpace: 'original', inPlace: true});
  }
  requireDecode(canvas, 'Truncated JPEG XL data.', r);
  return {frame: canvas, small, f: last, headers};
}
