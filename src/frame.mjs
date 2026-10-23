// Rapier's JPEG XL encoder: the codestream around a frame. MIT (LICENSE).
import {BitWriter, float16Bits} from './bits.mjs';
import {admitOutputSize} from './admit.mjs';
import {headerOf} from './icc-write.mjs';

export const GROUP_DIM = 256, DC_GROUP_DIM = 2048;

function writeSize(w, size) {
  w.writeU32([[9, 1], [13, 1], [18, 1], [30, 1]], size);
}

export function writeImageHeader(w, width, height, colour, alpha, {xyb = false, orientation = 1, colorSpace, bitDepth = 8, exponentBits = 0, transferFunction = 'srgb', intensityTarget = 255, alphaPremultiplied = false, modular16bit = bitDepth <= 12 && !exponentBits, colorData, toneData, iccData, imageFields, extraChannelData, transformData} = {}) {
  if (colorSpace && typeof colorSpace === 'object') ({colorData, iccData} = headerOf(colorSpace));
  w.write(16, 0x0AFF);
  w.write(1, 0);
  writeSize(w, height);
  w.write(3, 0);
  writeSize(w, width);
  w.write(1, 0);
  const extra = orientation !== 1 || intensityTarget !== 255 || !!toneData || !!imageFields;
  w.write(1, extra ? 1 : 0);
  if (extra) { if (imageFields) w.append(imageFields); else w.write(6, orientation - 1); }
  writeSampleDepth(w, bitDepth, exponentBits);
  w.write(1, modular16bit ? 1 : 0);
  if (extraChannelData) w.append(extraChannelData);
  else if (alpha && bitDepth === 8 && !exponentBits && !alphaPremultiplied) w.write(3, 0b1_01);
  else if (alpha) {
    w.write(3, 0b0_01);
    w.write(2, 0);
    writeSampleDepth(w, bitDepth, exponentBits);
    w.write(4, 0);
    w.write(1, alphaPremultiplied ? 1 : 0);
  }
  else w.write(2, 0);
  w.write(1, xyb ? 1 : 0);
  if (colorData) w.append(colorData);
  else if (transferFunction !== 'srgb' || colorSpace === 'rec2020') {
    w.write(2, 0);
    writeColorEnum(w, colour === 3 ? 0 : 1);
    writeColorEnum(w, 1);
    if (colour === 3) writeColorEnum(w, colorSpace === 'rec2020' ? 9 : colorSpace === 'display-p3' ? 11 : 1);
    w.write(1, 0);
    writeColorEnum(w, transferFunction === 'linear' ? 8 : transferFunction === 'pq' ? 16 : transferFunction === 'hlg' ? 18 : 13);
    writeColorEnum(w, 1);
  } else if (colour === 3 && colorSpace === 'display-p3') {
    w.write(21, 0b01_1011_10_0_1001_10_01_00_0_0);
  } else if (colour === 3) w.write(1, 1);
  else {
    w.write(15, 0b01_1011_10_0_01_01_0_0);
  }
  if (extra) {
    if (toneData) w.append(toneData);
    else {
      w.write(1, intensityTarget === 255 ? 1 : 0);
      if (intensityTarget !== 255) {
        w.write(16, float16Bits(intensityTarget));
        w.write(32, 0); w.write(1, 0);
      }
    }
  }
  w.write(2, 0);
  if (transformData) w.append(transformData); else w.write(1, 1);
  if (iccData) w.append(iccData);
  w.zeroPadToByte();
}

function writeSampleDepth(w, bits, exponent) {
  w.write(1, exponent ? 1 : 0);
  w.writeU32(exponent ? [[0, 32], [0, 16], [0, 24], [6, 1]] : [[0, 8], [0, 10], [0, 12], [6, 1]], bits);
  if (exponent) w.write(4, exponent - 1);
}

function writeColorEnum(w, value) { w.writeU32([[0, 0], [0, 1], [4, 2], [6, 18]], value); }

