import {surface, foreignSpace} from './surface.mjs';
import {isVideo, videoFrame} from './video.mjs';
import {withCost, HANDED} from './ownership.mjs';
import {readWebGL} from './webgl-read.mjs';
import {isRowSource, admitRows, rowBridge} from './rows.mjs';
import {isTexture, readTexture} from './texture.mjs';
import {encodeOptions} from './encode-options.mjs';
import {uploadOptions} from './upload-options.mjs';
import {fitOptions, variantsOptions} from './preparation-options.mjs';
import {outputSides} from './preparation-sides.mjs';
import {admitCapture} from './capture-options.mjs';
import {fail, pixelLimit, dimensions, LARGEST, lostBlank, proveRead, LOST} from './primitives.mjs';
import {WHOLE} from '../memory-device.mjs';

export function encoder(client, config = {}, operations, spec = {}) {
  const upload = spec.module === 'rapier-jxl/upload';
  const wrap = name => (input, given) => {
    try {
      let options = given, transfer;
      if (given && typeof given === 'object') {
        let descriptors, proto;
        try { descriptors = Object.getOwnPropertyDescriptors(given); proto = Object.getPrototypeOf(given); }
        catch { client.admitSurface(null, given); throw fail('JXL_OPTIONS', 'JPEG XL options must be a plain record of data fields.'); }
        const taken = descriptors.transfer;
        if (taken) {
          if (!('value' in taken) || taken.value !== true) throw fail('JXL_OPTIONS', 'transfer is true.');
          transfer = true;
          options = Object.create(proto);
          for (const key of Reflect.ownKeys(descriptors)) if (key !== 'transfer') Object.defineProperty(options, key, descriptors[key]);
        }
      }
      client.admitSurface(null, options);
      let maxPixels = config.maxPixels ?? 40000000;
      const preparation = (name === 'fit' || name === 'variants');
      const richCapture = name === 'capture' && spec.captureAdmission !== undefined;
      if (preparation) {
        maxPixels = Math.min(maxPixels, 40000000);
        const admission = upload ? uploadOptions : undefined;
        const read = name === 'fit' ? fitOptions(options, admission) : variantsOptions(options, admission);
        const limit = name === 'fit' ? read.encode.maxPixels : read.maxPixels;
        if (limit !== undefined) maxPixels = Math.min(maxPixels, limit);
        if (name === 'variants') for (const request of read.requests) outputSides(request.width, request.height, maxPixels);
      } else if (name === 'encode') {
        const {signal: _signal, onProgress: _onProgress, ...rest} = options ?? {};
        const read = upload ? uploadOptions(rest) : encodeOptions(rest);
        if (read.maxPixels !== undefined) maxPixels = Math.min(maxPixels, read.maxPixels);
      } else {
        const {signal: _signal, onProgress: _onProgress, onEncoded: _onEncoded, ...rest} = options ?? {};
        const levels = spec.captureLevels && {module: spec.module, ...spec.captureLevels};
        if (richCapture) spec.captureAdmission(rest, levels);
        else admitCapture(rest, levels);
        if (rest.maxPixels !== undefined) maxPixels = Math.min(maxPixels, pixelLimit(rest.maxPixels, LARGEST));
      }
      const fixed = preparation ? {...fix(options), maxPixels} : fix(options);
      if (isVideo(input)) {
        const frame = videoFrame(input);
        try { return wrap(name)(frame, fixed); } finally { frame.close(); }
      }
      if (isTexture(input)) {
        if (spec.module === 'rapier-jxl/capture') throw fail('JXL_UNSUPPORTED', 'Capture GPU textures with rapier-jxl/capture-complete or rapier-jxl.');
        if (upload) throw fail('JXL_UNSUPPORTED', 'A GPU texture is encoded by rapier-jxl.');
        if (fixed?.readAs !== undefined) throw fail('JXL_OPTIONS', 'readAs reads a canvas, bitmap or Blob; a texture sets colorSpace.');
        return readTexture(input, maxPixels, (take, cost, area) => client.acquired(name, take, cost, fixed, area));
      }
      if (isRowSource(input)) {
        if (preparation) throw fail('JXL_UNSUPPORTED', 'Preparation takes a still image; encode row sources directly.');
        if (options?.readAs !== undefined) throw fail('JXL_OPTIONS', 'readAs reads a canvas, bitmap or Blob; a row source sets colorSpace.');
        const source = admitRows(input, maxPixels);
        if (!client.remote) return client[name](withCost(input, 64), fixed);
        const bridge = rowBridge(source);
        return client[name](withCost(bridge.record, 64), fixed).finally(bridge.close);
      }
      const half = (preparation || name === 'encode' && !upload);
      const handed = client.remote && typeof createImageBitmap === 'function' && snapshot(input, maxPixels, config, options, shape => client.admitSurface(shape, options), half, name === 'capture');
      if (handed?.rows) { const {readAs: _readAs, ...rest} = fixed ?? {}; return wrap(name)(handed, rest); }
      if (handed) {
        const job = client.acquired(name, handed.taking, handed.cost, handed.readAs === undefined ? fixed : {...fixed, readAs: handed.readAs});
        job.then(() => {}, () => {}).then(() => handed.taking).then(taken => taken.close?.(), () => {});
        return job;
      }
      let pixels = surface(input, {...config, maxPixels, half, readAs: options?.readAs, admitSurface: shape => client.admitSurface(shape, options)});
      if (preparation && ArrayBuffer.isView(pixels?.data)) dimensions(pixels.width, pixels.height, maxPixels);
      const blob = typeof Blob !== 'undefined' && pixels instanceof Blob;
      const forwarded = preparation || richCapture ? fixed : options;
      const {readAs: _readAs, ...forward} = forwarded ?? {};
      const moving = transfer && ArrayBuffer.isView(pixels?.data) ? pixels.data : null;
      if (moving) HANDED.add(moving);
      try { return client[name](pixels, blob || forwarded === undefined ? forwarded : forward); } finally { if (moving) HANDED.delete(moving); }
    } catch (error) { return Promise.reject(error); }
  };
  const calls = {encode: wrap('encode'), fit: wrap('fit'), variants: wrap('variants'), capture: wrap('capture'), recompress: bounded(client, 'recompress'), restore: bounded(client, 'restore'),
    decode: bounded(client, 'decode'), format: bounded(client, 'format')};
  return Object.freeze({...Object.fromEntries(operations.map(name => [name, calls[name]])),
    prepare: client.prepare, close: client.close, get stats() { return client.stats; }});
}

