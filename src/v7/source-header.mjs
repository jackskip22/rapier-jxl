// SPDX-License-Identifier: MIT
import {fault} from '../fault.mjs';
import {exifOrientation} from '../exif-orientation.mjs';
import {pngWalk, pngColourStatement, inflate} from '../png-chunks.mjs';
import {lossyProfileEncoding} from './header-intent.mjs';
import {inspectICC} from '../icc-profile.mjs';
import {profileSpace} from '../jfif.mjs';
import {overLimit} from '../decode-header.mjs';

const refuse = (code, message) => { throw fault(code, message); };
const INTENTS = {perceptual: 0, relative: 1, saturation: 2, absolute: 3};
const PNG = [137, 80, 78, 71, 13, 10, 26, 10];

export const isSourceHeader = bytes => bytes.length >= 2 && bytes[0] === 255 && bytes[1] === 216 ||
  bytes.length >= 8 && PNG.every((value, i) => bytes[i] === value);

function stated(statement, space, bits = 8) {
  if (statement.icc) {
    const named = space === 'rgb' && bits === 8 && lossyProfileEncoding(statement.icc);
    if (!named) return {space, transferFunction: 'icc'};
    statement = {colorEncoding: named};
  }
  const e = statement.colorEncoding ?? {whitePoint: 'd65', primaries: statement.colorSpace, transferFunction: statement.transferFunction},
    outSpace = e.space ?? space;
  return {space: outSpace, whitePoint: e.whitePoint ?? 'd65', ...(outSpace === 'rgb' && {primaries: e.primaries ?? 'srgb'}),
    ...(e.gamma !== undefined ? {transferFunction: 'gamma', gamma: e.gamma} : {transferFunction: e.transferFunction ?? 'srgb'}),
    renderingIntent: typeof e.renderingIntent === 'number' ? e.renderingIntent : INTENTS[e.renderingIntent ?? 'relative']};
}
const fields = (width, height, orientation, colorEncoding, alpha = false, bits = 8) => ({width, height, orientation,
  intrinsicSize: null, preview: null, animation: null, bitDepth: {float: false, bits, exponentBits: 0},
  extraChannels: alpha ? [{type: 0, bitDepth: {bits, exponentBits: 0, float: false}, dimShift: 0, name: '', associated: false}] : [],
  colorEncoding, toneMapping: {intensityTarget: colorEncoding.transferFunction === 'pq' ? 10000 : colorEncoding.transferFunction === 'hlg' ? 1000 : 255,
    minNits: 0, relativeToMaxDisplay: false, linearBelow: 0}, reconstruction: false});

