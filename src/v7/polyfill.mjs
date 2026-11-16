import {snapshotOptions} from './primitives.mjs';
const PROBE = 'data:image/jxl;base64,/woYAAaASAgCAQBkAEsYkw5wiBJQIwEA4eShY0EWAPoFIgDov58=';
const probes = new WeakMap(), installations = new WeakMap();
export function supportsJXL(document = globalThis.document, probeURL = PROBE) {
  if (!document) return Promise.resolve(false);
  if (!isDocument(document)) return Promise.reject(refuse('document cannot create images or listen for events; pass a Document.'));
  if (typeof probeURL !== 'string') return Promise.reject(refuse("Invalid probeURL; pass an image URL string."));
  const key = probeURL, baseURI = document.baseURI;
  if (baseURI !== undefined && typeof baseURI !== 'string') return Promise.reject(refuse('document has an invalid baseURI; pass a Document.'));
  let resolvedKey = key;
  try { resolvedKey = new URL(key, baseURI || 'https://local.invalid/').href; } catch {}
  let cache = probes.get(document); if (!cache) probes.set(document, cache = new Map());
  if (!cache.has(key)) cache.set(key, new Promise((resolve, reject) => {
    const image = document.createElement('img');
    if (!object(image)) throw refuse('document cannot create an image; pass a Document.');
    let blocked = false, finished = false, timer;
    const violation = event => { if (event.disposition === 'enforce' && event.effectiveDirective === 'img-src' &&
      (event.blockedURI === 'data' && key.startsWith('data:') || event.blockedURI === key || event.blockedURI === resolvedKey)) blocked = true; };
    const cleanup = () => {
      clearTimeout(timer);
      document.removeEventListener('securitypolicyviolation', violation);
      Reflect.set(image, 'onload', null); Reflect.set(image, 'onerror', null);
    };
    const finish = result => { if (finished) return; finished = true; try { cleanup(); resolve(result); } catch (error) { reject(error); } };
    const set = (name, value) => { if (!Reflect.set(image, name, value)) throw refuse('document returned an unwritable image; pass a Document.'); };
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
const refuse = message => Object.assign(new TypeError(message), {code: 'JXL_OPTIONS'});
const object = value => value !== null && (typeof value === 'object' || typeof value === 'function');
const isDocument = value => object(value) && ['createElement', 'addEventListener', 'removeEventListener'].every(name => typeof value[name] === 'function');
const KEYS = ['document', 'root', 'probeURL', 'force', 'workers', 'maxDecodedBytes', 'maxInputBytes', 'rootMargin', 'workerFactory', 'decode', 'onError'];
function admit(options) {
  const own = snapshotOptions(options, 'install options'), {document, root, probeURL, force, workers, maxDecodedBytes, maxInputBytes, rootMargin} = own;
  for (const key of Object.keys(own)) if (!KEYS.includes(key)) throw refuse(`Unknown install option ${key}; remove it.`);
  if (document != null && !isDocument(document)) throw refuse('document cannot create images or listen for events; pass a Document.');
  if (root != null) {
    if (!(object(root) && [1, 9, 11].includes(root.nodeType) && typeof root.contains === 'function')) throw refuse("Invalid root; pass a Document, Element or ShadowRoot.");
    const Watcher = (document ?? globalThis.document)?.defaultView?.MutationObserver ?? globalThis.MutationObserver;
    if (typeof Watcher === 'function') {
      const probe = new Watcher(() => {});
      try { probe.observe(root, {childList: true}); } catch { throw refuse("Invalid root; pass a Document, Element or ShadowRoot."); } finally { probe.disconnect(); }
    }
  }
  if (probeURL !== undefined && typeof probeURL !== 'string') throw refuse("Invalid probeURL; pass an image URL string.");
  if (force !== undefined && typeof force !== 'boolean') throw refuse("Invalid force; use true or false.");
  if (workers !== undefined && (!Number.isInteger(workers) || workers < 1 || workers > 4)) throw refuse("Invalid workers; use a whole number from 1 to 4.");
  if (maxDecodedBytes !== undefined && (!Number.isSafeInteger(maxDecodedBytes) || maxDecodedBytes < 4)) throw refuse("Invalid maxDecodedBytes; use a whole number of at least 4.");
  if (maxInputBytes !== undefined && (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 1)) throw refuse("Invalid maxInputBytes; use a positive whole number.");
  if (rootMargin !== undefined) {
    if (typeof rootMargin !== 'string') throw refuse("Invalid rootMargin; use a CSS margin string.");
    const Observer = (document ?? globalThis.document)?.defaultView?.IntersectionObserver ?? globalThis.IntersectionObserver;
    if (typeof Observer === 'function') {
      try { new Observer(() => {}, {rootMargin}).disconnect(); } catch { throw refuse("Invalid rootMargin; use pixels or percent, such as \"1000px\"."); }
    }
  }
  for (const name of ['workerFactory', 'decode', 'onError']) if (own[name] !== undefined && typeof own[name] !== 'function') throw refuse(`Invalid ${name}; pass a function.`);
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
    if (native !== false) controller = {status: native ? 'native' : 'probe-blocked', disconnect() { this.status = 'closed'; }, refresh() {}};
    else {
      const {installFallback} = await import('./polyfill-runtime.mjs');
      if (!current()) return;
      controller = installFallback(document, own);
    }
    if (!current()) { controller.disconnect(); return; }
    const close = controller.disconnect;
    controller.disconnect = () => { close.call(controller); if (current()) installations.delete(document); };
    record.controller = controller;
    record.resolve(controller);
  })().catch(error => { if (current()) { installations.delete(document); record.reject(error); } });
  return record.promise;
}
