// SPDX-License-Identifier: MIT
import {fault} from './admit.mjs';

export const PATCH_BLEND_MODES = Object.freeze(['none', 'replace', 'add', 'multiply',
  'blend-above', 'blend-below', 'alpha-weighted-add-above', 'alpha-weighted-add-below']);

export function patchObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fault('JXL_INPUT', label + ': object');
  return value;
}
export function patchMode(value = 'replace') {
  const mode = PATCH_BLEND_MODES.indexOf(value);
  if (mode < 0) throw fault('JXL_INPUT', 'blend: PATCH_BLEND_MODES value');
  return mode;
}
export function patchWhole(value, maximum, label, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw fault('JXL_INPUT', label + ': integer ' + minimum + '-' + maximum);
  return value;
}
export function patchClamp(value, mode, label) {
  if (value === undefined) return false;
  if (typeof value !== 'boolean' || value && mode < 3)
    throw fault('JXL_INPUT', label + ': boolean on multiply or alpha blend');
  return value;
}

export function patchGeometry(supplied, width, height, references, position, referenceLimit, defaultReference = 0) {
  if (!Array.isArray(supplied) || !supplied.length || supplied.length > referenceLimit)
    throw fault('JXL_INPUT', 'patches: nonempty array within budget');
  let placements = 0, area = 0;
  const groups = Array.from(supplied, group => {
    patchObject(group, 'patch');
    const reference = patchWhole(group.reference ?? defaultReference, 3, 'reference'), atlas = references.get(reference);
    if (!atlas) throw fault('JXL_INPUT', 'reference: missing slot');
    const sx = patchWhole(group.sourceX, atlas.width - 1, 'sourceX'), sy = patchWhole(group.sourceY, atlas.height - 1, 'sourceY');
    const w = patchWhole(group.width, atlas.width - sx, 'patch width', 1), h = patchWhole(group.height, atlas.height - sy, 'patch height', 1);
    if (w > width || h > height) throw fault('JXL_INPUT', 'patch: exceeds image');
    if (!Array.isArray(group.positions) || !group.positions.length || group.positions.length > referenceLimit * 4 - placements)
      throw fault('JXL_INPUT', 'positions: nonempty array within budget');
    placements += group.positions.length; area += w * h * group.positions.length;
    const positions = Array.from(group.positions, suppliedPosition => {
      patchObject(suppliedPosition, 'position');
      const x = patchWhole(suppliedPosition.x, width - w, 'patch x'), y = patchWhole(suppliedPosition.y, height - h, 'patch y');
      return {x, y, ...position(suppliedPosition)};
    });
    return {reference, sx, sy, w, h, positions};
  });
  return {groups, placements, area};
}

export function patchCoverage(area, size, level) {
  if (area > Math.max(1048576, 1024 * size)) throw fault('JXL_INPUT', 'patches: over level 10 budget');
  if (level === 5 && area > Math.max(1048576, 8 * size))
    throw fault('JXL_INPUT', 'patches: use level 10');
}
export function patchTokenCount(groups, extraChannels) {
  let count = 1 + groups.length * 6;
  for (const group of groups) for (const position of group.positions)
    count += 2 + position.blending.reduce((sum, blend) => sum + 1 + Number(blend.mode >= 3) + Number(blend.mode >= 4 && extraChannels > 1), 0);
  return count;
}
