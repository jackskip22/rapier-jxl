// SPDX-License-Identifier: MIT
export const JPEG_SOURCE = /* @__PURE__ */ Symbol.for('rapier-jxl.jpeg-source');
export const JPEG_SOURCE_WIRE = 'originalJpegSource';
export const jpegRequestedIntent = ({quality, qualityIntent}) => quality === 100 ? 1 : qualityIntent ?? quality / 100;
export function jpegChoiceMode(info, {quality, effort}, options = {}) {
  if (options.jpeg === 'pixels' || options.readAs !== undefined || options.features !== undefined) return 'pixels';
  if (quality === 100) return 'jpeg';
  return effort >= 6 ? 'weigh' : 'pixels';
}

export function jpegWins(exact, pixels, facts = {}, maxBytes, maxIntent) {
  if (!exact || maxBytes !== undefined && exact.byteLength > maxBytes) return false;
  if (!pixels || facts.meetsTarget === false || facts.measurements?.some(value =>
    value.score !== undefined && (!Number.isFinite(value.score) || value.floor !== undefined && value.score < value.floor ||
      value.limit !== undefined && value.score > value.limit))) return true;
  if (maxBytes !== undefined && maxIntent !== undefined && facts.fidelity !== 'exact' &&
      !(facts.fidelity?.quality / 100 >= maxIntent)) return true;
  return exact.byteLength <= pixels.byteLength;
}
