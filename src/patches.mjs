// SPDX-License-Identifier: MIT
import {BitWriter, complete, packSigned, scaled} from './bits.mjs';
import {admitOptions, admitPixels, admitSampleFormat, admitOutputSize, fault, job} from './admit.mjs';
import {admitEffort} from './effort-level.mjs';
import {inspectPixels} from './lossless.mjs';
import {writeImageHeader} from './frame.mjs';
import {buildCode, uintConfig, countToken, writeHistograms, writeHybrid} from './prefix.mjs';
import {screenPlan, screenFrameSteps} from './screen.mjs';
import {screenLZ77} from './screen-lz77.mjs';
import {writePatchFrameHeader} from './screen-patches.mjs';
import {fileHeader, boxHeader, CODESTREAM} from './container.mjs';

export const PATCH_BLEND_MODES = Object.freeze(['none', 'replace', 'add', 'multiply',
  'blend-above', 'blend-below', 'alpha-weighted-add-above', 'alpha-weighted-add-below']);

function patchMode(value = 'replace') {
  const mode = PATCH_BLEND_MODES.indexOf(value);
  if (mode < 0) throw fault('JXL_INPUT', 'Patch blend is one of PATCH_BLEND_MODES.');
  return mode;
}
function patchWhole(value, maximum, label, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw fault('JXL_INPUT', label + ' is a whole number from ' + minimum + ' to ' + maximum + '.');
  return value;
}
function patchClamp(value, mode, label) {
  if (value === undefined) return false;
  if (typeof value !== 'boolean' || value && mode < 3)
    throw fault('JXL_INPUT', label + ' is a boolean; clamping applies to multiply and alpha-aware blend modes.');
  return value;
}

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
  const supplied = options.patches, referenceLimit = Math.min(16777216, Math.floor(width * height / 16));
  if (!Array.isArray(supplied) || !supplied.length || supplied.length > referenceLimit)
    throw fault('JXL_INPUT', 'patches is a nonempty array with at most floor(image pixels / 16) source rectangles.');
  let placements = 0, area = 0, tokens = 1, forceAlpha = false;
  const groups = Array.from(supplied, group => {
    if (!group || typeof group !== 'object') throw fault('JXL_INPUT', 'Each patch supplies a source rectangle and positions.');
    const sx = patchWhole(group.sourceX, atlas.width - 1, 'sourceX'), sy = patchWhole(group.sourceY, atlas.height - 1, 'sourceY');
    const w = patchWhole(group.width, atlas.width - sx, 'patch width', 1), h = patchWhole(group.height, atlas.height - sy, 'patch height', 1);
    if (w > width || h > height) throw fault('JXL_INPUT', 'A patch rectangle fits inside the destination image.');
    if (!Array.isArray(group.positions) || !group.positions.length || group.positions.length > referenceLimit * 4 - placements)
      throw fault('JXL_INPUT', 'Patch positions are nonempty; their total is at most four times the reference-rectangle limit.');
    placements += group.positions.length; area += w * h * group.positions.length; tokens += 6;
    const positions = Array.from(group.positions, position => {
      if (!position || typeof position !== 'object') throw fault('JXL_INPUT', 'Each patch position supplies x and y.');
      const x = patchWhole(position.x, width - w, 'patch x'), y = patchWhole(position.y, height - h, 'patch y');
      const blend = patchMode(position.blend), declaredAlpha = patchMode(position.alphaBlend ?? position.blend);
      const clamp = patchClamp(position.clamp, blend, 'clamp'), declaredClamp = patchClamp(position.alphaClamp ?? (declaredAlpha >= 3 ? position.clamp : undefined), declaredAlpha, 'alphaClamp');
      const colorOver = blend === 4 || blend === 5, alphaBlend = colorOver ? blend : declaredAlpha, alphaClamp = colorOver ? clamp : declaredClamp;
      forceAlpha ||= blend >= 4 || position.alphaBlend !== undefined || position.alphaClamp !== undefined;
      return {x, y, blend, alphaBlend, clamp, alphaClamp};
    });
    return {sx, sy, w, h, positions};
  });
  const size = width * height;
  if (area > Math.max(1048576, 1024 * size)) throw fault('JXL_INPUT', 'Patch coverage exceeds the JPEG XL level-10 decoder area budget.');
  if (level === 5 && area > Math.max(1048576, 8 * size))
    throw fault('JXL_INPUT', 'These patches require explicit level: 10; Chrome 155 enforces the smaller level-5 patch area budget.');
  const baseShape = inspectPixels(data, width, height, {palette: false}), atlasShape = inspectPixels(atlas.data, atlas.width, atlas.height, {palette: false});
  const colour = Math.max(baseShape.colour, atlasShape.colour), alpha = baseShape.alpha || atlasShape.alpha || forceAlpha;
  const shape = {colour, alpha, channels: colour + Number(alpha)};
  for (const group of groups) for (const p of group.positions)
    tokens += 3 + Number(p.blend >= 3) + (alpha ? 1 + Number(p.alphaBlend >= 3) : 0);
  return {groups, tokens, shape, colorSpace, effort, orientation, level, baseError,
    atlas: {data: atlas.data, width: atlas.width, height: atlas.height}};
}

