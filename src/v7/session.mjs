import {createEncoder as createClient} from './client.mjs';
import {sharedClient} from './shared.mjs';
import {surface} from './surface.mjs';
import {object} from './primitives.mjs';

let shared;
export function defaultEncoder() { return shared ||= encoder(sharedClient()); }
export function createEncoder(config = {}) {
  object(config, 'Encoder configuration');
  return encoder(createClient(config), config);
}
function encoder(client, config = {}) {
  const wrap = name => (input, options) => {
    try {
      client.admitSurface(null, options);
      const pixels = surface(input, {...config, colorSpace: options?.colorSpace, admitSurface: shape => client.admitSurface(shape, options)});
      return client[name](pixels, options);
    } catch (error) { return Promise.reject(error); }
  };
  return Object.freeze({encode: wrap('encode'), capture: wrap('capture'), recompress: client.recompress,
    restore: client.restore, decode: client.decode, animate: client.animate, format: client.format,
    close: client.close, get stats() { return client.stats; }});
}
