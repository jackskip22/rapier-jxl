// SPDX-License-Identifier: MIT
import {gaborishRows} from './photo-v6.mjs';
import {bandedRGBA} from './photo-reconstruct-bands.mjs';
import {layoutPicture, unpackLayout, bandRecipe} from './photo-layout-picture.mjs';
import {s2CellSums} from './s2-cells.mjs';
import {offloading, offloadWorkers} from './offload.mjs';
import {journaling} from './step-journal.mjs';
import {hostGPU} from './gpu-gate.mjs';
import {leftDevice, phoneLumaSkip} from './device-trial.mjs';
import {BAND_PIXELS} from './memory-device.mjs';

export function zoneCellsOf(recipe, rows, width, height, yOnly) {
  const W = Math.ceil(width / 8) * 8;
  let planeRows;
  if (recipe.sharedPlanes) {
    const sp = recipe.sharedPlanes;
    planeRows = () => ({planes: sp.planes, top: sp.top, stride: W});
  } else {
    const planes = gaborishRows(rows, width, height, recipe.gaborish);
    planeRows = (from, to, x0, x1) => ({...planes(from, to, x0, x1), stride: W});
  }
  const picture = layoutPicture({...recipe.base, planeRows}, width, recipe.base.height, unpackLayout(recipe.layout), {...recipe.options, rated: true}, false);
  const rgba = bandedRGBA(picture);
  return {sums: s2CellSums({rgba: rows}, {rgba}, width, height, yOnly), rates: picture.rates};
}

export function zoneCellsTask(picture, reference, width, height, yOnly) {
  const rgba = reference?.rgba;
  if (!picture?.recipe || !offloading('score-band') || offloadWorkers() < 1 || journaling() || (hostGPU() && !leftDevice('s2-cells', width * height) && !phoneLumaSkip(width * height, yOnly)) ||
      width * height > Math.min(BAND_PIXELS, 1048576) || !(rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray) || rgba.length !== width * height * 4 ||
      picture.recipe.base.height !== height || picture.recipe.base.width !== width)
    return null;
  return {kind: 'zone-cells', recipe: bandRecipe(picture.recipe, 0, height), rows: rgba.slice(), width, height, yOnly: !!yOnly};
}
export const zoneCellsReply = (task, result) => !!result && result.rates instanceof Float64Array &&
  result.rates.length === Math.ceil(task.width / 8) * Math.ceil(task.height / 8) && Array.isArray(result.sums?.scales);