function jpegHeader(bytes, limits) {
  const maxMetadataBytes = limits?.maxMetadataBytes ?? Number.MAX_SAFE_INTEGER;
  const end = bytes.length, cut = () => refuse('JXL_INPUT', "jpeg header: incomplete before scan");
  let frame = null, orientation = null, adobe = null;
  const parts = [];
  let iccBytes = 0;
  for (let at = 2; ;) {
    if (at + 2 > end) cut();
    if (bytes[at] !== 255) refuse('JXL_INPUT', "jpeg marker");
    while (at + 1 < end && bytes[at + 1] === 255) at++;
    if (at + 2 > end) cut();
    const marker = bytes[at + 1];
    if (marker === 1) { at += 2; continue; }
    if (at + 4 > end) cut();
    if (!marker || marker === 216 || marker === 217 || marker >= 208 && marker <= 215) refuse('JXL_INPUT', "jpeg header");
    const size = bytes[at + 2] * 256 + bytes[at + 3], body = at + 4, next = at + 2 + size;
    if (size < 2) refuse('JXL_INPUT', "jpeg segment length");
    if (next > end) cut();
    if (marker === 218) {
      const count = bytes[body];
      if (!frame || !count || count > frame.components || size !== 6 + 2 * count)
        refuse('JXL_INPUT', "jpeg scan components");
      const ids = new Set();
      for (let p = body + 1; p < body + 1 + count * 2; p += 2) {
        if (!frame.ids.has(bytes[p]) || ids.has(bytes[p]) || (bytes[p + 1] >> 4) > 3 || (bytes[p + 1] & 15) > 3)
          refuse('JXL_INPUT', "jpeg scan components");
        ids.add(bytes[p]);
      }
      break;
    }
    if ([195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) refuse('JXL_UNSUPPORTED', "jpeg coding: host-decode to pixels");
    if ([192, 193, 194].includes(marker)) {
      if (size < 8 || frame) refuse('JXL_INPUT', "jpeg frame header");
      if (bytes[body] !== 8) refuse('JXL_UNSUPPORTED', 'jpeg depth: >8-bit; host-decode pixels');
      frame = {height: bytes[body + 1] * 256 + bytes[body + 2], width: bytes[body + 3] * 256 + bytes[body + 4], components: bytes[body + 5]};
      if (!frame.width || !frame.height || ![1, 3, 4].includes(frame.components) || size !== 8 + 3 * frame.components)
        refuse('JXL_INPUT', "jpeg frame components");
      frame.ids = new Set();
      for (let p = body + 6; p < next; p += 3) {
        const sampling = bytes[p + 1], h = sampling >> 4, v = sampling & 15;
        if (frame.ids.has(bytes[p]) || !h || h > 4 || !v || v > 4 || bytes[p + 2] > 3)
          refuse('JXL_INPUT', "jpeg frame components");
        frame.ids.add(bytes[p]);
      }
    } else if (marker === 225 && orientation === null && size >= 8 && [69, 120, 105, 102, 0, 0].every((value, i) => bytes[body + i] === value)) {
      orientation = exifOrientation(bytes, body + 6, next) ?? 1;
    } else if (marker === 238 && size >= 14 && [...'Adobe'].every((c, i) => bytes[body + i] === c.charCodeAt(0))) {
      const transform = bytes[body + 11];
      if (transform > 2 || adobe !== null && adobe !== transform) refuse('JXL_INPUT', "jpeg Adobe transform");
      adobe = transform;
    } else if (marker === 226 && size >= 16 && [...'ICC_PROFILE\0'].every((c, i) => bytes[body + i] === c.charCodeAt(0))) {
      const seq = bytes[body + 12], count = bytes[body + 13];
      if (!seq || !count || seq > count || parts.count && parts.count !== count || parts[seq]) refuse('JXL_INPUT', "jpeg ICC parts");
      iccBytes += next - (body + 14);
      if (iccBytes > maxMetadataBytes) refuse('JXL_LIMIT', "maxMetadataBytes: exceeded");
      parts.count = count; parts[seq] = bytes.subarray(body + 14, next);
    }
    at = next;
  }
  if (!frame) refuse('JXL_INPUT', "jpeg frame header: missing before scan");
  bounded(frame, limits);
  if (adobe !== null && (frame.components === 1 && adobe !== 0 || frame.components === 3 && adobe === 2 || frame.components === 4 && adobe === 1))
    refuse('JXL_INPUT', "jpeg Adobe transform: channel mismatch");
  const space = frame.components === 1 ? 'gray' : 'rgb';
  let colorEncoding;
  if (parts.count) {
    const pieces = [];
    for (let i = 1; i <= parts.count; i++) if (parts[i]) pieces.push(parts[i]); else refuse('JXL_INPUT', "jpeg ICC parts");
    const icc = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
    pieces.reduce((at, piece) => (icc.set(piece, at), at + piece.length), 0);
    const declared = icc.length >= 4 ? (icc[0] << 24 | icc[1] << 16 | icc[2] << 8 | icc[3]) >>> 0 : 0;
    const color = declared >= 132 && declared < icc.length ? icc.subarray(0, declared) : icc;
    inspectICC(color, undefined, frame.components === 4 ? 'cmyk' : space);
    const named = space === 'rgb' && frame.components !== 4 && profileSpace(color);
    const intent = named && new DataView(color.buffer, color.byteOffset, color.byteLength).getUint32(64);
    if (named && intent > 3) refuse('JXL_INPUT', "jpeg ICC rendering intent");
    colorEncoding = frame.components === 4 ? {space: 'cmyk', transferFunction: 'icc'}
      : stated(named ? {colorEncoding: {space, primaries: named, transferFunction: 'srgb', renderingIntent: intent}} : {icc: color}, space);
  } else colorEncoding = frame.components === 4 ? {space: adobe === 0 || adobe === 2 || [67, 77, 89, 75].every(id => frame.ids.has(id)) ? 'cmyk' : 'unknown'}
    : stated({colorSpace: 'srgb', transferFunction: 'srgb'}, space);
  return fields(frame.width, frame.height, orientation ?? 1, colorEncoding);
}

async function pngHeader(bytes, limits) {
  const maxMetadataBytes = limits?.maxMetadataBytes ?? Number.MAX_SAFE_INTEGER;
  const end = bytes.length, dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  for (;;) {
    if (at + 12 > end) refuse('JXL_INPUT', "png header: incomplete");
    const len = dataView.getUint32(at);
    if (len > 0x7fffffff || at + 12 + len > end) refuse('JXL_INPUT', "png header: incomplete");
    if (String.fromCharCode(...bytes.subarray(at + 4, at + 8)) === 'IDAT') break;
    at += 12 + len;
  }
  const walk = pngWalk(null, bytes.subarray(0, at + 8), 0, bytes.length, {edge: Infinity, pixels: Infinity});
  if (!walk.chunks.has('IHDR') || walk.least) refuse('JXL_INPUT', "png header");
  const ihdr = walk.chunks.get('IHDR'), view = new DataView(ihdr.buffer, ihdr.byteOffset, ihdr.byteLength), colourType = ihdr[9];
  const width = view.getUint32(0), height = view.getUint32(4), bits = colourType === 3 ? 8 : ihdr[8];
  if (width > 0x7fffffff || height > 0x7fffffff) refuse('JXL_INPUT', "png dimensions: too large");
  bounded({width, height}, limits);
  if (colourType === 3 && !walk.chunks.has('PLTE')) refuse('JXL_INPUT', "png palette: missing");
  const exif = walk.chunks.get('eXIf'), orientation = exif ? exifOrientation(exif, 0, exif.length) : null;
  const statement = pngColourStatement(walk.chunks, colourType), space = colourType === 0 || colourType === 4 ? 'gray' : 'rgb';
  const icc = statement.packed && await inflate([statement.packed], undefined, maxMetadataBytes);
  if (icc) inspectICC(icc, undefined, space);
  return fields(width, height, orientation ?? 1, stated(icc ? {icc} : statement, space, bits),
    colourType === 4 || colourType === 6 || walk.chunks.has('tRNS'), bits);
}

const bounded = (header, {maxPixels, maxDimension} = {}) => (overLimit(header, maxPixels, maxDimension, 'picture'), header);
export const inspectSource = async (bytes, limits) => bytes[0] === 255 ? jpegHeader(bytes, limits) : await pngHeader(bytes, limits);
