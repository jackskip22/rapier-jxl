// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';

const invalid = message => fault('JXL_INPUT', message);
export function grid(frame) {
  const dimension = 128 << frame.shift, columns = Math.ceil(Math.ceil(frame.width / frame.upsampling) / dimension);
  const rows = Math.ceil(Math.ceil(frame.height / frame.upsampling) / dimension);
  const dcGroups = Math.ceil(columns / 8) * Math.ceil(rows / 8);
  return {dimension, columns, rows, groups: columns * rows, dcGroups};
}

export function physicalOrder(frame) {
  const result = frame.sizes.map((_, i) => i);
  if (frame.permutation) for (let i = 0; i < frame.permutation.length; i++) result[frame.permutation[i]] = i;
  return result;
}

export function offsets(frame) {
  if (frame.sectionOffsets) return frame.sectionOffsets;
  const result = []; let offset = frame.sectionsAt;
  for (const size of frame.sizes) { result.push(offset); offset += size; } return result;
}

export function sectionInfo(frame, index, offset, physicalIndex, details) {
  const result = {index, physicalIndex, byteOffset: offset, byteLength: frame.sizes[index]};
  if (frame.sizes.length === 1) return {...result, kind: 'combined'};
  if (index === 0) return {...result, kind: 'lf-global'};
  if (index <= details.dcGroups) return {...result, kind: 'dc-group', group: index - 1};
  if (index === details.dcGroups + 1) return {...result, kind: 'hf-global'};
  const ac = index - details.dcGroups - 2, group = ac % details.groups, pass = Math.floor(ac / details.groups);
  return {...result, kind: 'ac-group', group, pass, ...groupRectangle(frame, group, details)};
}
function groupRectangle(frame, group, details) {
  const span = details.dimension * frame.upsampling, x = group % details.columns * span, y = Math.floor(group / details.columns) * span;
  return {x: frame.x0 + x, y: frame.y0 + y, width: Math.min(span, frame.width - x), height: Math.min(span, frame.height - y)};
}

export function admitRegion(frame, region, image) {
  if (frame.dcLevel) throw invalid('Region delivery takes an image or preview frame; use sectionOrder for LF frames.');
  if (!region || typeof region !== 'object' || Array.isArray(region)) throw invalid('region is {x, y, width, height} in canvas pixels.');
  for (const [key, minimum] of [['x', 0], ['y', 0], ['width', 1], ['height', 1]])
    if (!Number.isSafeInteger(region[key]) || region[key] < minimum) throw invalid('region is whole nonnegative coordinates and positive size.');
  if (region.x + region.width > image.width || region.y + region.height > image.height) throw invalid('region lies outside the canvas.');
}

export function regionOrder(frame, region, strategy) {
  if (frame.sizes.length === 1) return [0];
  const details = grid(frame), span = details.dimension * frame.upsampling, groups = [], centerX = region.x + region.width / 2, centerY = region.y + region.height / 2;
  for (let group = 0; group < details.groups; group++) {
    const info = groupRectangle(frame, group, details);
    const intersects = info.x < region.x + region.width && info.x + info.width > region.x && info.y < region.y + region.height && info.y + info.height > region.y;
    const halo = !intersects && info.x < region.x + region.width + span && info.x + info.width > region.x - span &&
      info.y < region.y + region.height + span && info.y + info.height > region.y - span;
    const dx = info.x + info.width / 2 - centerX, dy = info.y + info.height / 2 - centerY;
    groups.push({group, intersects, halo, distance: dx * dx + dy * dy});
  }
  groups.sort((a, b) => Number(b.intersects) - Number(a.intersects) || Number(b.halo) - Number(a.halo) || a.distance - b.distance || a.group - b.group);
  const firstAC = details.dcGroups + 2, order = Array.from({length: firstAC}, (_, i) => i);
  if (strategy === 'region-first') {
    for (const value of groups) if (value.intersects || value.halo) for (let pass = 0; pass < frame.passes; pass++) order.push(firstAC + pass * details.groups + value.group);
    for (let pass = 0; pass < frame.passes; pass++) for (const value of groups) if (!value.intersects && !value.halo) order.push(firstAC + pass * details.groups + value.group);
  } else for (let pass = 0; pass < frame.passes; pass++) for (const value of groups) order.push(firstAC + pass * details.groups + value.group);
  return order;
}
