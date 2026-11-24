// SPDX-License-Identifier: MIT
export const GPU_FROM = 7;
export const CAPTURE_LEAN = Object.freeze({top: 5, next: 'jpegxl/capture-complete', gpu: false});
export const CAPTURE_UPLOAD = /* @__PURE__ */ Object.freeze({top: 3, next: 'jpegxl/capture-complete', gpu: false});
export const CAPTURE_COMPLETE = /* @__PURE__ */ Object.freeze({top: 9, next: null, gpu: true});
export const carriedBy = (module, tier) => Object.freeze({module, ...tier});
