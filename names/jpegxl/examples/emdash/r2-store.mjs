export function r2Store(inner, bucket) {
  const metadata = object => ({size: object.size, contentType: object.httpMetadata?.contentType ?? 'application/octet-stream',
    cacheControl: object.httpMetadata?.cacheControl, lastModified: object.uploaded, etag: object.etag, version: object.version,
    ...(object.customMetadata?.rapierOriginal ? {originalId: object.customMetadata.rapierOriginal,
      representation: object.customMetadata.rapierRepresentation} : {})});
  const store = new Proxy(inner, {get(target, property) {
    if (property === 'download') return async (key, options) => {
      options?.signal?.throwIfAborted();
      const object = await bucket.get(key, options?.range ? {range: options.range} : undefined);
      if (!object?.body && key.startsWith('__rapier_jxl__/'))
        throw Object.assign(new Error('Private media object not found.'), {code: 'NOT_FOUND'});
      if (!object?.body) return target.download(key, options);
      return {body: object.body, ...(object.range ? {range: object.range} : {}), ...metadata(object)};
    };
    const value = target[property];
    return typeof value === 'function' ? value.bind(target) : value;
  }});
  async function create(key, body, {contentType, signal} = {}) {
    signal?.throwIfAborted();
    const object = await bucket.put(key, body, {onlyIf: new Headers({'If-None-Match': '*'}), httpMetadata: {contentType}});
    // The stored object's own version comes back with the write, so a copy can be bound to it with no further read.
    return object === null ? false : {created: true, ...(typeof (object?.version ?? object?.etag) === 'string' && {version: object.version ?? object.etag})};
  }
  async function compareAndSet(key, body, {etag, contentType, signal} = {}) {
    if (!key.startsWith('__rapier_jxl__/') || !key.endsWith('.json') ||
        etag !== null && (typeof etag !== 'string' || !etag))
      throw Object.assign(new Error('Private settings require their stored revision.'), {code: 'JXL_INPUT'});
    signal?.throwIfAborted();
    const onlyIf = etag === null ? new Headers({'If-None-Match': '*'}) : {etagMatches: etag};
    return await bucket.put(key, body, {onlyIf, httpMetadata: {contentType}}) !== null;
  }
  async function head(key, {signal} = {}) {
    signal?.throwIfAborted();
    const object = await bucket.head(key);
    return object ? metadata(object) : null;
  }
  async function replace(key, body, {expectedVersion, etag, contentType, originalId, representation, cacheControl, signal} = {}) {
    if (key.startsWith('__rapier_jxl__/') || !/\.(?:jpe?g|jpe|jfif)$/i.test(key) ||
        typeof expectedVersion !== 'string' || !expectedVersion || typeof etag !== 'string' || !etag ||
        !/^[a-f0-9]{32}$/.test(originalId ?? '') || !['jxl', 'jpeg'].includes(representation))
      throw Object.assign(new Error('Original replacement requires its captured source and archive identity.'), {code: 'JXL_INPUT'});
    signal?.throwIfAborted();
    const before = await bucket.head(key);
    if (!before || before.version !== expectedVersion || before.etag !== etag) return null;
    // R2 has an atomic ETag condition, not a version condition. The durable archive control
    // token serializes integration-owned JPEG mutations and drains before restoration, so a
    // stale pending put cannot survive an A -> JXL -> exact A transition (the ETag ABA case).
    const object = await bucket.put(key, body, {onlyIf: {etagMatches: etag},
      httpMetadata: {contentType, ...(cacheControl ? {cacheControl} : {})},
      customMetadata: {rapierOriginal: originalId, rapierRepresentation: representation}});
    return object ? metadata(object) : null;
  }
  return {store, create, compareAndSet, head, replace};
}
