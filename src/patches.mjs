// SPDX-License-Identifier: MIT
import {BitWriter, complete, scaled} from './bits.mjs';
import {admitOptions, admitPixels, admitSampleFormat, admitOutputSize, fault, job} from './admit.mjs';
import {admitEffort} from './effort-level.mjs';
import {inspectPixels} from './lossless.mjs';
import {writeImageHeader} from './frame.mjs';
import {authoredPatchEntropy, authoredPatchFrame} from './patch-code.mjs';
import {fileHeader, boxHeader, CODESTREAM} from './container.mjs';

import {PATCH_BLEND_MODES, patchMode, patchWhole, patchClamp, patchGeometry, patchCoverage, patchTokenCount} from './patch-input.mjs';
import {encodePatchComposition, encodePatchCompositionSteps} from './patch-composition.mjs';
export {PATCH_BLEND_MODES, encodePatchComposition, encodePatchCompositionSteps};

function admitPatches(data, width, height, options = {}) {
  const {quality, colorSpace} = admitOptions(options), effort = admitEffort(options);
  admitPixels(data, width, height);
  if (quality !== 100 || !admitSampleFormat(data, options).native8)
    throw fault('JXL_INPUT', 'Authored patches use straight RGBA8 with sRGB transfer and sRGB or Display P3 primaries; baseError explicitly controls base-image quantization.');
  const atlas = options.atlas;
  if (!atlas || typeof atlas !== 'object') throw fault('JXL_INPUT', 'atlas supplies data, width and height for the reference image.');
  admitPixels(atlas.data, atlas.width, atlas.height);
  if (!(atlas.data instanceof Uint8Array) && !(atlas.data instanceof Uint8ClampedArray))
    throw fault('JXL_INPUT', 'The reference atlas uses the same RGBA8 samples and color encoding as the base image.');
  const baseError = patchWhole(options.baseError ?? 0, 127, 'baseError');
  const orientation = patchWhole(options.orientation ?? 1, 8, 'orientation', 1), level = options.level ?? 5;
  if (level !== 5 && level !== 10) throw fault('JXL_INPUT', 'JPEG XL level is 5 or 10.');
  const referenceLimit = Math.min(16777216, Math.floor(width * height / 16));
  let forceAlpha = false;
  const {groups, area} = patchGeometry(options.patches, width, height, new Map([[1, atlas]]), position => {
    const blend = patchMode(position.blend), declaredAlpha = patchMode(position.alphaBlend ?? position.blend);
    const clamp = patchClamp(position.clamp, blend, 'clamp'), declaredClamp = patchClamp(position.alphaClamp ?? (declaredAlpha >= 3 ? position.clamp : undefined), declaredAlpha, 'alphaClamp');
    const colorOver = blend === 4 || blend === 5, alphaBlend = colorOver ? blend : declaredAlpha, alphaClamp = colorOver ? clamp : declaredClamp;
    forceAlpha ||= blend >= 4 || position.alphaBlend !== undefined || position.alphaClamp !== undefined;
    return {blending: [{mode: blend, alpha: 0, clamp}, {mode: alphaBlend, alpha: 0, clamp: alphaClamp}]};
  }, referenceLimit, 1);
  patchCoverage(area, width * height, level);
  const baseShape = inspectPixels(data, width, height, {palette: false}), atlasShape = inspectPixels(atlas.data, atlas.width, atlas.height, {palette: false});
  const colour = Math.max(baseShape.colour, atlasShape.colour), alpha = baseShape.alpha || atlasShape.alpha || forceAlpha;
  const shape = {colour, alpha, channels: colour + Number(alpha)};
  if (!alpha) for (const group of groups) for (const p of group.positions) p.blending.length = 1;
  return {groups, tokens: patchTokenCount(groups, Number(alpha)), extraChannels: Number(alpha), shape, colorSpace, effort, orientation, level, baseError,
    atlas: {data: atlas.data, width: atlas.width, height: atlas.height}};
}

function* authoredPatchProgress(steps, start, span) {
  let step, reply;
  while (!(step = steps.next(reply)).done) reply = yield scaled(step.value, fraction => start + span * fraction);
  return step.value;
}
function* authoredPatchEncode(data, width, height, options) {
  let body = data;
  if (options.baseError) {
    body = new Uint8Array(data); const step = 2 * options.baseError + 1;
    for (let i = 0; i < body.length; i += 4) {
      if (body[i + 3]) for (let c = 0; c < 3; c++) body[i + c] = Math.min(255, Math.floor((body[i + c] + options.baseError) / step) * step);
      if (i % 65536 === 0) yield .05 * (i + 4) / body.length;
    }
  }
  const dictionary = yield* authoredPatchProgress(authoredPatchEntropy(options), .05, .05);
  const atlas = yield* authoredPatchProgress(authoredPatchFrame(options.atlas.data, options.atlas.width, options.atlas.height, options, {reference: true}), .1, .3);
  const frame = yield* authoredPatchProgress(authoredPatchFrame(body, width, height, options, {dictionary}), .4, .6);
  const header = new BitWriter(128);
  writeImageHeader(header, width, height, options.shape.colour, options.shape.alpha, {colorSpace: options.colorSpace, orientation: options.orientation});
  const head = header.finish(), length = head.length + atlas.length + frame.length;
  const prefix = options.level === 10 ? [fileHeader(10), boxHeader(CODESTREAM, length)] : [];
  admitOutputSize(length + (prefix.length ? prefix[0].length + prefix[1].length : 0));
  const out = new Uint8Array(length + (prefix.length ? prefix[0].length + prefix[1].length : 0));
  let at = 0;
  for (const part of [...prefix, head, atlas, frame]) { out.set(part, at); at += part.length; }
  return out;
}

export function encodePatches(data, width, height, options) {
  return complete(encodePatchesSteps(data, width, height, options));
}
export function encodePatchesSteps(data, width, height, options) {
  return job(authoredPatchEncode(data, width, height, admitPatches(data, width, height, options)));
}