function snapshot(input, maxPixels, {maxPendingBytes = 268435456}, options, admitSurface, half, capture) {
  const frame = typeof VideoFrame === 'function' && input instanceof VideoFrame;
  const bitmap = frame || typeof ImageBitmap === 'function' && input instanceof ImageBitmap;
  if (!bitmap && typeof input?.getContext !== 'function') return null;
  const {width, height} = frame ? {width: input.displayWidth, height: input.displayHeight} : input;
  const over = capture && !bitmap && width * height > WHOLE && width * height * 4 > maxPendingBytes;
  dimensions(width, height, maxPixels); if (!over) admitSurface({width, height});
  if (width * height * 4 > maxPendingBytes && !over) throw fail('JXL_MEMORY', 'The image is over maxPendingBytes.');
  const readAs = options?.readAs, context = bitmap ? null : input.getContext('2d', {willReadFrequently: true});
  if (over && !context) return null;
  if (half && context?.getContextAttributes?.().colorType === 'float16') return null;
  const lostAtStart = !!context?.isContextLost?.();
  if (lostAtStart && !over && lostBlank(context, context.getImageData(0, 0, width, height).data)) throw fail('JXL_INPUT', LOST);
  proveRead(context);
  const own = bitmap ? 'srgb' : context ? context.getContextAttributes?.().colorSpace ?? 'srgb' : foreignSpace(input);
  if (!/^(srgb|display-p3)$/.test(own) || readAs !== undefined && !/^(srgb|display-p3)$/.test(readAs)) return null;
  if (over) {
    const asked = readAs ?? own;
    let colorSpace;
    try { colorSpace = context.getImageData(0, 0, 1, 1, {colorSpace: asked}).colorSpace ?? 'srgb'; }
    catch (cause) { throw Object.assign(fail('JXL_INPUT', 'The canvas could not be read: ' + (cause?.message || cause)), {cause}); }
    let read = false;
    return {width, height, colorSpace, rows: (y, count) => {
      const band = new OffscreenCanvas(width, count);
      try {
        const drawn = band.getContext('2d', {colorSpace: own});
        if (!drawn) throw fail('JXL_PLATFORM', 'No 2D canvas here; pass RGBA pixels.');
        drawn.drawImage(input, 0, y, width, count, 0, 0, width, count);
        let {data} = surface(band, {readAs: colorSpace});
        for (let i = 3; i < data.length; i += 4) if (data[i] !== 255 && data[i] !== 0) { data = context.getImageData(0, y, width, count, {colorSpace}).data; break; }
        if (lostBlank(context, data)) {
          if (!lostAtStart || !read && y + count >= height) throw fail('JXL_INPUT', LOST);
        } else read = true;
        return {data};
      } finally { band.width = band.height = 0; }
    }};
  }
  const refused = cause => { throw Object.assign(fail('JXL_INPUT', 'The canvas could not be read: ' + (cause?.message || cause)), {cause}); };
  const cost = width * height * 4, taken = taking => ({taking, cost, readAs: readAs ?? own});
  const pixels = !bitmap && !context && (readAs === undefined || readAs === own) ? readWebGL(input) : null;
  if (pixels) return {taking: pixels, cost};
  if (frame) return taken(Promise.resolve(withCost(input.clone(), cost)));
  try { return taken(createImageBitmap(input).then(made => withCost(made, cost), refused)); }
  catch (cause) { refused(cause); }
}

function fix(options) {
  if (options === undefined || options === null || typeof options !== 'object') return options;
  const {signal, onProgress, onEncoded, ...data} = options;
  return {...structuredClone(data), ...(signal !== undefined && {signal}), ...(onProgress !== undefined && {onProgress}),
    ...(onEncoded !== undefined && {onEncoded})};
}

export const bounded = (client, name) => (input, options) => {
  try { if (options && typeof options === 'object' && options.maxPixels !== undefined) pixelLimit(options.maxPixels, name === 'decode' ? LARGEST : undefined); }
  catch (error) { return Promise.reject(error); }
  return client[name](input, options);
};
