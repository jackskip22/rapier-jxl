import {env} from 'cloudflare:workers';
import {createStorage as createR2} from '@emdash-cms/cloudflare/storage/r2';
import {withMediaCopies, registerStorage} from './media-storage.mjs';
import {r2Store} from './r2-store.mjs';
import {configureDecoder} from 'jpeg-xl/verify';
import {decode} from 'jpeg-xl/decode';
import {restore} from 'jpeg-xl/jpeg';
import {originalWorkerCache} from './original-cache-workers.mjs';

// Workers have no built-in decoder: verify restores each JPEG XL copy with these before it is attached.
configureDecoder(decode, restore);

// Native EmDash uploads byte arrays; direct stream integrations need known-length R2 bodies.
export function createStorage(config) {
  const inner = createR2(config), bucket = env[config.binding];
  const limits = {maxPixels: 24e6, maxInputBytes: 32 * 1024 * 1024, ...config.rapier};
  const scope = JSON.stringify(['r2', config.binding]);
  const {store, create, compareAndSet, head, replace} = r2Store(inner, bucket);
  return registerStorage(withMediaCopies(store, {...limits, create, compareAndSet,
    originalBackend: {platform: 'cloudflare', scope, head, replace, cache: originalWorkerCache(scope)}}), scope);
}
