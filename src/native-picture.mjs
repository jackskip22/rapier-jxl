// SPDX-License-Identifier: MIT
import {admitSize, fault} from './admit.mjs';
import {EDGE, LIMITS} from './limits.mjs';

const GL_METHODS = ['isContextLost', 'getParameter', 'createTexture', 'createFramebuffer', 'bindTexture', 'bindFramebuffer',
  'pixelStorei', 'texImage2D', 'framebufferTexture2D', 'checkFramebufferStatus', 'readPixels', 'getError', 'deleteTexture',
  'deleteFramebuffer'];
const platform = (message, cause) => Object.assign(fault('JXL_PLATFORM', message), {cause});

export const NATIVE_PICTURE_OPTIONS = {colorSpaceConversion:'none',premultiplyAlpha:'none',imageOrientation:'from-image'};
export function nativePicture(bytes, options = {}) {
  return nativePictureWith(bytes,options,(makeBitmap,BlobType) => {
    const blob = new BlobType([bytes],{type:'image/jxl'});
    return () => makeBitmap.call(globalThis,blob,NATIVE_PICTURE_OPTIONS);
  });
}

export async function nativePictureWith(bytes, options, prepare) {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw fault('JXL_INPUT', 'Native picture options are an object.');
  const {width, height, colorSpace = 'srgb', signal, maxPixels = LIMITS.pixels, orientation = 1,
    sampleFormat = 'uint', bitDepth = 8, alphaPremultiplied = false, animation = false, ...other} = options;
  if (signal?.aborted) throw signal.reason;
  if (!(bytes instanceof Uint8Array) || !bytes.length)
    throw fault('JXL_INPUT', 'Native picture bytes are a nonempty Uint8Array.');
  if (!Number.isSafeInteger(maxPixels) || maxPixels < 1)
    throw fault('JXL_INPUT', 'Native picture maxPixels is a positive whole number.');
  admitSize(width, height, {pixels: maxPixels, edge: EDGE});
  if (!['srgb', 'display-p3'].includes(colorSpace) || orientation !== 1 || sampleFormat !== 'uint' ||
      bitDepth !== 8 || alphaPremultiplied !== false || animation !== false || Object.keys(other).length)
    throw platform('Native picture readback supports only orientation-1 still RGB8, unassociated alpha, and sRGB or Display-P3; other sample, color, ICC and animation metadata is unsupported.');
  if (signal != null && (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function'))
    throw fault('JXL_INPUT', 'Native picture signal must support abort events.');
  const makeBitmap = globalThis.createImageBitmap, Canvas = globalThis.OffscreenCanvas, BlobType = globalThis.Blob;
  if (typeof makeBitmap !== 'function' || typeof Canvas !== 'function' || typeof BlobType !== 'function')
    throw fault('JXL_UNSUPPORTED', 'Measuring a photo needs a browser that decodes JPEG XL (createImageBitmap and OffscreenCanvas). Use effort 3 or lower here.');

  let bitmap, canvas, context, texture, framebuffer, result, failure, failed = false, listening = false;
  const remember = error => { if (!failed) { failed = true; failure = error; } };
  const abort = () => { try { remember(signal.reason); } catch (error) { remember(error); } };
  const check = () => { if (!failed && signal?.aborted) abort(); if (failed) throw failure; };
  const native = (message, work) => {
    try { return work(); } catch (cause) { throw platform(message, cause); }
  };
  const release = (message, work) => {
    try { work(); } catch (cause) { remember(platform(message, cause)); }
  };
  try {
    if (signal) { listening = true; signal.addEventListener('abort', abort, {once: true}); }
    check();
    const acquire = native('Native picture bytes could not be placed in a Blob.', () => prepare(makeBitmap,BlobType));
    check();
    try {
      bitmap = await acquire();
    } catch (cause) { remember(platform('This browser could not decode the JPEG XL file.', cause)); }
    check();
    if (!bitmap || typeof bitmap.close !== 'function') throw platform('Native JPEG XL decoding did not return a closable ImageBitmap.');
    const shape = native('Native picture dimensions could not be read.', () => [bitmap.width, bitmap.height]);
    if (shape[0] !== width || shape[1] !== height)
      throw fault('JXL_DIMENSIONS', 'Native picture dimensions differ from the admitted still producer.');
    canvas = native('This realm could not allocate the native picture canvas.', () => new Canvas(1, 1));
    check();
    const gl = native('This realm could not create the native picture WebGL2 context.',
      () => canvas.getContext('webgl2', {alpha: true, premultipliedAlpha: false, antialias: false, depth: false, stencil: false}));
    context = gl;
    if (!gl || GL_METHODS.some(name => typeof gl[name] !== 'function'))
      throw platform('Native picture readback needs a WebGL2 context.');
    if (native('Native picture context loss state could not be read.', () => gl.isContextLost()) !== false)
      throw platform('The native picture WebGL2 context is lost.');
    const data = new Uint8ClampedArray(width * height * 4);
    native('The native JPEG XL picture could not be read back.', () => {
      const side = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), 4096);
      if (!Number.isSafeInteger(side) || side < 1) throw new Error('No texture size.');
      texture = gl.createTexture(); framebuffer = gl.createFramebuffer();
      gl.bindTexture(gl.TEXTURE_2D, texture); gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.PACK_ALIGNMENT, 1); gl.pixelStorei(gl.PACK_ROW_LENGTH, width);
      for (let y = 0; y < height; y += side) for (let x = 0; x < width; x += side) {
        const w = Math.min(side, width - x), h = Math.min(side, height - y);
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x); gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Incomplete framebuffer.');
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data, (y * width + x) * 4);
      }
      const error = gl.getError();
      if (error !== gl.NO_ERROR) throw new Error('WebGL error ' + error + '.');
    });
    check();
    if (native('Native picture context loss state could not be read.', () => gl.isContextLost()) !== false)
      throw platform('The native picture WebGL2 context was lost during readback.');
    result = {data, width, height, colorSpace, sampleFormat: 'uint', bitDepth: 8, alphaPremultiplied: false};
  } catch (error) { remember(error); }
  finally {
    if (bitmap) release('The native picture ImageBitmap could not be closed.', () => bitmap.close());
    if (texture) release('The native picture texture could not be deleted.', () => context.deleteTexture(texture));
    if (framebuffer) release('The native picture framebuffer could not be deleted.', () => context.deleteFramebuffer(framebuffer));
    if (canvas) {
      release('The native picture canvas width could not be released.', () => { canvas.width = 0; });
      release('The native picture canvas height could not be released.', () => { canvas.height = 0; });
    }
    if (listening) release('The native picture abort listener could not be removed.', () => signal.removeEventListener('abort', abort));
  }
  check();
  return result;
}

const KNOWN = Uint8Array.of(255, 10, 0, 0, 0, 128, 160, 184, 17, 8, 2, 1, 0, 52, 0, 75, 24, 139, 13, 81, 2, 86, 128, 112, 18, 35, 7, 0);
let support = null;
export function decodesJXL() {
  const api = globalThis.createImageBitmap;
  if (!support || support.api !== api) support = {api, reads: typeof api !== 'function' || typeof globalThis.OffscreenCanvas !== 'function' ||
    typeof globalThis.Blob !== 'function' ? Promise.resolve(false) : nativePicture(KNOWN, {width: 1, height: 1}).then(() => true, () => false)};
  return support.reads;
}
