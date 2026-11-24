// SPDX-License-Identifier: MIT
const SIMD = /* @__PURE__ */ Uint8Array.of(0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11);
export const simd = () => { try { return typeof WebAssembly === 'object' && WebAssembly.validate(SIMD); } catch { return false; } };
