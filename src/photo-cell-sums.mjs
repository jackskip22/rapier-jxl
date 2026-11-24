// SPDX-License-Identifier: MIT
import {s2CellSums} from './s2-cells.mjs';
import {bandedRGBA} from './photo-reconstruct-bands.mjs';
import {rebuildPicture} from './photo-rebuild.mjs';
import {rebuildKernels} from './rebuild-kernels.mjs';
import {xybKernelConstants} from './vardct-render.mjs';
import {DEFAULT_OPSIN} from './opsin.mjs';
import {nativeTables, nativeByte} from './photo-output.mjs';
import {trialDue, tryStage, leftDevice, phoneLumaSkip} from './device-trial.mjs';

export function* pictureCellSums(picture, reference, width, height, yOnly, held, fuse = false) {
  const pixels = width * height, refBytes = reference?.rgba;
  const canGpuCells = !!(refBytes && (refBytes instanceof Uint8Array || refBytes instanceof Uint8ClampedArray) && width >= 8 && height >= 8);
  let rgba = null;
  if (canGpuCells && !leftDevice('photo-rebuild', pixels) && !trialDue('photo-rebuild', pixels)) {
    held.constants ??= xybKernelConstants(DEFAULT_OPSIN.inverseMatrix.map(Math.fround), DEFAULT_OPSIN.opsinBiases, 255);
    const cells = fuse && !leftDevice('s2-cells', pixels) && !trialDue('s2-cells', pixels);
    const built = yield {gpu: {kind: 'photo-rebuild', image: picture, rebuild: rebuildPicture, kernels: rebuildKernels(), constants: held.constants, native: {nativeTables, nativeByte}, held: held.rebuild, keep: cells,
      ...(cells && {cells: {reference: refBytes, width, height, yOnly, held: held.cells}})}};
    if (built?.cells) return built.cells;
    if (built?.rgba) rgba = built.rgba;
    else if (built?.readAll) rgba = (yield {await: built.readAll()})?.rgba ?? null;
  }
  if (!rgba && picture.zoneSteps) {
    const streamed = yield* picture.zoneSteps(yOnly);
    if (streamed?.scales) return streamed;
    rgba = streamed;
  }
  rgba ??= bandedRGBA(picture);
  picture = null;
  if (!canGpuCells || leftDevice('s2-cells', pixels) || phoneLumaSkip(pixels, yOnly)) return s2CellSums(reference, {rgba}, width, height, yOnly);
  const req = {gpu: {kind: 's2-cells', reference: refBytes, decoded: rgba, width, height, yOnly, held: held.cells}};
  return trialDue('s2-cells', pixels)
    ? yield* tryStage('s2-cells', pixels, req, function* () { return s2CellSums(reference, {rgba}, width, height, yOnly); })
    : (yield req) ?? s2CellSums(reference, {rgba}, width, height, yOnly);
}

export function* pictureCellSumsBatch(rgbaList, reference, width, height, yOnly, held, allowGpu = true) {
  if (!rgbaList.length) return [];
  const pixels = width * height, refBytes = reference?.rgba;
  const canGpuCells = allowGpu && !!(refBytes && (refBytes instanceof Uint8Array || refBytes instanceof Uint8ClampedArray) && width >= 8 && height >= 8);
  if (!canGpuCells || leftDevice('s2-cells', pixels) || phoneLumaSkip(pixels, yOnly)) return rgbaList.map(rgba => s2CellSums(reference, {rgba}, width, height, yOnly));
  const maxBatch = Math.max(1, Math.floor((64 * 1024 * 1024) / Math.max(8, pixels * 8)));
  const out = [];
  for (let i = 0; i < rgbaList.length; i += maxBatch) {
    const chunk = rgbaList.slice(i, i + maxBatch);
    const req = {gpu: {kind: 's2-cells', reference: refBytes, decodedList: chunk, width, height, yOnly, held: held.cells}};
    const res = trialDue('s2-cells', pixels)
      ? yield* tryStage('s2-cells', pixels, req, function* () { return chunk.map(rgba => s2CellSums(reference, {rgba}, width, height, yOnly)); })
      : (yield req) ?? chunk.map(rgba => s2CellSums(reference, {rgba}, width, height, yOnly));
    out.push(...res);
  }
  return out;
}
