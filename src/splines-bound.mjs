// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';
export const splineCurveLimit = (width, height) => Math.min(1048576, Math.floor(width * height / 2), Math.floor(width * height / 4));
const TOO_MANY = 'Too many splines: at most one per four pixels.';
export function admitSplineCount(count, width, height) {
  if (count > splineCurveLimit(width, height)) throw fault('JXL_INPUT', TOO_MANY);
}
export function admitFormatRequest(operation, input) {
  if (operation !== 'format' || !input || typeof input !== 'object') return;
  const field = key => { try { const d = Object.getOwnPropertyDescriptor(input, key); return d && 'value' in d ? d.value : undefined; } catch { return undefined; } };
  const splines = field('splines'), width = field('width'), height = field('height');
  if (field('kind') !== 'splines' || !Array.isArray(splines) || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return;
  admitSplineCount(splines.length, width, height);
}
