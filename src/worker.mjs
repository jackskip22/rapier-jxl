// SPDX-License-Identifier: MIT
import {JPEG_XL_LIMITS, codecError, byteView, boundedDimensions} from './worker-input.mjs';
import {checkSignal} from './async-job.mjs';

const PRESETS = {web: [85, 3, true], photo: [90, 7, true], archive: [100, 9, false], screen: [100, 5, false], lossless: [100, 3, false]};

function choices(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw codecError('JXL_OPTIONS', 'JPEG XL options are invalid.');
  if (options.preset !== undefined && (typeof options.preset !== 'string' || !Object.hasOwn(PRESETS, options.preset)))
    throw codecError('JXL_OPTIONS', 'JPEG XL preset must be web, photo, archive, screen or lossless.');
  const preset = PRESETS[options.preset] || [90, 7, true];
  const lossless = options.lossless === true, quality = lossless ? 100 : options.quality ?? preset[0], effort = options.effort ?? preset[1];
  if (!Number.isFinite(quality) || quality < 1 || quality > 100 || !Number.isInteger(effort) || effort < 1 || effort > 9) throw codecError('JXL_OPTIONS', 'JPEG XL quality must be 1–100 and effort 1–9.');
  return {quality, effort, preset, photo: options.photo ?? (options.preset ? preset[2] : undefined)};
}