export function writeModularFrameHeader(w, {alpha, shift = 1, extraChannels = Number(!!alpha), upsampling = 1, extraUpsampling, passes}) {
  w.write(7, 0b0_00_1_00_0);
  w.writeU32([[0, 1], [0, 2], [0, 4], [0, 8]], upsampling);
  for (let c = 0; c < extraChannels; c++) w.writeU32([[0, 1], [0, 2], [0, 4], [0, 8]], extraUpsampling?.[c] ?? 1);
  w.write(2, shift);
  writeFrameHeaderEnd(w, extraChannels, 0, passes);
}

export function writeFrameHeaderEnd(w, alpha, epf = 0, passes, epfIterations = 1) {
  const channels = typeof alpha === 'number' ? alpha : Number(!!alpha);
  if (passes) w.append(passes); else w.write(2, 0);
  w.write(3, 0);
  for (let c = 0; c < channels; c++) w.write(2, 0);
  if (!epf) { w.write(11, 1); return; }
  w.write(5, 1);
  w.write(2, epfIterations);
  w.write(3, 4);
  for (const value of [epf, 0.9, 6.5, 2 / 3]) w.write(16, float16Bits(value));
  w.write(4, 0);
}

export function writeTOC(w, sizes) {
  w.write(1, 0);
  w.zeroPadToByte();
  for (const size of sizes) w.writeU32([[10, 0], [14, 1024], [22, 17408], [30, 4211712]], size);
  w.zeroPadToByte();
}

export function groupLayout(width, height, dim = GROUP_DIM) {
  const groupsX = Math.ceil(width / dim), groupsY = Math.ceil(height / dim);
  const dcGroupsX = Math.ceil(width / (8 * dim)), dcGroupsY = Math.ceil(height / (8 * dim));
  return {groupsX, groupsY, dcGroupsX, dcGroupsY, single: groupsX === 1 && groupsY === 1};
}

export function groupRect(layout, width, height, g, dim = GROUP_DIM) {
  const x0 = g % layout.groupsX * dim, y0 = (g / layout.groupsX | 0) * dim;
  return [x0, y0, Math.min(dim, width - x0), Math.min(dim, height - y0)];
}

export function* groupPass(request, groups, run, accept) {
  if (request.pooled) {
    const reply = yield request;
    if (!reply || reply.pruned) return null;
    reply.results.forEach((result, g) => accept(g, result));
    return reply.hurried;
  }
  let hurried = false, sectionBytes = 0;
  for (let g = 0; g < groups; g++) {
    const result = run(g);
    if (request.byteCeiling !== undefined) sectionBytes += result.length;
    hurried = yield request.at(g);
    if (request.byteCeiling !== undefined && sectionBytes >= request.byteCeiling || hurried && request.stop(g)) return null;
  }
  return hurried;
}
export function addCounts(into, counts) { into.forEach((h, i) => { const c = counts[i]; for (let s = 0; s < h.length; s++) h[s] += c[s]; }); }

export function finishSections(writers) { return writers.map(w => w ? w.finish() : new Uint8Array(0)); }

export function assembleCodestream(header, sections, level = 5) {
  const sizes = sections.map(section => section.length);
  writeTOC(header, sizes);
  const head = header.finish();
  const prefix = level === 10 ? 49 : 0;
  const length = prefix + head.length + sizes.reduce((a, b) => a + b, 0);
  admitOutputSize(length);
  const out = new Uint8Array(length);
  if (prefix) {
    out.set([0,0,0,12,74,88,76,32,13,10,135,10,
      0,0,0,20,102,116,121,112,106,120,108,32,0,0,0,0,106,120,108,32,
      0,0,0,9,106,120,108,108,10,0,0,0,0,106,120,108,99]);
    new DataView(out.buffer).setUint32(41, length - 41);
  }
  out.set(head, prefix);
  let at = prefix + head.length;
  for (const section of sections) { out.set(section, at); at += section.length; }
  return out;
}
