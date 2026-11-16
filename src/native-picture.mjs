// SPDX-License-Identifier: MIT
import {admitSize, fault} from './admit.mjs';
import {EDGE, LIMITS} from './limits.mjs';

const GL_METHODS = ['isContextLost', 'getParameter', 'createTexture', 'createFramebuffer', 'bindTexture', 'bindFramebuffer',
  'pixelStorei', 'texImage2D', 'framebufferTexture2D', 'checkFramebufferStatus', 'readPixels', 'getError', 'deleteTexture',
  'deleteFramebuffer'];
const platform = (message, cause) => Object.assign(fault('JXL_PLATFORM', message), {cause});

export const NATIVE_PICTURE_OPTIONS = {colorSpaceConversion:'none',premultiplyAlpha:'none',imageOrientation:'from-image'};
const bitmapOf = (makeBitmap, blob) => makeBitmap.call(globalThis, blob, NATIVE_PICTURE_OPTIONS);
async function imageOf(blob) {
  const url = URL.createObjectURL(blob), image = new Image();
  try { image.src = url; await image.decode(); } finally { URL.revokeObjectURL(url); }
  return {image, width: image.naturalWidth, height: image.naturalHeight, close: () => image.removeAttribute('src')};
}
const route = image => bytes => (makeBitmap, BlobType) => {
  const blob = new BlobType([bytes], {type: 'image/jxl'});
  return image ? () => imageOf(blob) : () => bitmapOf(makeBitmap, blob);
};
const byBitmap = route(false), byImage = route(true);
export function nativePicture(bytes, options = {}) {
  return nativePictureWith(bytes,options,(makeBitmap,BlobType) => {
    const blob = new BlobType([bytes],{type:'image/jxl'});
    if (typeof globalThis.Image !== 'function') return () => bitmapOf(makeBitmap, blob);
    const p3 = options.colorSpace === 'display-p3', alpha = options.alpha !== false;
    return async () => {
      const keeps = await nativeKeeps();
      return keeps.image && (p3 && !keeps.bitmap.displayP3 || alpha && !keeps.bitmap.alpha) ? imageOf(blob) : bitmapOf(makeBitmap, blob);
    };
  });
}

