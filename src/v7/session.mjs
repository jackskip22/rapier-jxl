import {surface} from './surface.mjs';
import {encodeOptions} from './encode-options.mjs';
import {admitCapture} from './capture-options.mjs';
import {fail, pixelLimit} from './primitives.mjs';

export function encoder(client, config = {}, operations, spec = {}) {
  const upload = spec.module === 'rapier-jxl/upload';
  const wrap = name => (input, options) => {
    try {
      client.admitSurface(null, options);
      let maxPixels = config.maxPixels ?? 40000000;
      if (name === 'encode') {
        const {signal: _signal, onProgress: _onProgress, ...rest} = options ?? {};
        const read = encodeOptions(upload ? {...rest, effort: rest.effort ?? spec.defaultEffort} : rest);
        if (upload && read.effort > spec.defaultEffort) throw fail('JXL_OPTIONS', 'The upload encoder runs efforts 1-3; efforts 4-9 are rapier-jxl\'s.');
        if (upload && read.target !== undefined) throw fail('JXL_OPTIONS', 'A measured fidelity is rapier-jxl\'s.');
        if (upload && rest.features !== undefined) throw fail('JXL_OPTIONS', 'Codestream features are rapier-jxl\'s.');
        if (read.maxPixels !== undefined) maxPixels = Math.min(maxPixels, read.maxPixels);
      } else {
        const {signal: _signal, onProgress: _onProgress, ...rest} = options ?? {};
        admitCapture(rest);
        if (rest.maxPixels !== undefined) maxPixels = Math.min(maxPixels, pixelLimit(rest.maxPixels));
      }
      const pixels = surface(input, {...config, maxPixels, readAs: options?.readAs, admitSurface: shape => client.admitSurface(shape, options)});
      const blob = typeof Blob !== 'undefined' && pixels instanceof Blob;
      const {readAs: _readAs, ...forward} = options ?? {};
      return client[name](pixels, blob || options === undefined ? options : forward);
    } catch (error) { return Promise.reject(error); }
  };
  const bounded = name => (input, options) => {
    try { if (options && typeof options === 'object' && options.maxPixels !== undefined) pixelLimit(options.maxPixels); }
    catch (error) { return Promise.reject(error); }
    return client[name](input, options);
  };
  const calls = {encode: wrap('encode'), capture: wrap('capture'), recompress: bounded('recompress'), restore: bounded('restore'),
    decode: bounded('decode'), format: bounded('format')};
  return Object.freeze({...Object.fromEntries(operations.map(name => [name, calls[name]])),
    prepare: client.prepare, close: client.close, get stats() { return client.stats; }});
}
