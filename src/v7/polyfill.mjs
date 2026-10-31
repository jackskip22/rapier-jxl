const PROBE = 'data:image/jxl;base64,/woAEBBQXAgIAgEAlAJLGJuccYQDOIADOCBKwDkFAQAgRIAIEAEiQOT/kXv6HlpnV1VVVSVJkhBQd3d3d3f///+/VW9mZmYG/t+/57+HxpxzrrXPvUmSJARUVVVVVVX////Pva+7u7sb/t+/57+HxpxzrrXPvUmSJARUVVVVVVX////Pva+7u7sb/t+/57+HxpxzrrXPvUmSJARUVVVVVVX////Pva+7u7v7AiEAePh79GM=';
const probes = new WeakMap(), installations = new WeakMap(), lastInstallations = new WeakMap();
export function supportsJXL(document = globalThis.document, probeURL = PROBE) {
  if (!document) return Promise.resolve(false);
  const key = String(probeURL);
  let resolvedKey = key;
  try { resolvedKey = new URL(key, document.baseURI || 'https://local.invalid/').href; } catch {}
  let cache = probes.get(document); if (!cache) probes.set(document, cache = new Map());
  if (!cache.has(key)) cache.set(key, new Promise(resolve => {
    const image = document.createElement('img'); let blocked = false, finished = false;
    const violation = event => { if (event.disposition === 'enforce' && event.effectiveDirective === 'img-src' &&
      (event.blockedURI === 'data' && key.startsWith('data:') || event.blockedURI === key || event.blockedURI === resolvedKey)) blocked = true; };
    const finish = result => { if (finished) return; finished = true; clearTimeout(timer); document.removeEventListener('securitypolicyviolation', violation); image.onload = image.onerror = null; resolve(result); };
    document.addEventListener('securitypolicyviolation', violation);
    const timer = setTimeout(() => finish(null), 5000);
    image.onload = () => finish(image.naturalWidth > 0 && image.naturalHeight > 0);
    image.onerror = () => setTimeout(() => finish(blocked ? null : false), 0);
    image.src = key;
  }));
  return cache.get(key);
}
const refuse = message => Object.assign(new TypeError(message), {code: 'JXL_OPTIONS'});
const object = value => value !== null && (typeof value === 'object' || typeof value === 'function');
function admit(options) {
  if (options === undefined) return {};
  if (!object(options)) throw refuse('install(options): options is an object.');
  const own = {...options}, {document, root, probeURL, force, workers, maxDecodedBytes, maxInputBytes, rootMargin} = own;
  if (Object.hasOwn(own, 'maxBytes')) throw refuse('maxBytes is now maxDecodedBytes.');
  if (document != null && (!object(document) || typeof document.createElement !== 'function')) throw refuse('document is a Document.');
  if (root != null) {
    if (!(object(root) && [1, 9, 11].includes(root.nodeType) && typeof root.contains === 'function')) throw refuse('root is a Document, Element or ShadowRoot.');
    const Watcher = (document ?? globalThis.document)?.defaultView?.MutationObserver ?? globalThis.MutationObserver;
    if (typeof Watcher === 'function') {
      const probe = new Watcher(() => {});
      try { probe.observe(root, {childList: true}); } catch { throw refuse('root is a Document, Element or ShadowRoot.'); } finally { probe.disconnect(); }
    }
  }
  if (probeURL !== undefined && typeof probeURL !== 'string') throw refuse('probeURL is a string.');
  if (force !== undefined && typeof force !== 'boolean') throw refuse('force is true or false.');
  if (workers !== undefined && (!Number.isInteger(workers) || workers < 1 || workers > 4)) throw refuse('workers is 1 to 4.');
  if (maxDecodedBytes !== undefined && (!Number.isSafeInteger(maxDecodedBytes) || maxDecodedBytes < 4)) throw refuse('maxDecodedBytes is a whole number of at least 4.');
  if (maxInputBytes !== undefined && (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 1)) throw refuse('maxInputBytes is a positive whole number.');
  if (rootMargin !== undefined) {
    if (typeof rootMargin !== 'string') throw refuse('rootMargin is a string.');
    const Observer = (document ?? globalThis.document)?.defaultView?.IntersectionObserver ?? globalThis.IntersectionObserver;
    if (typeof Observer === 'function') {
      try { new Observer(() => {}, {rootMargin}).disconnect(); } catch { throw refuse('rootMargin is a CSS margin in pixels or percent, such as "1000px".'); }
    }
  }
  for (const name of ['workerFactory', 'decode', 'onError']) if (own[name] !== undefined && typeof own[name] !== 'function') throw refuse(`${name} is a function.`);
  return own;
}
export function install(options) {
  let own;
  try { own = admit(options); } catch (error) { return Promise.reject(error); }
  return begin(own, false);
}
function begin(options, automatic) {
  const document = options.document ?? globalThis.document;
  if (!document) return Promise.resolve({status: 'unavailable', disconnect() {}, refresh() {}});
  const previous = installations.get(document);
  if (previous && (automatic || !previous.automatic)) return previous.promise;
  const record = {automatic};
  record.promise = new Promise((resolve, reject) => { record.resolve = resolve; record.reject = reject; });
  installations.set(document, record);
  lastInstallations.set(document, record.promise);
  const current = () => installations.get(document) === record;
  if (previous) previous.resolve(record.promise);
  (async () => {
    previous?.controller?.disconnect();
    const native = options.force ? false : await supportsJXL(document, options.probeURL);
    if (!current()) return;
    let controller;
    if (native !== false) controller = {status: native ? 'native' : 'probe-blocked', disconnect() { this.status = 'closed'; }, refresh() {}};
    else {
      const {installFallback} = await import('./polyfill-runtime.mjs');
      if (!current()) return;
      controller = installFallback(document, options);
    }
    if (!current()) { controller.disconnect(); return; }
    const close = controller.disconnect;
    controller.disconnect = () => { close.call(controller); if (current()) installations.delete(document); };
    record.controller = controller;
    record.resolve(controller);
  })().catch(error => { if (current()) { installations.delete(document); record.reject(error); } });
  return record.promise;
}
export const ready = globalThis.document ? new Promise((resolve, reject) => setTimeout(() => {
  const doc = globalThis.document;
  const existing = doc && lastInstallations.get(doc);
  (existing || begin({}, true)).then(resolve, reject);
}, 0)) : Promise.resolve(null);
