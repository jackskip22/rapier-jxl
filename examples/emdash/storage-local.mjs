import {createStorage as createLocal} from 'emdash/storage/local';
import {resolve} from 'node:path';
import {withMediaCopies, registerStorage} from './media-storage.mjs';
import {localStore} from './local-store.mjs';
import {originalFileCache} from './original-cache-node.mjs';
import {configureDecoder} from 'rapier-jxl/verify';
import {decode} from 'rapier-jxl/decode';
import {restore} from 'rapier-jxl/jpeg';

// The packaged verifier has no decoder of its own: verify reads each JPEG XL copy back with these before it is attached.
configureDecoder(decode, restore);

export function createStorage(config) {
  const limits = {maxPixels: 40e6, maxInputBytes: 256 * 1024 * 1024, ...config.rapier};
  const scope = JSON.stringify(['local', resolve(config.directory)]);
  const {store, create, compareAndSet, head, replace} = localStore(createLocal(config), config.directory, limits.maxInputBytes);
  return registerStorage(withMediaCopies(store, {...limits, create, compareAndSet,
    originalBackend: {platform: 'node', scope, head, replace, cache: originalFileCache(config.directory)}}), scope);
}
