// SPDX-License-Identifier: MIT
import {fault} from './admit.mjs';

export const PATCH_BLEND_MODES = Object.freeze(['none', 'replace', 'add', 'multiply',
  'blend-above', 'blend-below', 'alpha-weighted-add-above', 'alpha-weighted-add-below']);

export function patchObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fault('JXL_INPUT', label + ' is an object.');
  return value;
}
export function patchMode(value = 'replace') {
  const mode = PATCH_BLEND_MODES.indexOf(value);
  if (mode < 0) throw fault('JXL_INPUT', 'Patch blend is one of PATCH_BLEND_MODES.');
  return mode;
}
export function patchWhole(value, maximum, label, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw fault('JXL_INPUT', label + ' is a whole number from ' + minimum + ' to ' + maximum + '.');
  return value;
}
export function patchClamp(value, mode, label) {
  if (value === undefined) return false;
  if (typeof value !== 'boolean' || value && mode < 3)
    throw fault('JXL_INPUT', label + ' is a boolean; clamping applies to multiply and alpha-aware blend modes.');
  return value;
}

export function patchGeometry(supplied, width, height, references, position, referenceLimit, defaultReference = 0) {
  if (!Array.isArray(supplied) || !supplied.length || supplied.length > referenceLimit)
    throw fault('JXL_INPUT', 'patches is a nonempty array within the destination image\'s reference-rectangle budget.');
  let placements = 0, area = 0;
  const groups = Array.from(supplied, group => {
    patchObject(group, 'Each patch');
    const reference = patchWhole(group.reference ?? defaultReference, 3, 'Patch reference'), atlas = references.get(reference);
    if (!atlas) throw fault('JXL_INPUT', 'A patch reads a reference slot that was not supplied.');
    const sx = patchWhole(group.sourceX, atlas.width - 1, 'sourceX'), sy = patchWhole(group.sourceY, atlas.height - 1, 'sourceY');
    const w = patchWhole(group.width, atlas.width - sx, 'patch width', 1), h = patchWhole(group.height, atlas.height - sy, 'patch height', 1);
    if (w > width || h > height) throw fault('JXL_INPUT', 'A patch rectangle fits inside the destination image.');
    if (!Array.isArray(group.positions) || !group.positions.length || group.positions.length > referenceLimit * 4 - placements)
      throw fault('JXL_INPUT', 'Patch positions are nonempty and within the destination image\'s placement budget.');
    placements += group.positions.length; area += w * h * group.positions.length;
    const positions = Array.from(group.positions, suppliedPosition => {
      patchObject(suppliedPosition, 'Each patch position');
      const x = patchWhole(suppliedPosition.x, width - w, 'patch x'), y = patchWhole(suppliedPosition.y, height - h, 'patch y');
      return {x, y, ...position(suppliedPosition)};
    });
    return {reference, sx, sy, w, h, positions};
  });
  return {groups, placements, area};
}

export function patchCoverage(area, size, level) {
  if (area > Math.max(1048576, 1024 * size)) throw fault('JXL_INPUT', 'Patch coverage exceeds the JPEG XL level-10 decoder area budget.');
  if (level === 5 && area > Math.max(1048576, 8 * size))
    throw fault('JXL_INPUT', 'These patches require explicit level: 10; Chrome 155 enforces the smaller level-5 patch area budget.');
}
export function patchTokenCount(groups, extraChannels) {
  let count = 1 + groups.length * 6;
  for (const group of groups) for (const position of group.positions)
    count += 2 + position.blending.reduce((sum, blend) => sum + 1 + Number(blend.mode >= 3) + Number(blend.mode >= 4 && extraChannels > 1), 0);
  return count;
}
