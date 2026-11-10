// SPDX-License-Identifier: MIT

export const elsewhere = url => typeof location !== 'undefined' && !!url.origin && url.origin !== 'null' && url.origin !== location.origin;
export const program = href => 'const q=[],k=e=>q.push(e);addEventListener("message",k);import(' + JSON.stringify(href) +
  ').then(()=>{removeEventListener("message",k);for(const e of q)dispatchEvent(new MessageEvent("message",e))},e=>setTimeout(()=>{throw e}))';

export function startWorker(file) {
  const url = file.url?.();
  if (!url || !elsewhere(url)) return file.worker();
  const source = URL.createObjectURL(new Blob([program(url.href)], {type: 'text/javascript'})), done = () => URL.revokeObjectURL(source);
  let worker;
  try { worker = new Worker(source, {type: 'module'}); } catch (error) { done(); throw error; }
  const terminate = worker.terminate;
  worker.addEventListener('message', done, {once: true});
  worker.addEventListener('error', done, {once: true});
  worker.terminate = function () { done(); return terminate.call(this); };
  return worker;
}

const DEPS = /\/deps\/[^/]+$/, folders = new Map(), LOOKUP_MS = 5000;
const VITE_EXCLUDE = "Vite's dev server did not serve the JPEG XL worker file: set optimizeDeps: {exclude: ['rapier-jxl']} in the Vite config.";
export function packageFolder(url, fetcher = globalThis.fetch, wait = LOOKUP_MS) {
  const folder = new URL('./', url).href;
  let lookup = folders.get(folder);
  if (lookup) return lookup;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer;
  lookup = Promise.race([(async () => {
    const response = await fetcher(new URL('_metadata.json', folder), {redirect: 'error', signal: controller?.signal});
    if (!response.ok) return null;
    for (const [id, entry] of Object.entries((await response.json())?.optimized ?? {}))
      if ((id === 'rapier-jxl' || id.startsWith('rapier-jxl/')) && typeof entry?.src === 'string' && /(^|\/)dist\/[^/]+$/.test(entry.src)) {
        const found = new URL(entry.src.replace(/[^/]+$/, ''), folder);
        return found.origin === new URL(folder).origin ? found : null;
      }
    return null;
  })(), new Promise(done => { timer = setTimeout(() => { controller?.abort(); done(null); }, wait); })])
    .catch(() => null).then(found => { clearTimeout(timer); if (!found && folders.get(folder) === lookup) folders.delete(folder); return found; });
  folders.set(folder, lookup);
  return lookup;
}
export function relocatable(start, url, {fetcher, wait, base = import.meta.url} = {}) {
  if (!DEPS.test(url.pathname) || !/[?&]v=/.test(base) || typeof EventTarget !== 'function') return start();
  const relay = new EventTarget();
  let worker = null, held = [], ended = false;
  const copy = ({message, error, code}) => Object.defineProperties(new Event('error'), {
    ...(message && {message: {value: message}}), ...(error && {error: {value: error}}), ...(typeof code === 'string' && {code: {value: code}})});
  packageFolder(url, fetcher, wait).then(folder => {
    if (ended) return;
    let made = null;
    try {
      made = folder ? new Worker(new URL(url.pathname.slice(url.pathname.lastIndexOf('/') + 1), folder), {type: 'module'}) : start();
      let answered = false;
      made.addEventListener('message', event => { answered = true; relay.dispatchEvent(new MessageEvent('message', {data: event.data, ports: [...(event.ports ?? [])]})); });
      made.addEventListener('messageerror', () => relay.dispatchEvent(new MessageEvent('messageerror')));
      made.addEventListener('error', event => relay.dispatchEvent(copy(!answered && !event.message && !event.error ? {code: 'JXL_WORKER', message: VITE_EXCLUDE} : event)));
      worker = made;
      for (const args of held) made.postMessage(...args);
      held = null;
    } catch (error) {
      held = null; worker = null;
      try { made?.terminate(); } catch {}
      relay.dispatchEvent(copy({message: error?.message || 'The JPEG XL worker did not start.', error, code: error?.code}));
    }
  });
  return Object.assign(relay, {
    postMessage(...args) { if (worker) worker.postMessage(...args); else if (held) held.push(args); },
    terminate() { ended = true; held = null; return worker?.terminate(); },
  });
}
