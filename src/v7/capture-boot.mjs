import {encodeCaptureBytes} from '../capture-codec.mjs';
export {encodeCaptureBytes};
export {compileCaptureKernels} from '../capture-kernels.mjs';
export {image} from './input.mjs';
export {configureModules} from '../wasm-modules.mjs';

let warmed = false;
export function warmCapture() {
  if (warmed) return;
  warmed = true;
  const page = new Uint8Array(1100 * 24 * 4), patch = new Uint8Array(48 * 48 * 4);
  for (let y = 0, at = 0; y < 24; y++) for (let x = 0; x < 1100; x++, at += 4) {
    const ink = y % 24 > 6 && y % 24 < 18 && x % 12 < 5, soft = (x * 7 + y * 3) % 61;
    page[at] = page[at + 1] = page[at + 2] = ink ? 30 + (x % 12) * 9 : 250 - (y % 24 === 20 ? soft : 0); page[at + 3] = 255;
  }
  for (let at = 0, seed = 1; at < patch.length; at += 4) {
    seed = Math.imul(seed, 1103515245) + 12345 >>> 0;
    patch[at] = seed >>> 24; patch[at + 1] = seed >>> 16 & 255; patch[at + 2] = (at >> 6) & 255; patch[at + 3] = 255;
  }
  try { encodeCaptureBytes(page, 1100, 24); encodeCaptureBytes(patch, 48, 48); } catch {}
}