export function createJPEGXLCodec({encoderFactory, imageReader, formatHandler}) {
  if (typeof document !== 'undefined') throw codecError('JXL_THREAD_REQUIRED', 'JPEG XL must run in an image worker.');
  let encoder;
  let stage = 'starting';
  const concise = value => String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 512);
  const codec = Object.freeze({
    async encode(image, options = {}) {
      stage = 'checking image';
      const {width, height} = boundedDimensions(image?.width, image?.height);
      const data = image.data instanceof Uint16Array || image.data instanceof Float32Array ? image.data : byteView(image.data);
      if (data.length !== width * height * 4) throw codecError('JXL_RGBA', 'JPEG XL encoding requires one RGBA value per pixel.');
      const {quality, effort, photo, preset} = choices(options);
      if (typeof encoderFactory !== 'function') throw codecError('JXL_UNAVAILABLE', 'The bundled JPEG XL codec is unavailable.');
      stage = 'starting encoder';
      encoder ||= encoderFactory();
      stage = 'encoding image';
      return encoder.encode(data, width, height, {...options, quality, effort, photo: (photo ?? preset[2]) === true});
    },
    async animation(input, options = {}) {
      stage = 'checking image';
      if (input?.options && typeof input.options === 'object') options = {...input.options, ...options};
      const {width, height} = boundedDimensions(input?.width, input?.height);
      if (!Array.isArray(input.frames) || !input.frames.length) throw codecError('JXL_INPUT', 'An animation has at least one frame.');
      const frames = input.frames.map(frame => {
        const data = frame?.data instanceof Uint16Array || frame?.data instanceof Float32Array ? frame.data : byteView(frame?.data);
        if (data.length !== width * height * 4) throw codecError('JXL_RGBA', 'JPEG XL encoding requires one RGBA value per pixel.');
        return {data, duration: frame.duration};
      });
      const {quality, effort, photo} = choices(options);
      if (typeof encoderFactory !== 'function') throw codecError('JXL_UNAVAILABLE', 'The bundled JPEG XL codec is unavailable.');
      stage = 'starting encoder';
      encoder ||= encoderFactory();
      if (typeof encoder.animation !== 'function') throw codecError('JXL_UNAVAILABLE', 'Animation needs JPEG XL complete.');
      stage = 'encoding image';
      return encoder.animation({width, height, loops: input.loops ?? 0, frames}, {...options, quality, effort, ...(photo === undefined ? {} : {photo})});
    },
    async transcode(input, options = {}) {
      stage = 'checking image';
      const jpeg = byteView(input?.bytes);
      if (!jpeg.byteLength) throw codecError('JXL_INPUT', 'The JPEG is empty.');
      if (!options || typeof options !== 'object' || Array.isArray(options)) throw codecError('JXL_OPTIONS', 'JPEG XL options are invalid.');
      const effort = options.effort ?? 1;
      if (!Number.isInteger(effort) || effort < 1 || effort > 9) throw codecError('JXL_OPTIONS', 'JPEG XL effort must be 1–9.');
      if (typeof encoderFactory !== 'function') throw codecError('JXL_UNAVAILABLE', 'The bundled JPEG XL codec is unavailable.');
      stage = 'starting encoder';
      encoder ||= encoderFactory();
      stage = 'carrying the JPEG';
      return encoder.transcode(jpeg, {...options, effort});
    },
    async image(input, options = {}) {
      stage = 'reading image';
      if (typeof imageReader !== 'function') throw codecError('JXL_UNAVAILABLE', 'The bundled JPEG XL codec cannot read pictures.');
      if (!options || typeof options !== 'object' || Array.isArray(options)) throw codecError('JXL_OPTIONS', 'JPEG XL options are invalid.');
      checkSignal(options.signal);
      const read = await imageReader(input?.source, options.transcode !== false);
      checkSignal(options.signal);
      if (read.jpeg) return codec.transcode({bytes: read.jpeg}, {effort: options.effort, progress: options.progress, signal: options.signal});
      const lossy = options.quality !== undefined && options.quality < 100;
      return {bytes: await codec.encode(read, {...options, lossless: !lossy, photo: lossy})};
    },
    async reconstruct(input) {
      stage = 'restoring the JPEG';
      const bytes = byteView(input?.bytes);
      if (!bytes.byteLength) throw codecError('JXL_INPUT', 'The JPEG XL is empty.');
      if (typeof encoderFactory !== 'function') throw codecError('JXL_UNAVAILABLE', 'The bundled JPEG XL codec is unavailable.');
      encoder ||= encoderFactory();
      return encoder.reconstruct(bytes);
    },
    async format(input, options = {}) {
      stage = 'checking format request';
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw codecError('JXL_INPUT', 'JPEG XL format input is invalid.');
      if (!options || typeof options !== 'object' || Array.isArray(options)) throw codecError('JXL_OPTIONS', 'JPEG XL options are invalid.');
      checkSignal(options.signal);
      if (typeof formatHandler !== 'function') throw codecError('JXL_UNAVAILABLE', 'The bundled JPEG XL format writer is unavailable.');
      stage = 'processing JPEG XL format';
      const result = await formatHandler(input, {signal: options.signal, onProgress: options.progress});
      checkSignal(options.signal);
      return result;
    },
    serve(message, report) {
      if (typeof encoderFactory !== 'function') return null;
      encoder ||= encoderFactory();
      return encoder.serve(message, report);
    },
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
  return codec;
}

export function installJPEGXLWorker(configuration) {
  const codec = createJPEGXLCodec(configuration);
  let active = null;
  globalThis.onmessage = async ({data: request}) => {
    if (request?.pool) { const reply = codec.serve(request, message => globalThis.postMessage(message)); if (reply) globalThis.postMessage(...reply); return; }
    const id = request?.id;
    if ((typeof id !== 'number' && typeof id !== 'string') || String(id).length > 128) return;
    if (request.operation === 'cancel') {
      if (active?.id === id) active.controller.abort(codecError('JXL_ABORTED', 'JPEG XL encoding was canceled.'));
      return;
    }
    if (active) {
      globalThis.postMessage({id, ok: false, error: {code: 'JXL_BUSY', message: 'The image worker is busy.'}});
      return;
    }
    const controller = new AbortController();
    active = {id, controller};
    try {
      let reported = 0, at = 0;
      const progress = request.progress === true ? value => {
        const now = Date.now();
        if (typeof value !== 'number' || !(value > reported) || value > 1 || value < 1 && (value - reported < 0.01 || now - at < 100)) return;
        reported = value; at = now;
        globalThis.postMessage({id, progress: value});
      } : undefined;
      const advance = progress ? value => { if (value < 1) progress(value); } : undefined;
      if (request.options !== undefined && (!request.options || typeof request.options !== 'object' || Array.isArray(request.options)))
        throw codecError('JXL_OPTIONS', 'JPEG XL options are invalid.');
      if (request.operation === 'encode') {
        const bytes = await codec.encode({width: request.width, height: request.height, data: request.data}, {...request.options, progress: advance, signal: controller.signal});
        progress?.(1);
        globalThis.postMessage({id, ok: true, bytes}, [bytes.buffer]);
      } else if (request.operation === 'animation') {
        const bytes = await codec.animation({width: request.width, height: request.height, loops: request.loops, frames: request.frames}, {...request.options, progress: advance, signal: controller.signal});
        progress?.(1);
        globalThis.postMessage({id, ok: true, bytes}, [bytes.buffer]);
      } else if (request.operation === 'transcode') {
        const carried = await codec.transcode({bytes: request.bytes}, {...request.options, progress: advance, signal: controller.signal});
        progress?.(1);
        globalThis.postMessage({id, ok: true, ...carried}, [carried.bytes.buffer]);
      } else if (request.operation === 'image') {
        const made = await codec.image({source: request.source}, {...request.options, progress: advance, signal: controller.signal});
        progress?.(1);
        globalThis.postMessage({id, ok: true, ...made}, [made.bytes.buffer]);
      } else if (request.operation === 'reconstruct') {
        const bytes = await codec.reconstruct({bytes: request.bytes});
        globalThis.postMessage({id, ok: true, bytes}, bytes ? [bytes.buffer] : []);
      } else if (request.operation === 'format') {
        const result = await codec.format(request.input, {progress: advance, signal: controller.signal});
        progress?.(1);
        if (result instanceof Uint8Array) {
          const bytes = result.buffer instanceof ArrayBuffer && result.byteOffset === 0 && result.byteLength === result.buffer.byteLength
            ? result : new Uint8Array(result);
          globalThis.postMessage({id, ok: true, bytes}, [bytes.buffer]);
        } else globalThis.postMessage({id, ok: true, result});
      } else throw codecError('JXL_OPERATION', 'Unknown JPEG XL operation.');
    } catch (error) {
      globalThis.postMessage({id, ok: false, error: codec.failure(error)});
    } finally {
      active = null;
    }
  };
}

