// SPDX-License-Identifier: MIT
import {complete, part} from './bits.mjs';
import {stage, carried, PASSED} from './step-journal.mjs';
import {GROUP_DIM} from './frame.mjs';
import {rgbCoefficientSteps} from './photo-dct.mjs';
import {packLevels, unpackLevels, packedOnly, splitBlockCounts} from './photo-levels.mjs';
import {kernelHooks} from './kernel-hooks.mjs';
import {learnedOrderCounts, seedLearnedOrderCounts} from './varblock-write.mjs';

export const COEFFICIENT_BAND_BYTES = 192 << 20;
const samePlanes = (a, b) => a.length === b.length && a.every((p, c) => p.length === b[c].length && p.every((v, i) => v === b[c][i]));

export function* rgbCoefficientBandsSteps(rows, width, height, {quality, colorSpace, areas = null,
  keep = COEFFICIENT_BAND_BYTES, strategy = null, observeBand = null} = {}) {
  const bands = Math.ceil(height / GROUP_DIM), stride = Math.ceil(width / 8), blockRows = Math.ceil(height / 8);
  const groupsX = Math.ceil(width / GROUP_DIM), tilesX = Math.ceil(stride / 8), tileRows = Math.ceil(blockRows / 8);
  const saved = new Array(bands), scratch = [], orderCounts = [];
  const make = function* (b, again = false) {
    const top = b * GROUP_DIM, h = Math.min(GROUP_DIM, height - top), pixels = rows(top, h);
    const observed = observeBand && !again ? pixels.slice() : null, own = areas?.map(a => ({...a, y: a.y - top}));
    const band = strategy ? yield* strategy.band(pixels, width, h, {quality, colorSpace, areas: own, top, again})
      : yield* rgbCoefficientSteps(pixels, width, h, quality, colorSpace, own, {packed: !observeBand});
    if (observed) observing = [band, observed];
    return band;
  };
  let observing = null;
  let image, current = null, currentBand = -1, keptBytes = 0, summarized = false;
  const load = b => {
    if (b === currentBand) return current;
    if (current && !current.strategyData) packedOnly(current);
    current = saved[b] ?? complete(make(b, true)); currentBand = b;
    if (!current.strategyData) for (let c = 0; c < 3; c++) {
      image.components[c].coeffs = current.components[c].coeffs;
      image.components[c].packed = current.components[c].packed;
      image.components[c].row0 = b * (GROUP_DIM / 8);
    }
    return current;
  };
  for (let b = 0; b < bands; b++) {
    const band = yield* part(stage('coefficient-band', () => make(b), {tool: 'band-summary',
      extra: band => band.strategyData ? {orders: learnedOrderCounts(band.strategyData.blocks), ...strategy?.summary?.(band)} : null}), b, bands);
    const firstBlock = b * (GROUP_DIM / 8) * stride, full = () => band.summary || band.answered ? complete(make(b, true)) : band;
    if (observeBand) {
      const seen = observing?.[0] === band ? observing[1] : null;
      observing = null;
      const saved = yield* carried('band-guard', () => {
        observeBand(full(), seen ?? rows(b * GROUP_DIM, Math.min(GROUP_DIM, height - b * GROUP_DIM)).slice(), b * GROUP_DIM);
        return observeBand.state?.() ?? null;
      });
      if (saved !== PASSED && saved !== null) observeBand.restore?.(saved);
    }
    if (strategy?.after) yield* strategy.after(band, b * GROUP_DIM, full);
    if (!image) {
      image = {...band, width, height, alpha: null, alphaRows: rows,
        components: band.components.map(c => ({...c, rows: blockRows, row0: 0, coeffs: new Int16Array(0), packed: undefined,
          dc: band.strategyData ? new Int32Array(stride * blockRows) : new Int16Array(stride * blockRows), natural: new Uint32Array(64)})),
        nonZero: band.components.map(() => new Uint8Array(stride * blockRows)),
        cfl: {width: tilesX, x: new Int16Array(tilesX * tileRows), b: new Int16Array(tilesX * tileRows)},
        ...(band.quantFields && {quantFields: new Uint16Array(stride * blockRows)}), band: load,
        unpackBand() {
          if (!current || current.strategyData || current.components[0].coeffs) return;
          unpackLevels(current, scratch);
          for (let c = 0; c < 3; c++) image.components[c].coeffs = current.components[c].coeffs;
        }};
      if (band.strategyData) image.strategyData = {groups: [], blocks: [], at: new Int32Array(stride * blockRows).fill(-2), tables: new Array(17).fill(null), stride};
    } else if (band.quantScale !== image.quantScale || (band.quantFieldBase || 1) !== (image.quantFieldBase || 1)
      || band.cflBase !== image.cflBase || !!band.strategyData !== !!image.strategyData
      || !samePlanes(image.components.map(c => c.quant), band.components.map(c => c.quant)))
      throw new Error('Bands of one photo frame must share their quantization domain and prediction base.');
    let bytes = 0;
    if (band.strategyData) {
      if (band.summary) band.extra?.orders?.forEach((c3, id) => {
        if (!c3) return;
        if (!orderCounts[id]) orderCounts[id] = c3.map(n => n.slice());
        else for (let c = 0; c < 3; c++) for (let k = 0; k < c3[c].length; k++) orderCounts[id][c][k] += c3[c][k];
      });
      else learnedOrderCounts(band.strategyData.blocks, orderCounts);
      const owner = image.strategyData;
      for (const [family, table] of band.strategyData.tables.entries()) {
        if (!table) continue;
        const previous = owner.tables[family];
        if (previous && (previous.w !== table.w || previous.h !== table.h || !samePlanes(previous.planes, table.planes)))
          throw new Error('Bands of one photo frame must share each transform family\'s quantization table.');
        if (!previous) owner.tables[family] = table;
      }
      const coefficientBuffers = new Set();
      const coeffsOf = i => load(b).strategyData.blocks[i].coeffs;
      const frameBlocks = band.summary ? band.frameBlocks(b * (GROUP_DIM / 8), coeffsOf) : band.strategyData.blocks.map((source, i) => {
        const {coeffs, levels: _levels, ...meta} = source;
        for (const plane of coeffs) if (!coefficientBuffers.has(plane.buffer)) { coefficientBuffers.add(plane.buffer); bytes += plane.buffer.byteLength; }
        return {...meta, by: source.by + b * (GROUP_DIM / 8), get coeffs() { return coeffsOf(i); }};
      });
      for (const block of frameBlocks) {
        owner.at[block.by * stride + block.bx] = owner.blocks.length; owner.blocks.push(block);
        const group = b * groupsX + (block.bx >> 5);
        (owner.groups[group] ??= []).push(block);
      }
      for (let c = 0; c < 3; c++) image.components[c].dc.set(band.components[c].dc, firstBlock);
      image.wideCoefficients ||= band.wideCoefficients;
    } else {
      band.nonZero = band.components.map(c => c.packed?.counts ?? splitBlockCounts(c.coeffs));
      for (let c = 0; c < 3; c++) {
        const {coeffs, packed} = band.components[c], into = image.components[c], natural = into.natural;
        if (packed) {
          into.dc.set(packed.dc, firstBlock);
          for (let k = 0; k < 64; k++) natural[k] += packed.natural[k];
        } else {
          for (let at = 0, block = firstBlock; at < coeffs.length; at += 64, block++) into.dc[block] = coeffs[at];
          for (let from = 0; from < coeffs.length; from += 65536) {
            const end = Math.min(from + 65536, coeffs.length);
            if (!kernelHooks.nonzero?.(coeffs, from, end, natural)) for (let at = from; at < end; at += 64)
              for (let k = 1; k < 64; k++) if (coeffs[at + k]) natural[k]++;
          }
        }
        image.nonZero[c].set(band.nonZero[c], firstBlock);
      }
      if (band.components[0].packed) {
        const buffers = new Set();
        for (const component of band.components) for (const value of Object.values(component.packed))
          if (ArrayBuffer.isView(value) && !buffers.has(value.buffer)) { buffers.add(value.buffer); bytes += value.buffer.byteLength; }
      } else for (const counts of band.nonZero) { bytes += counts.length + counts.length / stride * 4; for (const n of counts) bytes += 3 * n; }
    }
    const tileOffset = b * (GROUP_DIM / 64) * tilesX;
    image.cfl.x.set(band.cfl.x, tileOffset); image.cfl.b.set(band.cfl.b, tileOffset);
    if (band.quantFields || image.quantFields) {
      image.quantFields ??= new Uint16Array(stride * blockRows).fill(image.quantFieldBase || 1);
      if (band.quantFields) image.quantFields.set(band.quantFields, firstBlock);
      else image.quantFields.fill(band.quantFieldBase || 1, firstBlock, Math.min(image.quantFields.length, firstBlock + (GROUP_DIM / 8) * stride));
    }
    if (band.summary) summarized = true;
    if (!band.summary && bytes <= keep - keptBytes) { saved[b] = band.strategyData || band.components[0].packed ? band : packLevels(band); keptBytes += bytes; }
  }
  if (image.strategyData) seedLearnedOrderCounts(image, orderCounts);
  if (saved[0] || !(image.strategyData || summarized)) load(0);
  return image;
}

export {samePlanes as sameCoefficientPlanes};
