// SPDX-License-Identifier: MIT
export const BROWSER_MARGIN = Object.freeze([Object.freeze({upTo: 81.5, margin: 0.0115}), Object.freeze({upTo: Infinity, margin: 0.0616})]);
export const browserMargin = target => BROWSER_MARGIN.find(band => target <= band.upTo).margin;
export const measuredTarget = target => Math.min(100, target + browserMargin(target));
