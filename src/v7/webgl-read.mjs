// SPDX-License-Identifier: MIT
import {fail} from './primitives.mjs';

const PACK = [0x0d05, 0x0d02, 0x0d03, 0x0d04];

function isWebGL2(gl) {
  return typeof WebGL2RenderingContext === 'function' && gl instanceof WebGL2RenderingContext;
}

function context(canvas) {
  for (const id of ['webgl2', 'webgl', 'experimental-webgl']) {
    let gl; try { gl = canvas.getContext(id); } catch {}
    if (gl && !gl.isContextLost() && gl.drawingBufferWidth === canvas.width && gl.drawingBufferHeight === canvas.height)
      return gl;
  }
  return null;
}
function packed(gl, buffer, read) {
  const saved = [gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING), gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), PACK.map(p => gl.getParameter(p))];
  try {
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    PACK.forEach((p, i) => gl.pixelStorei(p, i ? 0 : 4));
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
    return read();
  } finally {
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, saved[0]); gl.bindFramebuffer(gl.READ_FRAMEBUFFER, saved[1]);
    PACK.forEach((p, i) => gl.pixelStorei(p, saved[2][i]));
  }
}
function packedWebGL1(gl, read) {
  const savedFb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
  const align = gl.getParameter(gl.PACK_ALIGNMENT);
  try {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 4);
    return read();
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, savedFb);
    gl.pixelStorei(gl.PACK_ALIGNMENT, align);
  }
}
function straighten(data, {alpha, premultipliedAlpha}) {
  if (!alpha) for (let i = 3; i < data.length; i += 4) data[i] = 255;
  else if (premultipliedAlpha) for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a && a < 255) for (let c = i; c < i + 3; c++) data[c] = Math.min(255, Math.round(data[c] * 255 / a));
  }
}
function place(data, rows, y0, count, width, height, attrs) {
  const line = width * 4;
  for (let r = 0; r < count; r++) data.set(rows.subarray(r * line, (r + 1) * line), (height - 1 - y0 - r) * line);
  straighten(data.subarray((height - y0 - count) * line, (height - y0) * line), attrs);
}
const space = gl => gl.drawingBufferColorSpace ?? 'srgb', lost = () => fail('JXL_INPUT', 'The canvas lost its WebGL context; draw it again.');

export function readWebGLNow(canvas) {
  const gl = context(canvas);
  if (!gl) return null;
  const {width, height} = canvas, rows = new Uint8Array(width * height * 4), data = new Uint8Array(rows.length);
  if (isWebGL2(gl)) packed(gl, null, () => gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rows));
  else packedWebGL1(gl, () => gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rows));
  if (gl.isContextLost()) throw lost();
  place(data, rows, 0, height, width, height, gl.getContextAttributes());
  return {data, width, height, colorSpace: space(gl)};
}

export function readWebGL(canvas) {
  const gl = context(canvas);
  if (!gl) return null;
  if (!isWebGL2(gl)) {
    const now = readWebGLNow(canvas);
    if (!now) throw lost();
    return Promise.resolve(now);
  }
  const {width, height} = canvas, line = width * 4, slice = Math.max(1, Math.floor(2097152 / line));
  const colorSpace = space(gl), attrs = gl.getContextAttributes();
  const data = new Uint8Array(width * height * 4), part = new Uint8Array(Math.min(height, slice) * line);
  let buffer = null, fence = null;
  const done = () => { try { if (fence) gl.deleteSync(fence); if (buffer) gl.deleteBuffer(buffer); } catch {} };
  try {
    buffer = gl.createBuffer();
    fence = packed(gl, buffer, () => {
      gl.bufferData(gl.PIXEL_PACK_BUFFER, width * height * 4, gl.STREAM_READ);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      const made = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      return made;
    });
    if (!fence) throw new Error('no fence');
  } catch (cause) { done(); throw Object.assign(fail('JXL_INPUT', 'The WebGL canvas could not be read: ' + (cause?.message || cause)), {cause}); }
  return new Promise((resolve, reject) => {
    const poll = () => {
      try {
        if (gl.isContextLost()) { done(); reject(lost()); return; }
        const state = gl.clientWaitSync(fence, 0, 0);
        if (state === gl.TIMEOUT_EXPIRED) { setTimeout(poll, 2); return; }
        if (state === gl.WAIT_FAILED) throw new Error('the copy did not complete');
        fetch(0);
      } catch (cause) { failed(cause); }
    };
    const fetch = y0 => {
      try {
        if (gl.isContextLost()) { done(); reject(lost()); return; }
        const count = Math.min(slice, height - y0);
        packed(gl, buffer, () => gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, y0 * line, part, 0, count * line));
        place(data, part, y0, count, width, height, attrs);
        if (y0 + count < height) { setTimeout(fetch, 0, y0 + count); return; }
        done();
        resolve({data, width, height, colorSpace});
      } catch (cause) { failed(cause); }
    };
    const failed = cause => { done(); reject(Object.assign(fail('JXL_INPUT', 'The WebGL canvas could not be read: ' + (cause?.message || cause)), {cause})); };
    poll();
  });
}
