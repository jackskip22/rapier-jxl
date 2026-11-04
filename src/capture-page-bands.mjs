// SPDX-License-Identifier: MIT
import {BitWriter, float16Bits, ceilLog2, complete} from './bits.mjs';
import {admitOutputSize} from './admit.mjs';
import {writeHeaderFields, writeFrameHeaderEnd, finishSections, assembleCodestream, GROUP_DIM, DC_GROUP_DIM} from './frame.mjs';
import {ZERO_PREDICTOR, GRADIENT_PREDICTOR} from './modular.mjs';
import {writeModularStream, writeSmallerModularStream} from './modular-channel.mjs';
import {SCAN, DCT8_DENSITY} from './dct8-contexts.mjs';
import {buildCaptureTokenCoding} from './capture-prefix.mjs';
import {writeDCPlanes, clustering, acBlockContexts, writeAcBlockContexts} from './capture-vardct.mjs';
import {photoKernels} from './capture-kernels.mjs';
import {writeCapturePatches} from './capture-patches.mjs';
import {rgbCoefficientSteps} from './photo-dct.mjs';

const TOKEN_BYTES = 192 << 20;

function tally(CONTEXTS) {
  const small = new Uint32Array(CONTEXTS * 64), large = new Array(CONTEXTS);
  return {
    add(ctxs, values, n) {
      let most = 0;
      for (let i = 0; i < n; i++) {
        const ctx = ctxs[i], value = values[i];
        if (value > most) most = value;
        if (value < 64) small[ctx * 64 + value]++;
        else { const map = large[ctx] ??= new Map(); map.set(value, (map.get(value) ?? 0) + 1); }
      }
      return most;
    },
    *replay(CHUNK = 65536) {
      const ctxs = new Uint16Array(CHUNK), values = new Uint32Array(CHUNK);
      let n = 0;
      const put = function* (ctx, value, count) {
        while (count) {
          const k = Math.min(count, CHUNK - n);
          ctxs.fill(ctx, n, n + k); values.fill(value, n, n + k); n += k; count -= k;
          if (n === CHUNK) { yield {ctxs, values, n}; n = 0; }
        }
      };
      for (let ctx = 0; ctx < CONTEXTS; ctx++) {
        for (let value = 0; value < 64; value++) if (small[ctx * 64 + value]) yield* put(ctx, value, small[ctx * 64 + value]);
        if (large[ctx]) for (const [value, count] of large[ctx]) yield* put(ctx, value, count);
      }
      if (n) yield {ctxs, values, n};
    },
  };
}

function blockFields(fields, stride, x0, rw, rh) {
  const count = rw * rh, data = new Int32Array(2 * count);
  for (let y = 0, i = count; y < rh; y++) for (let x = 0; x < rw; x++, i++) data[i] = fields[y * stride + x0 + x] - 1;
  return data;
}
function rect(plane, stride, x0, rw, rh) {
  const out = new Int16Array(rw * rh);
  for (let y = 0; y < rh; y++) out.set(plane.subarray(y * stride + x0, y * stride + x0 + rw), y * rw);
  return out;
}