function* patchTokens(plan, emit) {
  let done = 0, previousYield = 0;
  const write = (ctx, value) => { emit(ctx, value); done++; };
  write(0, plan.groups.length);
  for (const group of plan.groups) {
    write(1, 1); write(3, group.sx); write(3, group.sy); write(2, group.w - 1); write(2, group.h - 1); write(7, group.positions.length - 1);
    let x = 0, y = 0;
    for (let i = 0; i < group.positions.length; i++) {
      const p = group.positions[i];
      write(i ? 6 : 4, i ? packSigned(p.x - x) : p.x); write(i ? 6 : 4, i ? packSigned(p.y - y) : p.y); x = p.x; y = p.y;
      write(5, p.blend); if (p.blend >= 3) write(9, Number(p.clamp));
      if (plan.shape.alpha) { write(5, p.alphaBlend); if (p.alphaBlend >= 3) write(9, Number(p.alphaClamp)); }
      if (done - previousYield >= 4096) { previousYield = done; yield done / plan.tokens; }
    }
  }
  yield 1;
}
function* authoredPatchEntropy(plan) {
  const config = uintConfig(4), freqs = Array.from({length: 10}, () => new Uint32Array(64)), writer = new BitWriter(256);
  for (const progress of patchTokens(plan, (ctx, value) => countToken(config, value, freqs[ctx]))) yield progress / 2;
  const histograms = freqs.map(freq => ({config, code: buildCode(freq)})), contextMap = Uint8Array.from({length: 10}, (_, i) => i);
  writeHistograms(writer, {contextMap, histograms});
  for (const progress of patchTokens(plan, (ctx, value) => writeHybrid(writer, histograms[ctx].code, config, value))) yield .5 + progress / 2;
  return writer;
}

function* authoredPatchFrame(data, width, height, options, {reference = false, dictionary = null} = {}) {
  const {shape, colorSpace, effort} = options, plans = new Map();
  const candidates = [['global', 0, 7], ['direct', -1, 7]];
  if (effort >= 2) candidates.push(['global', 1, 7], ['direct', 1, 7]);
  if (effort >= 3) candidates.push(['frequency', 1, 7], ['scalar', 1, 7]);
  if (effort >= 5) for (const name of ['global', 'frequency', 'scalar', 'direct']) candidates.push([name, 4, 7]);
  if (effort >= 7) for (const name of ['global', 'frequency', 'scalar', 'direct']) candidates.push([name, 4, 4]);
  if (effort >= 8) for (const name of ['global', 'frequency']) candidates.push([name, 16, 4]);
  if (effort >= 9) for (const name of ['global', 'frequency', 'direct']) candidates.push([name, 64, 4]);
  let best, failure, hurry = false;
  for (let i = 0; i < candidates.length; i++) {
    const [name, strategy, minLength] = candidates[i];
    if (best && (hurry || strategy < 0)) continue;
    if (!plans.has(name)) plans.set(name, screenPlan(data, width, height, shape, name));
    const plan = plans.get(name);
    if (!plan) continue;
    const search = strategy > 1 ? {dim: 1024, depth: strategy} : null;
    const steps = screenFrameSteps(data, width, height, shape, colorSpace, plan, {
      imageHeader: false, tokenCodec: strategy === 1 ? screenLZ77 : null, search, minLength,
      frameHeader: writer => writePatchFrameHeader(writer, shape.alpha, {reference, width, height, shift: search ? 3 : 1}),
      globalPrefix: dictionary ? writer => writer.append(dictionary) : null
    });
    try {
      let step, reply = false;
      while (!(step = steps.next(reply)).done) {
        const requested = yield scaled(step.value, fraction => (i + fraction) / candidates.length);
        hurry ||= !!requested;
        reply = !!best && hurry;
      }
      if (step.value && (!best || step.value.length < best.length)) best = step.value;
    } catch (error) {
      if (error.code !== 'JXL_SIZE' && (!(error instanceof RangeError) || error.code)) throw error;
      failure = error;
    }
  }
  if (!best) throw failure || fault('JXL_SIZE', 'No complete patch frame fits the output budget.');
  yield 1;
  return best;
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
