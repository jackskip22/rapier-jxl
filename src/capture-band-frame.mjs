// SPDX-License-Identifier: MIT
import {BitWriter} from './bits.mjs';
import {groupLayout, writeHeaderFields as generalHeader, writeModularFrameHeader as generalFrame, assembleCodestream as generalAssembly} from './frame.mjs';
import {leaf, writeTree, writeModularHeader as generalModular} from './modular.mjs';
import {buildCode, writeHistograms} from './prefix.mjs';
import {SCREEN_INTEGER_CONFIGS} from './screen-codes.mjs';
import {writeCaptureHeaderFields, writeCaptureFrameHeader, writeCaptureModularHeader, assembleCaptureCodestream} from './capture-headers.mjs';

const writeHeaderFields = (typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) ? writeCaptureHeaderFields : generalHeader;
const writeModularFrameHeader = (typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) ? writeCaptureFrameHeader : (w, o) => generalFrame(w, {...o, shift: 3});
const writeModularHeader = (typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) ? writeCaptureModularHeader : generalModular;
const assembleCodestream = (typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) ? assembleCaptureCodestream : generalAssembly;
import {captureGroupBytes, CAPTURE_TOOLS_LEAN} from './capture-codec.mjs';
import {fault} from './fault.mjs';

const FRAME_GROUP = 1024;
export const frameBandRows = (width, pixels) => Math.max(FRAME_GROUP, Math.floor(pixels / width / FRAME_GROUP) * FRAME_GROUP);

function bandGroupRects(width, rows) {
  const rects = [];
  for (let y = 0; y < rows; y += FRAME_GROUP) for (let x = 0; x < width; x += FRAME_GROUP)
    rects.push({x, y, width: Math.min(FRAME_GROUP, width - x), height: Math.min(FRAME_GROUP, rows - y)});
  return rects;
}

export function* bandGroupSteps(data, width, rows, level, shape, tools = CAPTURE_TOOLS_LEAN, helpers = false) {
  const rects = bandGroupRects(width, rows), whole = {...shape, channels: shape.colour + (shape.alpha ? 1 : 0)};
  const given = helpers ? yield {groups: {pixels: data, stride: width, rects, level, shape: whole}} : null;
  const written = Array.isArray(given) && given.length === rects.length && given.every(bytes => bytes instanceof Uint8Array) ? given : [];
  const groups = [];
  for (let i = 0; i < rects.length; i++) {
    groups.push(written[i] ?? captureGroupBytes(data, width, rects[i], level, whole, tools));
    yield (i + 1) / rects.length;
  }
  return groups;
}

export function bandFrameFile(width, height, shape, colorSpace, groups) {
  const layout = groupLayout(width, height, FRAME_GROUP);
  if (groups.length !== layout.groupsX * layout.groupsY || layout.single) throw fault('JXL_INTERNAL', 'capture-band-frame:groups');
  const header = new BitWriter(128);
  writeHeaderFields(header, width, height, shape.colour, shape.alpha, {colorSpace});
  writeModularFrameHeader(header, {alpha: shape.alpha});
  const global = new BitWriter(64);
  global.write(1, 1); global.write(1, 1);
  writeHistograms(global, {contextMap: new Uint8Array(writeTree(global, leaf(0)).length),
    histograms: [{config: SCREEN_INTEGER_CONFIGS[0], code: buildCode(new Uint32Array(1))}]});
  writeModularHeader(global);
  const empty = Array.from({length: layout.dcGroupsX * layout.dcGroupsY + 1}, () => new Uint8Array(0));
  return assembleCodestream(header, [global.finish(), ...empty, ...groups]);
}