export function* pageFrameSteps(rows, width, height, {quality, colorSpace, areas = null, placement = {}, keep = TOKEN_BYTES, pass = null, blocks = acBlockContexts(null)}) {
  const {isFirstFrame = true, isLastFrame = true, crop = null, saveAsReference = 0, imageWidth, imageHeight, ans = null, patches = null} = placement;
  const {tokenGroup, tokens: tokenKernels} = photoKernels();
  const xsizeBlocks = Math.ceil(width / 8), ysizeBlocks = Math.ceil(height / 8);
  const groupsX = Math.ceil(width / GROUP_DIM), groupsY = Math.ceil(height / GROUP_DIM), numGroups = groupsX * groupsY;
  const dcGroupsX = Math.ceil(xsizeBlocks / 256), dcGroupsY = Math.ceil(ysizeBlocks / 256), numDcGroups = dcGroupsX * dcGroupsY;
  const single = numGroups === 1, kept = [];
  let keptBytes = 0;
  const band = b => complete(rgbCoefficientSteps(rows(b * GROUP_DIM, Math.min(GROUP_DIM, height - b * GROUP_DIM)), width,
    Math.min(GROUP_DIM, height - b * GROUP_DIM), quality, colorSpace, areas && areas.map(a => ({...a, y: a.y - b * GROUP_DIM}))));
  const residentGroups = function* () { for (let g = 0; g < numGroups; g++) { const group = pass.tokens(g); if (group) yield group; } yield* counts.replay(); };
  if (pass) { pass.keep = keep; pass.drop = (ctxs, values, n) => counts.add(ctxs, values, n); }

  const writers = Array.from({length: single ? 1 : 2 + numDcGroups + numGroups}, () => null);
  const section = index => writers[single ? 0 : index] ??= new BitWriter(4096);
  const sectionSizes = new Uint32Array(writers.length);
  let sectionBytes = 0;
  const checkSection = index => {
    index = single ? 0 : index;
    const size = Math.ceil(writers[index].bitLength / 8);
    sectionBytes += size - sectionSizes[index]; sectionSizes[index] = size;
    admitOutputSize(sectionBytes);
  };

  const tilesX = Math.ceil(xsizeBlocks / 8), dc = [0, 1, 2].map(() => new Int16Array(xsizeBlocks * 256));
  const cfl = [new Int16Array(tilesX * 32), new Int16Array(tilesX * 32)];
  let fields = null, field = 0, first = null;

  const CONTEXTS = blocks.contexts, counts = tally(CONTEXTS);
  for (let b = 0; b < groupsY; b++) {
    const resident = pass ? pass.band(b) : null, image = resident ? resident.image : band(b), {components} = image, top = b * 32 % 256, bh = image.components[0].rows;
    if (!first) {
      first = {quantTable: image.quantTable, colorSpace: image.colorSpace};
      field = image.quantFieldBase || 1;
      while (field / (8 * 255 * image.quantScale) < 1 / 16384) field *= 2;
      const head = section(0);
      if (patches) writeCapturePatches(head, patches, false);
      head.write(1, 0);
      for (let c = 0; c < 3; c++) head.write(16, float16Bits(components[c].quant[0] / (255 * 8 * image.quantScale) * 128));
      head.write(2, 3); head.write(16, 65536 - 8193);
      head.write(2, 1); head.write(5, 0);
      writeAcBlockContexts(head, blocks.fix(components[1].quant[0], image.quantScale));
      const base = image.cflBase ? 0x3c00 : 0;
      head.write(1, 0); head.write(2, 0); head.write(16, base); head.write(16, base); head.write(8, 128); head.write(8, 128);
      head.write(1, 0);
      checkSection(0);
    }
    const groups = resident ? null : keptBytes < keep ? [] : null;
    for (let g = 0; !resident && g < groupsX; g++) {
      const {ctxs, values, n} = tokenGroup(components, width, bh * 8, g, DCT8_DENSITY, SCAN, blocks), most = counts.add(ctxs, values, n);
      if (groups) { groups.push({ctxs: ctxs.slice(0, n), values: most < 256 ? Uint8Array.from(values.subarray(0, n)) : values.slice(0, n), n}); keptBytes += n * (most < 256 ? 3 : 6); }
    }
    kept.push(groups);
    for (let c = 0; c < 3; c++) {
      const coeffs = components[c].coeffs, out = dc[c];
      if (resident) out.set(resident.dc[c], top * xsizeBlocks);
      else for (let i = 0, at = top * xsizeBlocks; i < bh * xsizeBlocks; i++) out[at + i] = coeffs[i * 64];
    }
    const tileRows = Math.ceil(bh / 8);
    cfl[0].set(image.cfl.x.subarray(0, tileRows * tilesX), (top >> 3) * tilesX);
    cfl[1].set(image.cfl.b.subarray(0, tileRows * tilesX), (top >> 3) * tilesX);
    if (image.quantFields) (fields ??= new Uint16Array(xsizeBlocks * 256)).set(image.quantFields.subarray(0, bh * xsizeBlocks), top * xsizeBlocks);
    if (top + bh === 256 || b + 1 === groupsY) {
      const gy = (b * GROUP_DIM / DC_GROUP_DIM) | 0, rh = Math.min(256, ysizeBlocks - gy * 256);
      for (let gx = 0; gx < dcGroupsX; gx++) {
        const w = section(1 + gy * dcGroupsX + gx), x0 = gx * 256, rw = Math.min(256, xsizeBlocks - x0);
        w.write(2, 0);
        writeDCPlanes(w, [1, 0, 2].map(c => ({w: rw, h: rh, data: rect(dc[c], xsizeBlocks, x0, rw, rh)})), ans);
        const count = rw * rh, bits = ceilLog2(count);
        if (bits) w.write(bits, count - 1);
        const cw = (rw + 7) >> 3, ch = (rh + 7) >> 3;
        writeSmallerModularStream(w, [
          {w: cw, h: ch, data: rect(cfl[0], tilesX, x0 >> 3, cw, ch)}, {w: cw, h: ch, data: rect(cfl[1], tilesX, x0 >> 3, cw, ch)},
          fields ? {w: count, h: 2, data: blockFields(fields, xsizeBlocks, x0, rw, rh)} : {w: count, h: 2, rowValues: [0, field - 1]},
          {w: rw, h: rh, rowValues: new Int16Array(rh)},
        ], field > 1 ? GRADIENT_PREDICTOR : ZERO_PREDICTOR);
        checkSection(1 + gy * dcGroupsX + gx);
      }
    }
    yield (b + 1) / groupsY * 0.8;
  }

  const prefix = pass ? buildCaptureTokenCoding(CONTEXTS, residentGroups(), tokenKernels?.(), ...clustering(ans)) : buildCaptureTokenCoding(CONTEXTS, counts.replay(), null, ...clustering(ans));
  const coding = ans && ans(prefix, pass ? residentGroups() : counts.replay()) || prefix;
  const ac = section(1 + numDcGroups);
  ac.write(1, 0);
  for (let i = 0; i < 17; i++) {
    if (i !== 0) { ac.write(3, 0); continue; }
    ac.write(3, 6); ac.write(4, 5); for (const table of first.quantTable) for (const bits of table) ac.write(16, bits);
  }
  if (numGroups > 1) ac.write(ceilLog2(numGroups), 0);
  ac.write(2, 2);
  coding.writeHistograms(ac);
  checkSection(1 + numDcGroups);

  for (let b = 0; b < groupsY; b++) {
    const dropped = pass && Array.from({length: groupsX}, (_, g) => !pass.tokens(b * groupsX + g)).some(Boolean);
    const groups = kept[b], image = (groups || pass) && !dropped ? null : band(b);
    kept[b] = null;
    for (let g = 0; g < groupsX; g++) {
      const index = 2 + numDcGroups + b * groupsX + g, {ctxs, values, n} = (pass && pass.tokens(b * groupsX + g)) || groups?.[g] || tokenGroup(image.components, width, image.components[0].rows * 8, g, DCT8_DENSITY, SCAN, blocks);
      coding.writeTokens(section(index), ctxs, values, n);
      checkSection(index);
    }
    yield 0.8 + (b + 1) / groupsY * 0.2;
  }

  const header = new BitWriter(256);
  if (isFirstFrame) writeHeaderFields(header, imageWidth ?? width, imageHeight ?? height, 3, false, {xyb: false, colorSpace: first.colorSpace || 'srgb', modular16bit: field <= 32768});
  header.write(1, 0); header.write(2, 0); header.write(1, 0);
  header.write(2, 2); header.write(8, (patches ? 130 : 128) - 17);
  header.write(1, 0);
  header.write(2, 0);
  writeFrameHeaderEnd(header, false, 0, null, 1, null, {crop, canvas: imageWidth && {width: imageWidth, height: imageHeight}, last: isLastFrame, reference: saveAsReference, mask: false});
  return assembleCodestream(header, finishSections(writers));
}
