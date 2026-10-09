// SPDX-License-Identifier: MIT
// Worker request admission, defaults, errors and transferable replies.
import {JPEG_XL_LIMITS, codecError, byteView, boundedDimensions} from './worker-input.mjs';

export function createJPEGXLCodec({encoderFactory}) {
  if (typeof document !== 'undefined') throw codecError('JXL_THREAD_REQUIRED', 'JPEG XL must run in an image worker.');
  let encoder;
  let stage = 'starting';
  const concise = value => String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 512);
  return Object.freeze({
    async encode(image, options = {}) {
      stage = 'checking image';
      const {width, height} = boundedDimensions(image?.width, image?.height);
      const data = image.data instanceof Uint16Array || image.data instanceof Float32Array ? image.data : byteView(image.data);
      if (data.length !== width * height * 4) throw codecError('JXL_RGBA', 'JPEG XL encoding requires one RGBA value per pixel.');
      if (!options || typeof options !== 'object' || Array.isArray(options)) throw codecError('JXL_OPTIONS', 'JPEG XL options are invalid.');
      const lossless = options.lossless === true, quality = lossless ? 100 : options.quality ?? 90, effort = options.effort ?? 9;
      if (!Number.isFinite(quality) || quality < 1 || quality > 100 || !Number.isInteger(effort) || effort < 1 || effort > 9) throw codecError('JXL_OPTIONS', 'JPEG XL quality must be 1–100 and effort 1–9.');
      if (typeof encoderFactory !== 'function') throw codecError('JXL_UNAVAILABLE', 'The bundled JPEG XL codec is unavailable.');
      stage = 'starting encoder';
      encoder ||= encoderFactory();
      stage = 'encoding image';
      return encoder.encode(data, width, height, {...options, quality, effort, photo: options.photo === true});
    },
    async transcode(input) {
      stage = 'checking image';
      const jpeg = byteView(input?.bytes);
      if (!jpeg.byteLength || jpeg.byteLength > JPEG_XL_LIMITS.bytes) throw codecError('JXL_INPUT', 'The JPEG is empty or exceeds 16 MiB.');
      if (typeof encoderFactory !== 'function') throw codecError('JXL_UNAVAILABLE', 'The bundled JPEG XL codec is unavailable.');
      stage = 'starting encoder';
      encoder ||= encoderFactory();
      stage = 'carrying the JPEG';
      return encoder.transcode(jpeg);
    },
    // Reply to a parallel group request using the shared encoder's transfer list.
    serve(message) {
      if (typeof encoderFactory !== 'function') return null;
      encoder ||= encoderFactory();
      return encoder.serve(message);
    },
    // No decode: browsers read JPEG XL themselves.
    failure(error) {
      const reason = concise((error?.name && error.name !== 'Error' ? error.name + ': ' : '') + String(error?.message || error || '')) ||
        'The codec returned no failure details.';
      const detail = reason;
      const allocation = error instanceof RangeError || /out of memory|allocation failed|Array buffer allocation/i.test(detail);
      const code = concise(error?.code) || (allocation ? 'JXL_MEMORY' :
        stage.startsWith('starting') ? 'JXL_INITIALIZE' : stage === 'encoding image' ? 'JXL_ENCODE' : stage === 'carrying the JPEG' ? 'JXL_JPEG' : 'JXL_CODEC');
      const message = error?.code ? reason : allocation ? 'JPEG XL could not allocate enough memory for this image.' :
        stage.startsWith('starting') ? 'Rapier could not start its bundled JPEG XL codec.' :
        stage === 'encoding image' ? 'JPEG XL could not encode this image.' :
        stage === 'carrying the JPEG' ? 'This JPEG could not be carried into JPEG XL.' :
        'JPEG XL image processing failed.';
      return {code, stage, detail, message: message + (!error?.code ? '\n\nDetails (' + stage + '): ' + detail : '')};
    }
  });
}

export function installJPEGXLWorker(configuration) {
  const codec = createJPEGXLCodec(configuration);
  let busy = false;
  globalThis.onmessage = async ({data: request}) => {
    if (request?.pool) { const reply = codec.serve(request); if (reply) globalThis.postMessage(...reply); return; }
    const id = request?.id;
    if ((typeof id !== 'number' && typeof id !== 'string') || String(id).length > 128) return;
    if (busy) {
      globalThis.postMessage({id, ok: false, error: {code: 'JXL_BUSY', message: 'The image worker is busy.'}});
      return;
    }
    busy = true;
    try {
      if (request.operation === 'encode') {
        // Asked for with `progress: true`: how far the encode is, from 0 to 1, a reply of its own each hundredth.
        let reported = 0, at = 0;
        const progress = request.progress === true ? value => {
          const now = Date.now();
          if (typeof value !== 'number' || !(value > reported) || value < 1 && (value - reported < 0.01 || now - at < 100)) return;
          reported = value; at = now;
          globalThis.postMessage({id, progress: value});
        } : undefined;
        const bytes = await codec.encode({width: request.width, height: request.height, data: request.data}, progress ? {...request.options, progress} : request.options);
        globalThis.postMessage({id, ok: true, bytes}, [bytes.buffer]);
      } else if (request.operation === 'transcode') {
        const carried = await codec.transcode({bytes: request.bytes});
        globalThis.postMessage({id, ok: true, ...carried}, [carried.bytes.buffer]);
      } else throw codecError('JXL_OPERATION', 'Unknown JPEG XL operation.');
    } catch (error) {
      globalThis.postMessage({id, ok: false, error: codec.failure(error)});
    } finally {
      busy = false;
    }
  };
}
