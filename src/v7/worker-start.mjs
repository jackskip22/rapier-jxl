// SPDX-License-Identifier: MIT

export const elsewhere = url => typeof location !== 'undefined' && !!url.origin && url.origin !== 'null' && url.protocol !== 'file:' && url.origin !== location.origin;
export const program = href => 'const q=[],k=e=>q.push(e);addEventListener("message",k);import(' + JSON.stringify(href) +
  ').then(()=>{removeEventListener("message",k);for(const e of q)dispatchEvent(new MessageEvent("message",e))},e=>setTimeout(()=>{throw e}))';

export function startWorker(file) {
  const url = file.url?.();
  if (!url || !elsewhere(url)) return file.worker();
  const source = URL.createObjectURL(new Blob([program(url.href)], {type: 'text/javascript'})), done = () => URL.revokeObjectURL(source);
  let worker;
  try { worker = new Worker(source, {type: 'module', ...file.role && {name: file.role}}); } catch (error) { done(); throw error; }
  const terminate = worker.terminate;
  worker.addEventListener('message', done, {once: true});
  worker.addEventListener('error', done, {once: true});
  worker.terminate = function () { done(); return terminate.call(this); };
  return worker;
}

const DEPS = /\/deps\/[^/]+$/, folders = new Map(), NAME = 'jpegxl';
const VITE_EXCLUDE = "Vite's dev server did not serve the JPEG XL worker file: set optimizeDeps: {exclude: ['jpegxl']} in the Vite config.";
const workerSource = (id, src) => {
  if (!(id === NAME || id.startsWith(NAME + '/')) || typeof src !== 'string') return null;
  return /(^|\/)dist\/[^/]+$/.test(src) ? src : null;
};
const VERSION = typeof __RAPIER_JXL_VERSION__ !== 'undefined' ? __RAPIER_JXL_VERSION__ : null;
function packageFolder(url, {fetcher = globalThis.fetch, base = '', version = VERSION} = {}) {
  const folder = new URL('./', url).href, caller = new URL(base, folder).pathname.split('/').pop(), key = folder + '\n' + caller + '\n' + version;
  let lookup = folders.get(key);
  if (lookup) return lookup;
  const origin = new URL(folder).origin;
  const read = async path => { const response = await fetcher(new URL(path, folder), {redirect: 'error'}); return response.ok ? response.json() : null; };
  lookup = (async () => {
    const candidates = [];
    for (const [id, entry] of Object.entries((await read('_metadata.json'))?.optimized ?? {})) {
      const src = workerSource(id, entry?.src);
      if (!src) continue;
      const found = new URL(src.replace(/[^/]+$/, ''), folder);
      if (found.origin !== origin) continue;
      if (entry.file === caller) return found;
      if (!candidates.some(c => c.found.href === found.href)) candidates.push({found});
    }
    if (candidates.length < 2) return candidates[0]?.found ?? null;
    const mine = [];
    for (const candidate of candidates) {
      const pkg = await read(new URL('../package.json', candidate.found).href).catch(() => null);
      if (pkg?.version === version) mine.push({...candidate, name: pkg.name});
    }
    if (mine.length > 1 && mine.every(m => m.name === mine[0].name)) return mine[0].found;
    return mine.length === 1 ? mine[0].found : null;
  })().catch(() => null).then(found => { if (!found && folders.get(key) === lookup) folders.delete(key); return found; });
  folders.set(key, lookup);
  return lookup;
}
export function relocatable(start, url, {fetcher, base = import.meta.url, version, role} = {}) {
  if (!DEPS.test(url.pathname) || !/[?&]v=/.test(base) || typeof EventTarget !== 'function') return start();
  const relay = new EventTarget();
  let worker = null, held = [], ended = false;
  const copy = ({message, error, code}) => Object.defineProperties(new Event('error'), {
    ...(message && {message: {value: message}}), ...(error && {error: {value: error}}), ...(typeof code === 'string' && {code: {value: code}})});
  packageFolder(url, {fetcher, base, ...version !== undefined && {version}}).then(folder => {
    if (ended) return;
    let made = null;
    try {
      if (!folder) throw Object.assign(new Error(VITE_EXCLUDE), {code: 'JXL_WORKER'});
      made = new Worker(new URL(url.pathname.slice(url.pathname.lastIndexOf('/') + 1), folder), {type: 'module', ...role && {name: role}});
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
      relay.dispatchEvent(copy({message: error?.message || 'worker: check source/config', error, code: error?.code}));
    }
  });
  return Object.assign(relay, {
    postMessage(...args) { if (worker) worker.postMessage(...args); else if (held) held.push(args); },
    terminate() { ended = true; held = null; return worker?.terminate(); },
  });
}

export async function importFile(url, {fetcher, base = import.meta.url, version} = {}) {
  let href = url.href;
  if (DEPS.test(url.pathname) && /[?&]v=/.test(base)) {
    const folder = await packageFolder(url, {fetcher, base, ...version !== undefined && {version}});
    if (!folder) throw Object.assign(new Error(VITE_EXCLUDE), {code: 'JXL_WORKER'});
    href = new URL(url.pathname.slice(url.pathname.lastIndexOf('/') + 1), folder).href;
  }
  return import(/* webpackIgnore: true */ /* @vite-ignore */ href);
}
