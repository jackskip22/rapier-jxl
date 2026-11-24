import {surface, foreignSpace, context2d} from './surface.mjs';
import {isVideo, videoFrame} from './video.mjs';
import {withCost, HANDED, DEFAULT_INPUT_BYTES} from './ownership.mjs';
import {readWebGL} from './webgl-read.mjs';
import {isRowSource, admitRows, rowBridge} from './rows.mjs';
import {isTexture, readTexture} from './texture.mjs';
import {encodeOptions, publicVocabulary} from './encode-options.mjs';
import {uploadOptions} from './upload-options.mjs';
import {fitOptions, variantsOptions} from './preparation-options.mjs';
import {outputSides} from './preparation-sides.mjs';
import {admitCapture} from './capture-options.mjs';
import {fail, object, pixelLimit, dimensions, PIXELS, lostBlank, proveRead, LOST, isBlob} from './primitives.mjs';
import {WHOLE} from '../memory-device.mjs';
import {JPEG_SOURCE, JPEG_SOURCE_WIRE} from './jpeg-choice-policy.mjs';

export let bitmapClones;
export const bitmapCloneCheck = typeof createImageBitmap !== 'function' || typeof ImageData !== 'function' || typeof MessageChannel !== 'function'
  ? (bitmapClones = true, Promise.resolve(true))
  : createImageBitmap(new ImageData(1, 1)).then(bitmap => {
      const channel = new MessageChannel();
      try { channel.port1.postMessage(bitmap); bitmapClones = true; }
      catch { bitmapClones = false; }
      finally {
        try { bitmap.close(); } catch {}
        try { channel.port1.close(); } catch {}
        try { channel.port2.close(); } catch {}
      }
      return bitmapClones;
    }, () => (bitmapClones = false)).catch(() => (bitmapClones = false));

export function encoder(client, config = {}, operations, spec = {}) {
  const upload = spec.module === 'rapier-jxl/upload';
  const wrap = name => (input, given) => {
    try {
      let options = given, transfer, originalJpeg;
      if (given && typeof given === 'object') {
        let descriptors, proto;
        try { descriptors = Object.getOwnPropertyDescriptors(given); proto = Object.getPrototypeOf(given); }
        catch { client.admitSurface(null, given); throw fail('JXL_OPTIONS', "options: plain data record"); }
        const taken = descriptors.transfer, source = descriptors[JPEG_SOURCE];
        if (source) {
          if (!('value' in source) || !['encode', 'fit', 'variants'].includes(name) || !ArrayBuffer.isView(input?.data))
            throw fail('JXL_OPTIONS', "jpeg: original alongside pixels");
          originalJpeg = source.value;
        }
        if (taken || source) {
          object(given);
          if (taken && (!('value' in taken) || taken.value !== true && taken.value !== undefined)) throw fail('JXL_OPTIONS', "transfer: true or omit");
          transfer = taken?.value === true;
          options = Object.create(proto);
          for (const key of Reflect.ownKeys(descriptors)) if (key !== 'transfer' && key !== JPEG_SOURCE) Object.defineProperty(options, key, descriptors[key]);
        }
      }
      client.admitSurface(null, options);
      const words = publicVocabulary(options);
      let maxPixels = config.maxPixels ?? PIXELS;
      const preparation = (name === 'fit' || name === 'variants');
      const richCapture = name === 'capture' && spec.captureAdmission !== undefined;
      if (preparation) {
        const admission = upload ? uploadOptions : undefined;
        const read = name === 'fit' ? fitOptions(words, admission) : variantsOptions(words, admission);
        const limit = name === 'fit' ? read.encode.maxPixels : read.maxPixels;
        if (limit !== undefined) maxPixels = Math.min(maxPixels, limit);
        if (name === 'variants') for (const request of read.requests) outputSides(request.width, request.height, maxPixels);
      } else if (name === 'encode') {
        const {signal: _signal, onProgress: _onProgress, onPreview: _onPreview, ...rest} = words ?? {};
        const read = upload ? uploadOptions(rest) : encodeOptions(rest, spec.module === 'rapier-jxl/max', spec.module === 'rapier-jxl' || spec.module === 'rapier-jxl/max');
        if (read.maxPixels !== undefined) maxPixels = Math.min(maxPixels, read.maxPixels);
      } else {
        const {signal: _signal, onProgress: _onProgress, onPreview: _onPreview, ...rest} = words ?? {};
        const levels = spec.captureLevels && {module: spec.module, ...spec.captureLevels};
        if (richCapture) spec.captureAdmission(rest, levels);
        else admitCapture(rest, levels);
        if (rest.maxPixels !== undefined) maxPixels = Math.min(maxPixels, pixelLimit(rest.maxPixels));
      }
      const fixed = preparation ? {...fix(options), maxPixels} : fix(options);
      if (isVideo(input)) {
        const frame = videoFrame(input);
        try { return wrap(name)(frame, fixed); } finally { frame.close(); }
      }
      if (isTexture(input)) {
        if (spec.module === 'rapier-jxl/capture') throw fail('JXL_UNSUPPORTED', "texture: use jpegxl/capture-complete or jpegxl");
        if (upload) throw fail('JXL_UNSUPPORTED', "texture: use jpegxl");
        if (fixed?.readAs !== undefined) throw fail('JXL_OPTIONS', "readAs: set texture.colorSpace");
        return readTexture(input, maxPixels, (take, cost, area) => client.acquired(name, take, cost, fixed, area));
      }
      if (isRowSource(input)) {
        if (preparation) throw fail('JXL_UNSUPPORTED', 'row source: encode directly');
        if (options?.readAs !== undefined) throw fail('JXL_OPTIONS', "readAs: set source.colorSpace");
        const source = admitRows(input, maxPixels);
        if (!client.remote) return client[name](withCost(input, 64), fixed);
        const bridge = rowBridge(source);
        return bridge.wait(client[name](withCost(bridge.record, 64), fixed));
      }
      const half = (preparation || name === 'encode' && !upload);
      const handed = client.remote && snapshot(input, maxPixels, config, options, shape => client.admitSurface(shape, options), half, name === 'capture', bitmapClones === true && typeof createImageBitmap === 'function');
      if (handed?.rows) { const {readAs: _readAs, ...rest} = fixed ?? {}; return wrap(name)(handed, rest); }
      if (handed) {
        const job = client.acquired(name, handed.taking, handed.cost, handed.readAs === undefined ? fixed : {...fixed, readAs: handed.readAs});
        job.then(() => {}, () => {}).then(() => handed.taking).then(taken => { try { taken?.close?.(); } catch {} }, () => {});
        return job;
      }
      let pixels = surface(input, {...config, maxPixels, half, deferPacked: transfer && name !== 'capture', readAs: options?.readAs, admitSurface: shape => client.admitSurface(shape, options)});
      if (preparation && ArrayBuffer.isView(pixels?.data)) dimensions(pixels.width, pixels.height, maxPixels);
      const blob = isBlob(pixels);
      const forwarded = preparation || richCapture ? fixed : options;
      const {readAs: _readAs, ...forward} = forwarded ?? {};
      const moving = !transfer ? [] : ArrayBuffer.isView(pixels?.data) ? [pixels.data]
        : Array.isArray(pixels?.frames) ? pixels.frames.map(frame => frame?.data).filter(data => ArrayBuffer.isView(data)) : [];
      for (const data of moving) HANDED.add(data);
      const queued = blob || forwarded === undefined ? forwarded : forward;
      try { return client[name](pixels, originalJpeg === undefined ? queued : {...queued, [JPEG_SOURCE_WIRE]: originalJpeg}); }
      finally { for (const data of moving) HANDED.delete(data); }
    } catch (error) { return Promise.reject(error); }
  };
  const calls = {encode: wrap('encode'), fit: wrap('fit'), variants: wrap('variants'), capture: wrap('capture'), recompress: bounded(client, 'recompress'), restore: bounded(client, 'restore'),
    decode: bounded(client, 'decode'), format: bounded(client, 'format')};
  return Object.freeze({...Object.fromEntries(operations.map(name => [name, calls[name]])),
    prepare: client.prepare, close: client.close, get stats() { return client.stats; }});
}

