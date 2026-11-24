// SPDX-License-Identifier: MIT
import {fail, proveRead, lostBlank, LOST} from './primitives.mjs';
import {withCost} from './ownership.mjs';

export function open2d(canvas, message = 'canvas 2D: OffscreenCanvas or RGBA pixels') {
  try { return canvas.getContext('2d', {willReadFrequently: true}); }
  catch (cause) { throw Object.assign(fail('JXL_INPUT', message), {cause}); }
}

export function glGpuSpace(canvas, lostMessage = LOST, missingMessage = 'canvas context: 2D, WebGL or WebGPU') {
  for (const id of ['webgl2', 'webgl', 'webgpu']) {
    let c; try { c = canvas.getContext(id); } catch {}
    if (c?.isContextLost?.()) throw fail('JXL_INPUT', lostMessage);
    if (c) return c.drawingBufferColorSpace ?? c.getConfiguration?.()?.colorSpace ?? 'srgb';
  }
  throw fail('JXL_INPUT', missingMessage);
}

export function copy2d(from, width, height, colorSpace, onCanvas) {
  const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(width, height) : document.createElement('canvas');
  onCanvas?.(canvas);
  canvas.width = width; canvas.height = height;
  const drawn = canvas.getContext('2d', {willReadFrequently: true, colorSpace});
  if (!drawn) throw fail('JXL_PLATFORM', 'no 2D canvas: pass RGBA pixels');
  drawn.drawImage(from, 0, 0);
  return {canvas, drawn};
}

export function read2d(context, width, height, requested, half, message = 'canvas read: redraw or RGBA pixels') {
  const colorSpace = requested ?? context.getContextAttributes?.().colorSpace ?? 'srgb';
  proveRead(context);
  let pixels;
  try { pixels = context.getImageData(0, 0, width, height, half ? {colorSpace, pixelFormat: 'rgba-float16'} : {colorSpace}); }
  catch (cause) { throw Object.assign(fail('JXL_INPUT', message), {cause}); }
  if (lostBlank(context, pixels.data)) throw fail('JXL_INPUT', LOST);
  const halfRead = half && pixels.data.BYTES_PER_ELEMENT === 2;
  const data = halfRead ? new Uint16Array(pixels.data.buffer, pixels.data.byteOffset, pixels.data.length) : pixels.data;
  withCost(data, data.byteLength);
  return {data, width, height, colorSpace: pixels.colorSpace ?? 'srgb', ...(halfRead && {transferFunction: 'srgb', sampleFormat: 'float16'})};
}
