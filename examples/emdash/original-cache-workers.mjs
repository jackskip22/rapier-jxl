import {digest} from './digest.mjs';

// Cache API entries are local to the serving data centre and may be evicted. Await each
// request's own cache work; never share an in-flight I/O promise between Worker invocations.
export function originalWorkerCache(scope) {
  let namespace;
  async function request(key) {
    namespace ??= await digest(new TextEncoder().encode(scope));
    return new Request(`https://rapier-original-cache.invalid/${namespace}/${key}`);
  }
  return {
    async get(key, {signal} = {}) {
      signal?.throwIfAborted();
      try {
        const cache = await caches.open('rapier-jxl-originals');
        const response = await cache.match(await request(key));
        return response ? new Uint8Array(await response.arrayBuffer()) : null;
      } catch { signal?.throwIfAborted(); return null; }
    },
    async put(key, bytes, {signal} = {}) {
      signal?.throwIfAborted();
      try {
        const cache = await caches.open('rapier-jxl-originals');
        await cache.put(await request(key), new Response(bytes, {headers: {
          'content-type': 'image/jpeg', 'content-length': String(bytes.length), 'cache-control': 'public, max-age=86400'
        }}));
        return true;
      } catch { signal?.throwIfAborted(); return false; }
    }
  };
}
