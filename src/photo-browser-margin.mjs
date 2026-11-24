// SPDX-License-Identifier: MIT
export const BROWSER_MARGIN = /* @__PURE__ */ Object.freeze([/* @__PURE__ */ Object.freeze({upTo: 81.5, margin: 0.0115}), /* @__PURE__ */ Object.freeze({upTo: 86, margin: 0.0616}),
  /* @__PURE__ */ Object.freeze({upTo: Infinity, margin: 0.131})]);
export const browserMargin = target => BROWSER_MARGIN.find(band => target <= band.upTo).margin;
export const measuredTarget = target => Math.min(100, target + browserMargin(target));
export const DJXL_RESIDUAL = /* @__PURE__ */ Object.freeze([
  /* @__PURE__ */ Object.freeze({pixels: 1000, margins: [0.01, 0.01, 0.01]}),
  /* @__PURE__ */ Object.freeze({pixels: 10000, margins: [0.02, 0.02, 0.06]}),
  /* @__PURE__ */ Object.freeze({pixels: Infinity, margins: [0.04, 0.08, 0.15]})]);
export const djxlResidual = (score, pixels) => DJXL_RESIDUAL.find(row => pixels < row.pixels).margins[score <= 81.5 ? 0 : score <= 86 ? 1 : 2];