function snapshot(input, maxPixels, {maxPendingBytes = DEFAULT_INPUT_BYTES}, options, admitSurface, half, capture, handoff) {
  const frame = typeof VideoFrame === 'function' && input instanceof VideoFrame;
  const bitmap = frame || typeof ImageBitmap === 'function' && input instanceof ImageBitmap;
  if (!bitmap && typeof input?.getContext !== 'function') return null;
  const {width, height} = frame ? {width: input.displayWidth, height: input.displayHeight} : input;
  const over = capture && !bitmap && width * height > WHOLE && width * height * 4 > maxPendingBytes;
  dimensions(width, height, maxPixels); if (!over) admitSurface({width, height});
  if (width * height * 4 > maxPendingBytes && !over) throw fail('JXL_MEMORY', "maxPendingBytes: raise or smaller image");
  if (!over && handoff !== true) return null;
  const readAs = options?.readAs, context = bitmap ? null : context2d(input);
  if (over && !context) return null;
  if (!over && context && context.getContextAttributes?.().alpha !== false) return null;
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
    catch (cause) { throw Object.assign(fail('JXL_INPUT', "canvas: redraw or RGBA"), {cause}); }
    let read = false;
    return {width, height, colorSpace, rows: (y, count) => {
      const band = new OffscreenCanvas(width, count);
      try {
        const drawn = band.getContext('2d', {colorSpace: own});
        if (!drawn) throw fail('JXL_PLATFORM', 'no 2D canvas: pass RGBA pixels');
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
  const refused = cause => { throw Object.assign(fail('JXL_INPUT', "canvas: redraw or RGBA"), {cause}); };
  const cost = width * height * 4, taken = taking => ({taking, cost, readAs: readAs ?? own});
  const pixels = !bitmap && !context && (readAs === undefined || readAs === own) ? readWebGL(input) : null;
  if (pixels) return {taking: pixels, cost};
  if (frame) return taken(Promise.resolve(withCost(input.clone(), cost)));
  try { return taken(createImageBitmap(input).then(made => withCost(made, cost), refused)); }
  catch (cause) { refused(cause); }
}

function fix(options) {
  if (options === undefined || options === null || typeof options !== 'object') return options;
  const {signal, onProgress, onPreview, ...data} = options;
  return {...structuredClone(data), ...(signal !== undefined && {signal}), ...(onProgress !== undefined && {onProgress}), ...(onPreview !== undefined && {onPreview})};
}

export const bounded = (client, name) => (input, options) => {
  try { if (options && typeof options === 'object' && options.maxPixels !== undefined) pixelLimit(options.maxPixels); }
  catch (error) { return Promise.reject(error); }
  return client[name](input, options);
};