export async function nativePictureWith(bytes, options, prepare) {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw fault('JXL_INPUT', 'Native picture options are an object.');
  const {width, height, colorSpace = 'srgb', signal, maxPixels = LIMITS.pixels, orientation = 1,
    sampleFormat = 'uint', bitDepth = 8, alphaPremultiplied = false, animation = false, alpha, ...other} = options;
  if (signal?.aborted) throw signal.reason;
  if (!(bytes instanceof Uint8Array) || !bytes.length)
    throw fault('JXL_INPUT', 'Native picture bytes are a nonempty Uint8Array.');
  if (!Number.isSafeInteger(maxPixels) || maxPixels < 1)
    throw fault('JXL_INPUT', 'Native picture maxPixels is a positive whole number.');
  admitSize(width, height, {pixels: maxPixels, edge: EDGE});
  if (!['srgb', 'display-p3'].includes(colorSpace) || orientation !== 1 || sampleFormat !== 'uint' ||
      bitDepth !== 8 || alphaPremultiplied !== false || animation !== false || ![undefined, true, false].includes(alpha) || Object.keys(other).length)
    throw platform('Native picture readback supports only orientation-1 still RGB8, unassociated alpha, and sRGB or Display-P3; other sample, color, ICC and animation metadata is unsupported.');
  if (signal != null && (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function'))
    throw fault('JXL_INPUT', 'Native picture signal must support abort events.');
  const makeBitmap = globalThis.createImageBitmap, Canvas = globalThis.OffscreenCanvas, BlobType = globalThis.Blob;
  if (typeof makeBitmap !== 'function' || typeof Canvas !== 'function' || typeof BlobType !== 'function')
    throw fault('JXL_PLATFORM', 'Measuring a photo needs a browser that decodes JPEG XL (createImageBitmap and OffscreenCanvas). Use effort 3 or lower here.');

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
    if (!gl) {
      if (colorSpace !== 'srgb') throw platform('Reading back a Display P3 JPEG XL decode needs WebGL2, which this realm lacks.');
      context = null; native('The native picture canvas could not be sized.', () => { canvas.width = width; canvas.height = height; });
      const flat = native('This realm could not create the native picture 2D context.', () => canvas.getContext('2d', {willReadFrequently: true}));
      if (!flat || typeof flat.drawImage !== 'function' || typeof flat.getImageData !== 'function')
        throw platform('Native picture readback needs a WebGL2 or a 2D context.');
      const data = native('The native JPEG XL picture could not be read back.', () => {
        flat.drawImage(bitmap.image ?? bitmap, 0, 0);
        return flat.getImageData(0, 0, width, height).data;
      });
      for (let i = 3; i < data.length; i += 4) if (data[i] !== 255)
        throw platform('Reading back a JPEG XL decode with transparency needs WebGL2, which this realm lacks.');
      check();
      result = {data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width, height, colorSpace, sampleFormat: 'uint', bitDepth: 8, alphaPremultiplied: false};
    } else {
      if (GL_METHODS.some(name => typeof gl[name] !== 'function'))
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
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, bitmap.image ?? bitmap);
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
    }
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
  if (!support || support.api !== api) {
    const state = support = {api, reads: typeof api !== 'function' || typeof globalThis.OffscreenCanvas !== 'function' ||
      typeof globalThis.Blob !== 'function' ? Promise.resolve(false) : nativePictureWith(KNOWN, {width: 1, height: 1}, byBitmap(KNOWN)).then(() => true, () => false)};
    state.reads = state.reads.then(reads => { if (!reads && support === state) support = null; return reads; });
  }
  return support.reads;
}

const KNOWN_ALPHA = Uint8Array.of(255, 10, 0, 0, 0, 128, 149, 8, 24, 16, 0, 92, 0, 75, 56, 65, 118, 224, 226, 160, 140, 44, 65, 1,
  224, 72, 120, 36, 20, 146, 40, 1, 123, 1, 130, 56);
const KNOWN_P3 = Uint8Array.of(255, 10, 0, 0, 0, 128, 128, 76, 110, 4, 8, 6, 1, 0, 80, 0, 75, 56, 65, 110, 224, 244, 68, 14, 79, 18, 20, 9,
  131, 36, 74, 192, 46, 64, 16, 7);
const NOTHING = Object.freeze({alpha: false, displayP3: false, image: false});
async function keeps(read, image) {
  const holds = (bytes, colorSpace, a) => nativePictureWith(bytes, {width: 1, height: 1, colorSpace}, read(bytes))
    .then(({data}) => data[0] === 200 && data[1] === 100 && data[2] === 50 && data[3] === a);
  return {alpha: await holds(KNOWN_ALPHA, 'srgb', 128), displayP3: await holds(KNOWN_P3, 'display-p3', 255), image};
}
let kept = null;
export function nativeKeeps() {
  const api = globalThis.createImageBitmap;
  if (!kept || kept.api !== api) {
    const state = kept = {api, reads: null};
    const unavailable = () => { if (kept === state) kept = null; return {...NOTHING, bitmap: NOTHING}; };
    state.reads = decodesJXL().then(async reads => {
      if (!reads) return unavailable();
      const bitmap = await keeps(byBitmap, false);
      if (bitmap.alpha && bitmap.displayP3 || typeof globalThis.Image !== 'function' || typeof URL.createObjectURL !== 'function')
        return {...bitmap, bitmap};
      const image = await keeps(byImage, true);
      return image.alpha + image.displayP3 > bitmap.alpha + bitmap.displayP3 ? {...image, bitmap} : {...bitmap, bitmap};
    }).catch(unavailable);
  }
  return kept.reads;
}
