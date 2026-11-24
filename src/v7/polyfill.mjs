import {snapshotOptions} from './primitives.mjs';
const PROBE = 'data:image/jxl;base64,/woYAAaASAgCAQBkAEsYkw5wiBJQIwEA4eShY0EWAPoFIgDov58=';
const ANIMATED = '/woYAAYISgBATAgGAQBAAEs4aQjJDQjg/kQJ2AUI4gAIBrMEAAAEAEAASzhpCMkN9ycARAnYBQjiAA==';
const probes = new WeakMap(), installations = new WeakMap();
export function supportsJXL(document = globalThis.document, probeURL = PROBE) {
  if (typeof probeURL !== 'string') return Promise.reject(refuse("probeURL: image URL string"));
  if (document === undefined) return Promise.resolve(false);
  if (!isDocument(document)) return Promise.reject(refuse('document: images and events required'));
  const key = probeURL, baseURI = document.baseURI;
  if (baseURI !== undefined && typeof baseURI !== 'string') return Promise.reject(refuse('document.baseURI: string'));
  let resolvedKey = key;
  try { resolvedKey = new URL(key, baseURI || 'https://local.invalid/').href; } catch {}
  let cache = probes.get(document); if (!cache) probes.set(document, cache = new Map());
  if (!cache.has(key)) cache.set(key, new Promise((resolve, reject) => {
    const image = document.createElement('img');
    if (!object(image)) throw refuse('document: image creation required');
    let blocked = false, finished = false, timer;
    const violation = event => { if (event.disposition === 'enforce' && event.effectiveDirective === 'img-src' &&
      (event.blockedURI === 'data' && key.startsWith('data:') || event.blockedURI === key || event.blockedURI === resolvedKey)) blocked = true; };
    const cleanup = () => {
      clearTimeout(timer);
      document.removeEventListener('securitypolicyviolation', violation);
      Reflect.set(image, 'onload', null); Reflect.set(image, 'onerror', null);
    };
    const finish = result => { if (finished) return; finished = true; try { cleanup(); resolve(result); } catch (error) { reject(error); } };
    const set = (name, value) => { if (!Reflect.set(image, name, value)) throw refuse('document image: writable'); };
    try {
      document.addEventListener('securitypolicyviolation', violation);
      timer = setTimeout(() => finish(null), 5000);
      set('onload', () => finish(image.naturalWidth > 0 && image.naturalHeight > 0));
      set('onerror', () => setTimeout(() => finish(blocked ? null : false), 0));
      set('src', key);
    } catch (error) { finished = true; try { cleanup(); } catch {} reject(error); }
  }));
  return cache.get(key);
}
export async function supportsAnimatedJXL(document = globalThis.document) {
  const Decoder = document?.defaultView?.ImageDecoder ?? globalThis.ImageDecoder;
  if (typeof Decoder !== 'function') return null;
  try {
    const decoder = new Decoder({data: Uint8Array.from(atob(ANIMATED), c => c.charCodeAt(0)), type: 'image/jxl'});
    try { await decoder.tracks.ready; return (decoder.tracks.selectedTrack?.frameCount ?? 1) > 1; } finally { decoder.close(); }
  } catch { return null; }
}
const refuse = message => Object.assign(new TypeError(message), {code: 'JXL_OPTIONS'});
const object = value => value !== null && (typeof value === 'object' || typeof value === 'function');
const isDocument = value => object(value) && ['createElement', 'addEventListener', 'removeEventListener'].every(name => typeof value[name] === 'function');
const KEYS = ['document', 'root', 'probeURL', 'force', 'workers', 'maxDecodedBytes', 'maxInputBytes', 'rootMargin', 'workerFactory', 'decode', 'onError'];
function admit(options) {
  const own = snapshotOptions(options, 'install options'), {document, root, probeURL, force, workers, maxDecodedBytes, maxInputBytes, rootMargin} = own;
  for (const key of Object.keys(own)) if (!KEYS.includes(key)) throw refuse(`unknown option: ${key}`);
  if (document !== undefined && !isDocument(document)) throw refuse('document: images and events required');
  if (root !== undefined) {
    if (!(object(root) && [1, 9, 11].includes(root.nodeType) && typeof root.contains === 'function')) throw refuse("root: Document|Element|ShadowRoot");
    const Watcher = (document ?? globalThis.document)?.defaultView?.MutationObserver ?? globalThis.MutationObserver;
    if (typeof Watcher === 'function') {
      const probe = new Watcher(() => {});
      try { probe.observe(root, {childList: true}); } catch { throw refuse("root: Document|Element|ShadowRoot"); } finally { probe.disconnect(); }
    }
  }
  if (probeURL !== undefined && typeof probeURL !== 'string') throw refuse("probeURL: image URL string");
  if (force !== undefined && typeof force !== 'boolean') throw refuse("force: boolean");
  if (workers !== undefined && (!Number.isInteger(workers) || workers < 1 || workers > 4)) throw refuse("workers: integer 1-4");
  if (maxDecodedBytes !== undefined && (!Number.isSafeInteger(maxDecodedBytes) || maxDecodedBytes < 4)) throw refuse("maxDecodedBytes: integer >=4");
  if (maxInputBytes !== undefined && (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 1)) throw refuse("maxInputBytes: positive integer");
  if (rootMargin !== undefined) {
    if (typeof rootMargin !== 'string') throw refuse("rootMargin: CSS margin");
    const Observer = (document ?? globalThis.document)?.defaultView?.IntersectionObserver ?? globalThis.IntersectionObserver;
    if (typeof Observer === 'function') {
      try { new Observer(() => {}, {rootMargin}).disconnect(); } catch { throw refuse("rootMargin: px or %"); }
    }
  }
  for (const name of ['workerFactory', 'decode', 'onError']) if (own[name] !== undefined && typeof own[name] !== 'function') throw refuse(`${name}: function`);
  return own;
}
export function install(options) {
  let own;
  try { own = admit(options); } catch (error) { return Promise.reject(error); }
  const document = own.document ?? globalThis.document;
  if (!document) return Promise.resolve({status: 'unavailable', disconnect() {}, refresh() {}});
  const previous = installations.get(document);
  if (previous) return previous.promise;
  const record = {};
  record.promise = new Promise((resolve, reject) => { record.resolve = resolve; record.reject = reject; });
  installations.set(document, record);
  const current = () => installations.get(document) === record;
  (async () => {
    const native = own.force ? false : await supportsJXL(document, own.probeURL);
    if (!current()) return;
    let controller;
    const still = native === true && !own.force && await supportsAnimatedJXL(document) === false;
    if (!current()) return;
    if (native !== false && !still) controller = {status: native ? 'native' : 'probe-blocked', disconnect() { this.status = 'closed'; }, refresh() {}};
    else {
      const {installFallback} = await import('./polyfill-runtime.mjs');
      if (!current()) return;
      controller = installFallback(document, still ? {...own, animatedOnly: true} : own);
    }
    if (!current()) { controller.disconnect(); return; }
    const close = controller.disconnect;
    controller.disconnect = () => { close.call(controller); if (current()) installations.delete(document); };
    record.controller = controller;
    record.resolve(controller);
  })().catch(error => { if (current()) { installations.delete(document); record.reject(error); } });
  return record.promise;
}
