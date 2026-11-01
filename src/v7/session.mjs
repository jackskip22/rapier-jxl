import {surface, foreignSpace} from './surface.mjs';
import {isVideo, videoFrame} from './video.mjs';
import {withCost} from './ownership.mjs';
import {readWebGL} from './webgl-read.mjs';
import {isRowSource, admitRows, rowBridge} from './rows.mjs';
import {isTexture, readTexture} from './texture.mjs';
import {encodeOptions} from './encode-options.mjs';
import {admitCapture} from './capture-options.mjs';
import {fail, pixelLimit, dimensions, LARGEST} from './primitives.mjs';

export function encoder(client, config = {}, operations, spec = {}) {
  const upload = spec.module === 'rapier-jxl/upload';
  const wrap = name => (input, options) => {
    if (isVideo(input)) {
      let frame; try { frame = videoFrame(input); } catch (error) { return Promise.reject(error); }
      try { return wrap(name)(frame, options); } finally { frame.close(); }
    }
    try {
      client.admitSurface(null, options);
      let maxPixels = config.maxPixels ?? 40000000;
      if (name === 'encode') {
        const {signal: _signal, onProgress: _onProgress, ...rest} = options ?? {};
        const read = encodeOptions(upload ? {...rest, effort: rest.effort ?? spec.defaultEffort} : rest);
        if (upload && read.effort > spec.defaultEffort) throw fail('JXL_OPTIONS', 'The upload encoder runs efforts 1-3; efforts 4-9 are rapier-jxl\'s.');
        if (upload && read.target !== undefined) throw fail('JXL_OPTIONS', 'A measured fidelity is rapier-jxl\'s.');
        if (upload && rest.features?.firstRegion !== undefined) throw fail('JXL_UNSUPPORTED', 'firstRegion is rapier-jxl\'s.');
        if (upload && rest.features !== undefined) throw fail('JXL_OPTIONS', 'Codestream features are rapier-jxl\'s.');
        if (read.maxPixels !== undefined) maxPixels = Math.min(maxPixels, read.maxPixels);
      } else {
        const {signal: _signal, onProgress: _onProgress, ...rest} = options ?? {};
        admitCapture(rest);
        if (rest.maxPixels !== undefined) maxPixels = Math.min(maxPixels, pixelLimit(rest.maxPixels, LARGEST));
      }
      const fixed = fix(options);
      if (isTexture(input)) {
        if (upload) throw fail('JXL_UNSUPPORTED', 'A GPU texture is encoded by rapier-jxl.');
        return readTexture(input, maxPixels).then(pixels => wrap(name)(pixels, fixed));
      }
      if (isRowSource(input)) {
        if (options?.readAs !== undefined) throw fail('JXL_OPTIONS', 'readAs reads a canvas, bitmap or Blob; a row source names its own space (colorSpace).');
        const source = admitRows(input, maxPixels);
        if (!client.remote) return client[name](withCost(input, 64), fixed);
        const bridge = rowBridge(source);
        return client[name](withCost(bridge.record, 64), fixed).finally(bridge.close);
      }
      const half = name === 'encode' && !upload;
      const handed = client.remote && typeof createImageBitmap === 'function' && snapshot(input, maxPixels, config, options, shape => client.admitSurface(shape, options), half);
      if (handed) {
        const job = client.acquired(name, handed.taking, handed.cost, handed.readAs === undefined ? fixed : {...fixed, readAs: handed.readAs});
        job.then(() => {}, () => {}).then(() => handed.taking).then(taken => taken.close?.(), () => {});
        return job;
      }
      const pixels = surface(input, {...config, maxPixels, half, readAs: options?.readAs, admitSurface: shape => client.admitSurface(shape, options)});
      const blob = typeof Blob !== 'undefined' && pixels instanceof Blob;
      const {readAs: _readAs, ...forward} = options ?? {};
      return client[name](pixels, blob || options === undefined ? options : forward);
    } catch (error) { return Promise.reject(error); }
  };
  const calls = {encode: wrap('encode'), capture: wrap('capture'), recompress: bounded(client, 'recompress'), restore: bounded(client, 'restore'),
    decode: bounded(client, 'decode'), format: bounded(client, 'format')};
  return Object.freeze({...Object.fromEntries(operations.map(name => [name, calls[name]])),
    prepare: client.prepare, close: client.close, get stats() { return client.stats; }});
}

function snapshot(input, maxPixels, {maxPendingBytes = 268435456}, options, admitSurface, half) {
  const frame = typeof VideoFrame === 'function' && input instanceof VideoFrame;
  const bitmap = frame || typeof ImageBitmap === 'function' && input instanceof ImageBitmap;
  if (!bitmap && typeof input?.getContext !== 'function') return null;
  const {width, height} = frame ? {width: input.displayWidth, height: input.displayHeight} : input;
  dimensions(width, height, maxPixels); admitSurface({width, height});
  if (width * height * 4 > maxPendingBytes) throw fail('JXL_MEMORY', 'The image exceeds the pending input budget (maxPendingBytes).');
  const readAs = options?.readAs, context = bitmap ? null : input.getContext('2d', {willReadFrequently: true});
  if (half && context?.getContextAttributes?.().colorType === 'float16') return null;
  if (context?.isContextLost?.()) throw fail('JXL_INPUT', 'The canvas lost its 2D context, so its pixels are gone; draw it again.');
  const own = bitmap ? 'srgb' : context ? context.getContextAttributes().colorSpace : foreignSpace(input);
  if (!/^(srgb|display-p3)$/.test(own) || readAs !== undefined && !/^(srgb|display-p3)$/.test(readAs)) return null;
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
  const {signal, onProgress, ...data} = options;
  return {...structuredClone(data), ...(signal !== undefined && {signal}), ...(onProgress !== undefined && {onProgress})};
}

export const bounded = (client, name) => (input, options) => {
  try { if (options && typeof options === 'object' && options.maxPixels !== undefined) pixelLimit(options.maxPixels, name === 'decode' ? LARGEST : undefined); }
  catch (error) { return Promise.reject(error); }
  return client[name](input, options);
};
