// SPDX-License-Identifier: MIT
import {requireDecode} from './decode-bits.mjs';
import {readDecodeFrameHeader, readDecodeTOC} from './decode-header.mjs';
import {decodeFrameSections, restoreFrame} from './decode-frame.mjs';
import {power2} from './decode-header.mjs';
import {frameFeatures} from './decode-parts.mjs';
import {transformColor} from './decode-color.mjs';
import {composeFrame} from './decode-compose.mjs';
import {plainFrame, cropFrame} from './decode-region.mjs';

const SCALE = 8;
const previewable = f => plainFrame(f, true) && f.x0 % SCALE === 0 && f.y0 % SCALE === 0 && f.blending[0].mode === 0;

export function cutPreview(r, h, options, arrived, renderLF) {
  requireDecode(!h.preview && !h.animation && !h.extraChannels.length, 'preview: unsupported layout', r);
  const small = {...h, width: Math.ceil(h.width / SCALE), height: Math.ceil(h.height / SCALE)}, references = new Array(4), headers = [];
  let lfFrame = null;
  let canvas = null, last = null;
  for (;;) {
    const read = arrived(r, () => { const f = readDecodeFrameHeader(r, h, options); return {f, readers: readDecodeTOC(r, f, true)}; });
    if (!read) break;
    const {f, readers} = read;
    headers.push(f);
    if (f.type === 1 && f.lfLevel === 1 && !f.cut) { lfFrame = renderLF(readers, f); last = f; continue; }
    requireDecode(previewable(f) && (!f.useLFFrame || f.lfLevel === 0 && lfFrame), 'preview: unsupported layout', r);
    let lf;
    if (f.useLFFrame) {
      const width = Math.ceil(f.width / SCALE), height = Math.ceil(f.height / SCALE);
      requireDecode(lfFrame.planes.length === 3 && lfFrame.width >= width && lfFrame.height >= height, 'JPEG XL LF reference is too small.', r);
      lf = cropFrame({...lfFrame, extraChannels: []}, {x: 0, y: 0, width, height});
    } else {
      if (readers.length === 1) { if (f.cut || f.isLast) break; continue; }
      if (readers.slice(0, 1 + f.numLFGroups).some(reader => !reader)) break;
      if (f.passes.count > 1 && f.isLast && headers.length === 1 && !f.useLFFrame && readers[1 + f.numLFGroups]) {
        let completedPasses = 0, arrivedGroups = 0;
        for (let p = 0; p < f.passes.count; p++) {
          let all = true;
          for (let g = 0; g < f.numGroups; g++) {
            if (readers[2 + f.numLFGroups + p * f.numGroups + g]) arrivedGroups++;
            else all = false;
          }
          if (all && completedPasses === p) completedPasses++;
        }
        let scale = SCALE;
        for (let p = 0; p < completedPasses; p++) {
          if (p === f.passes.count - 1) scale = 1;
          else {
            const idx = f.passes.lastPass.indexOf(p);
            if (idx >= 0) scale = Math.min(scale, f.passes.downsample[idx]);
          }
        }
        let full = restoreFrame(decodeFrameSections(readers, h, f, {
          readFeatures: frameFeatures, maxSamples: options.maxSamples, maxModularWork: options.maxModularWork, partial: true,
        }), f);
        const width = Math.ceil(f.width / power2(3 * f.lfLevel)), height = Math.ceil(f.height / power2(3 * f.lfLevel));
        full.width = width; full.height = height; full.widths = full.planes.map(() => width); full.heights = full.planes.map(() => height);
        full = transformColor(full, h, f, {colorSpace: 'original', inPlace: true});
        full = composeFrame(full, h, f, references, false);
        return {frame: full, small: h, f, headers, partialInfo: {scale, completedPasses, arrivedGroups, totalGroups: f.numGroups * f.passes.count}};
      }
      lf = decodeFrameSections(readers, h, f, {readFeatures: frameFeatures, maxSamples: options.maxSamples,
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
  requireDecode(canvas, 'truncated', r, true);
  return {frame: canvas, small, f: last, headers, partialInfo: {scale: SCALE}};
}
