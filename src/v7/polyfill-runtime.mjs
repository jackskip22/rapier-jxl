const jxlURL = value => { try { return /\.jxl$/i.test(new URL(value, 'https://local.invalid/').pathname) || /^data:image\/jxl[;,]/i.test(value); } catch { return false; } };
const fail = (code, message) => Object.assign(new Error(message), {code});
export function srcset(value) {
  const entries = []; let at = 0;
  while (at < value.length) {
    while (/[\s,]/.test(value[at] ?? '') && at < value.length) at++;
    const start = at; while (at < value.length && !/\s/.test(value[at])) at++;
    let url = value.slice(start, at); if (!url) break;
    if (url.endsWith(',')) { entries.push({url: url.replace(/,+$/, ''), density: 1}); continue; }
    const descriptor = at; while (at < value.length && value[at] !== ',') at++;
    const text = value.slice(descriptor, at++).trim(), match = /^(?:(\d+(?:\.\d+)?)x|(\d+)w)?$/.exec(text);
    if (match && (!match[1] || +match[1] > 0) && (!match[2] || +match[2] > 0)) entries.push({url, density: match[1] ? +match[1] : match[2] ? undefined : 1, width: match[2] ? +match[2] : undefined});
  }
  return entries;
}
export function selectCandidate(entries, width, density) {
  return entries.map(entry => ({...entry, score: entry.width ? entry.width / Math.max(1, width) : entry.density ?? 1}))
    .sort((a, b) => a.score - b.score).find((entry, index, all) => entry.score >= density || index === all.length - 1);
}
const measuring = new WeakSet(), measures = new WeakMap();
function commaParts(value) {
  const parts = []; let depth = 0, quote = '', start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i]; if (c === '\\') { i++; continue; }
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '\"' || c === "'") quote = c;
    else if (c === '(') depth++; else if (c === ')') depth--;
    else if (c === ',' && !depth) { parts.push({value: value.slice(start, i), start}); start = i + 1; }
  }
  parts.push({value: value.slice(start), start}); return parts;
}
function sourceSize(value, element, window, document, watchMedia) {
  for (const {value: part} of commaParts(value || '100vw')) {
    const text = part.trim();
    if (text === 'auto') { if (element.loading === 'lazy') return element.getBoundingClientRect().width || window.innerWidth; continue; }
    let depth = 0, split = -1;
    for (let i = text.length - 1; i >= 0; i--) { if (text[i] === ')') depth++; else if (text[i] === '(') depth--; else if (/\s/.test(text[i]) && !depth) { split = i; break; } }
    const media = split < 0 ? '' : text.slice(0, split).trim(), length = text.slice(split + 1).trim();
    if (media) watchMedia(media);
    if (media && !window.matchMedia(media).matches || !window.CSS.supports('width', length) || length.includes('%')) continue;
    let measure = measures.get(document);
    if (!measure) { measure = document.createElement('div'); measuring.add(measure); measure.style.cssText = 'position:fixed;left:0;top:0;height:0;visibility:hidden;pointer-events:none;contain:strict'; document.documentElement.append(measure); measures.set(document, measure); }
    measure.style.width = length;
    const pixels = measure.getBoundingClientRect().width; if (pixels >= 0) return pixels;
  }
  return window.innerWidth;
}
export function cssURLs(value) {
  const result = []; const expression = /url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^)]*))\s*\)/gi;
  let match;
  while ((match = expression.exec(value))) { const raw = (match[1] ?? match[2] ?? match[3]).trim(); result.push({start: match.index, end: expression.lastIndex, url: raw.replace(/\\(["'()\\ ])/g, '$1')}); }
  const sets = /(?:-webkit-)?image-set\(/gi;
  while ((match = sets.exec(value))) {
    let end = sets.lastIndex, depth = 1, quote = '';
    for (; end < value.length && depth; end++) { const c = value[end]; if (c === '\\') { end++; continue; } if (quote) { if (c === quote) quote = ''; } else if (c === '"' || c === "'") quote = c; else if (c === '(') depth++; else if (c === ')') depth--; }
    const start = sets.lastIndex;
    for (const part of commaParts(value.slice(start, end - 1))) {
      const quoted = /^(\s*)(["'])((?:\\.|[^\\])*?)\2/.exec(part.value), typed = /type\(\s*["']image\/jxl["']\s*\)/i.test(part.value);
      if (quoted) result.push({start: start + part.start + quoted[1].length, end: start + part.start + quoted[0].length, url: quoted[3].replace(/\\(["'()\\ ])/g, '$1'), typed});
      else if (typed) for (const row of result) if (row.start >= start + part.start && row.end <= start + part.start + part.value.length) row.typed = true;
    }
    sets.lastIndex = end;
  }
  return result.sort((a, b) => a.start - b.start);
}
export function installFallback(document, options) {
  const window = document.defaultView, root = options.root ?? document;
  const maxBytes = options.maxDecodedBytes ?? 134217728, maxInputBytes = options.maxInputBytes ?? 33554432;
  const concurrency = options.workers ?? 2;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4 || !Number.isSafeInteger(maxInputBytes) || maxInputBytes < 1 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4)
    throw fail('JXL_OPTIONS', 'Polyfill limits must be positive integers; workers is 1 to 4.');
  const states = new Set(), elements = new Map(), cache = new Map(), jobs = [], clients = [], mediaListeners = new Map(), styleWrites = new WeakMap();
  let stopped = false, scheduled = false, active = 0, retainedBytes = 0, imageMode = 'blob';
  const controller = {status: 'active', refresh, disconnect, get stats() { return {elements: states.size, resources: cache.size, active, queued: jobs.length}; }};
  function report(error, element) { try { options.onError?.(error, element); } catch {} }
  function changeStyle(element, action) {
    const before = element.getAttribute('style'); action(); const after = element.getAttribute('style');
    if (before !== after) { let writes = styleWrites.get(element); if (!writes) styleWrites.set(element, writes = []); writes.push({before, after}); }
  }
  function attr(element, name, value, writes) {
    const before = element.getAttribute(name); if (before === value) return;
    writes.push({element, name, before, value}); value === null ? element.removeAttribute(name) : element.setAttribute(name, value);
  }
  function dropQueued(entry) {
    for (let i = jobs.length - 1; i >= 0; i--) {
      if (jobs[i].entry === entry) {
        const [job] = jobs.splice(i, 1);
        job.reject(entry.abort.signal.reason ?? fail('JXL_ABORTED', 'JPEG XL operation was canceled.'));
      }
    }
  }
  function restore(state, keepResources = false) {
    for (const write of state.writes.reverse()) {
      if (write.css) { if (write.element.style.getPropertyValue('background-image') === write.value) {
        const priority = write.element.style.getPropertyPriority('background-image');
        changeStyle(write.element, () => write.before ? write.element.style.setProperty('background-image', write.before, priority === write.appliedPriority ? write.priority : priority) : write.element.style.removeProperty('background-image'));
      } } else if (write.element.getAttribute(write.name) === write.value)
        write.before === null ? write.element.removeAttribute(write.name) : write.element.setAttribute(write.name, write.before);
    }
    state.writes = []; state.held = null;
    if (!keepResources) for (const entry of state.resources) { entry.users.delete(state); if (!entry.users.size) { entry.abort.abort(); dropQueued(entry); if (entry.objectURL) URL.revokeObjectURL(entry.objectURL); retainedBytes -= entry.bytes || 0; entry.bytes = 0; entry.blob = null; cache.delete(entry.key); } }
    if (!keepResources) state.resources = []; state.version++; state.busy = false;
  }
  const ownAttribute = (state, element, name) => {
    const write = state?.writes.find(write => write.element === element && write.name === name);
    return write && element.getAttribute(name) === write.value ? write.before : element.getAttribute(name);
  };
  function imageSource(element, state) {
    const read = (node, name) => ownAttribute(state, node, name) ?? '';
    let width = element.getBoundingClientRect().width || element.width || window.innerWidth;
    let source = element, typed = false;
    if (element.parentElement?.localName === 'picture') {
      for (const candidate of element.parentElement.children) {
        if (candidate === element) break;
        if (candidate.localName !== 'source') continue;
        if (candidate.media) { watchMedia(candidate.media); if (!window.matchMedia(candidate.media).matches) continue; }
        const type = read(candidate, 'type').toLowerCase();
        if (type && type !== 'image/jxl' && !/^(image\/(png|jpeg|webp|avif|gif|svg\+xml))$/.test(type)) continue;
        if (!read(candidate, 'srcset')) continue;
        source = candidate; typed = type === 'image/jxl'; break;
      }
    }
    const set = read(source, 'srcset');
    const candidates = srcset(set);
    if (candidates.some(row => row.width)) width = sourceSize(read(source, 'sizes') || read(element, 'sizes'), element, window, document, watchMedia);
    else if (source === element && read(element, 'src') && candidates.length && !candidates.some(row => row.density === 1)) candidates.push({url: read(element, 'src'), density: 1});
    const candidate = set ? selectCandidate(candidates, width, window.devicePixelRatio || 1) : null;
    const selected = set ? candidate?.url : read(element, 'src');
    const descriptor = candidate ? candidate.width ? ` ${candidate.width}w` : ` ${candidate.density ?? 1}x` : '';
    return selected && (typed || jxlURL(selected)) ? {url: new URL(selected, document.baseURI).href, descriptor, source, credentials: element.crossOrigin === 'use-credentials' ? 'include' : 'same-origin', referrerPolicy: element.referrerPolicy || ''} : null;
  }
  function desired(element, state, kind) {
    if (kind === 'image' && element.localName === 'img') { const image = imageSource(element, state); if (image) return {kind: 'img', ...image}; }
    if (kind === 'image' && element.namespaceURI === 'http://www.w3.org/2000/svg' && element.localName === 'image') {
      const href = ownAttribute(state, element, 'href') ?? element.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
      if (href && jxlURL(href)) return {kind: 'svg', url: new URL(href, document.baseURI).href};
    }
    if (kind === 'image') return null;
    const old = state?.writes.find(write => write.css);
    let background;
    if (old && element.style.getPropertyValue('background-image') === old.value) {
      const priority = element.style.getPropertyPriority('background-image');
      if (priority !== old.appliedPriority) old.priority = old.appliedPriority = priority;
      changeStyle(element, () => old.before ? element.style.setProperty('background-image', old.before, old.priority) : element.style.removeProperty('background-image'));
      background = window.getComputedStyle(element).backgroundImage;
      changeStyle(element, () => element.style.setProperty('background-image', old.value, old.appliedPriority));
    } else background = window.getComputedStyle(element).backgroundImage;
    const urls = cssURLs(background).filter(row => row.typed || jxlURL(row.url));
    return urls.length ? {kind: 'css', background, urls} : null;
  }
  function same(a, b) { return a && b && a.kind === b.kind && a.url === b.url && a.source === b.source && a.descriptor === b.descriptor && a.background === b.background && a.credentials === b.credentials && a.referrerPolicy === b.referrerPolicy; }
  function intact(state) {
    if (!state?.writes.length) return false;
    return state.writes.every(write => write.css
      ? write.element.style.getPropertyValue('background-image') === write.value
      : write.element.getAttribute(write.name) === write.value);
  }
  function register(element) {
    if (stopped || element.nodeType !== 1 || measuring.has(element)) return;
    let pair = elements.get(element); if (!pair) elements.set(element, pair = {});
    for (const kind of ['image', 'css']) {
      let state = pair[kind], next = desired(element, state, kind);
      if (same(state?.desired, next) && (!state?.writes.length || intact(state))) continue;
      if (state) { restore(state, Boolean(same(state.desired, next))); state.desired = next; state.failed = false; }
      if (!next) { if (state) { states.delete(state); delete pair[kind]; } continue; }
      if (!state) { state = {element, kind, desired: next, writes: [], resources: [], version: 0, visible: pair.image?.visible ?? pair.css?.visible ?? !observer, busy: false, failed: false}; pair[kind] = state; states.add(state); observer?.observe(element); }
      if (state.visible) load(state);
    }
    if (!pair.image && !pair.css) { elements.delete(element); observer?.unobserve(element); }
  }
  function resource(url, state) {
    const element = state.element, credentials = element.crossOrigin === 'use-credentials' ? 'include' : 'same-origin';
    const referrerPolicy = element.referrerPolicy || '';
    const key = JSON.stringify([url, credentials, referrerPolicy]); let entry = cache.get(key);
    if (!entry) {
      entry = {key, url, abort: new AbortController(), users: new Set()};
      entry.promise = new Promise((resolve, reject) => jobs.push({entry, credentials, referrerPolicy, resolve, reject})); cache.set(key, entry);
    }
    if (!entry.users.has(state)) { entry.users.add(state); state.resources.push(entry); }
    pump(); return entry.promise;
  }
  async function decoder() {
    if (options.decode) return options.decode;
    const {createCodec} = await import('./codec.mjs');
    if (stopped) throw fail('JXL_CLOSED', 'Polyfill disconnected.');
    const client = createCodec({module: 'rapier-jxl/decode', maxPendingBytes: maxInputBytes, maxPixels: Math.min(40000000, Math.floor(maxBytes / 32)), maxPendingJobs: 1, ...(options.workerFactory ? {workerFactory: options.workerFactory} : {})});
    clients.push(client); return (bytes, settings) => client.decode(bytes, settings);
  }
  const decoders = [];
  function pump() {
    while (!stopped && active < concurrency && jobs.length) {
      const job = jobs.shift();
      if (job.entry.abort.signal.aborted) {
        job.reject(job.entry.abort.signal.reason ?? fail('JXL_ABORTED', 'JPEG XL operation was canceled.'));
        continue;
      }
      const lane = decoders.findIndex(row => !row.busy);
      const row = lane < 0 ? {busy: false, decode: decoder()} : decoders[lane]; if (lane < 0) decoders.push(row);
      row.decode.catch(() => { const at = decoders.indexOf(row); if (at >= 0) decoders.splice(at, 1); }); row.busy = true; active++;
      run(job, row).then(job.resolve, error => {
        if (cache.get(job.entry.key) === job.entry && !job.entry.objectURL) {
          cache.delete(job.entry.key);
          for (const user of job.entry.users) user.resources = user.resources.filter(r => r !== job.entry);
          job.entry.users.clear();
        }
        job.reject(error);
      }).finally(() => { row.busy = false; active--; pump(); });
    }
  }
  async function run({entry, credentials, referrerPolicy}, row) {
    const signal = entry.abort.signal; signal.throwIfAborted();
    const response = await fetch(entry.url, {signal, mode: 'cors', credentials, referrerPolicy});
    if (!response.ok) throw fail('JXL_FETCH', `Image request failed (${response.status}).`);
    const declared = Number(response.headers.get('content-length')); if (declared > maxInputBytes) throw fail('JXL_LIMIT', 'Image exceeds maxInputBytes.');
    const reader = response.body?.getReader(); let bytes;
    if (reader) {
      const chunks = []; let length = 0;
      try { for (;;) { const {done, value} = await reader.read(); if (done) break; length += value.length; if (length > maxInputBytes) throw fail('JXL_LIMIT', 'Image exceeds maxInputBytes.'); chunks.push(value); } }
      catch (error) { await reader.cancel().catch(() => {}); throw error; }
      bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    } else { bytes = new Uint8Array(await response.arrayBuffer()); if (bytes.length > maxInputBytes) throw fail('JXL_LIMIT', 'Image exceeds maxInputBytes.'); }
    signal.throwIfAborted();
    const decoded = await (await row.decode)(bytes, {signal, format: 'auto', colorSpace: 'original', applyOrientation: true, unpremultiplyAlpha: true,
      maxPixels: Math.floor(maxBytes / 32), maxTotalSamples: Math.floor(maxBytes / 8), maxInputBytes});
    const {decodedPNG} = await import('./polyfill-png.mjs'); const blob = await decodedPNG(decoded, {signal, maxBytes});
    signal.throwIfAborted();
    if (retainedBytes + blob.size > maxBytes) throw fail('JXL_MEMORY', 'Visible decoded images exceed maxDecodedBytes.');
    let mode = imageMode, output = await displayURL(blob);
    if (mode !== imageMode) { URL.revokeObjectURL(output); output = await displayURL(blob); }
    if (signal.aborted || stopped) { URL.revokeObjectURL(output); signal.throwIfAborted(); throw fail('JXL_CLOSED', 'Polyfill disconnected.'); }
    if (retainedBytes + blob.size > maxBytes) { URL.revokeObjectURL(output); throw fail('JXL_MEMORY', 'Visible decoded images exceed maxDecodedBytes.'); }
    entry.bytes = blob.size; retainedBytes += blob.size; entry.blob = blob; entry.objectURL = output; return output;
  }
  async function displayURL(blob) {
    if (imageMode === 'blob') return URL.createObjectURL(blob);
    if (imageMode !== 'data') throw fail('JXL_IMAGE_CSP', 'Image policy refuses decoded images.');
    return new Promise((resolve, reject) => { const reader = new window.FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
  }
  async function load(state) {
    if (stopped || state.busy || state.failed || state.writes.length || !state.desired) return;
    if (imageMode === 'blocked') {
      state.failed = true;
      report(fail('JXL_IMAGE_CSP', 'Image policy refuses decoded image URLs.'), state.element);
      return;
    }
    state.busy = true; const version = state.version, item = state.desired;
    try {
      const urls = item.kind === 'css' ? item.urls.map(row => new URL(row.url, document.baseURI).href) : [item.url];
      const answers = await Promise.all(urls.map(url => resource(url, state)));
      if (stopped || version !== state.version || !state.element.isConnected) return;
      if (item.kind !== 'img') {
        const images = answers.map(url => { const image = new window.Image(); image.src = url; return image; });
        await Promise.all(images.map(image => image.decode?.().catch(() => {})));
        if (stopped || version !== state.version || !state.element.isConnected) return;
        state.held = images;
      }
      const element = state.element;
      if (item.kind === 'img') {
        if (item.source !== element) { attr(item.source, 'type', 'image/png', state.writes); attr(item.source, 'srcset', answers[0] + item.descriptor, state.writes); }
        else { attr(element, 'srcset', item.descriptor ? answers[0] + item.descriptor : null, state.writes); attr(element, 'src', answers[0], state.writes); }
        element.decode?.().catch(() => {});
      } else if (item.kind === 'svg') attr(element, 'href', answers[0], state.writes);
      else {
        let text = item.background;
        for (let index = item.urls.length - 1; index >= 0; index--) { const row = item.urls[index]; text = text.slice(0, row.start) + 'url("' + answers[index] + '")' + text.slice(row.end); }
        text = text.replace(/type\(\s*(["'])image\/jxl\1\s*\)/gi, 'type("image/png")');
        const before = element.style.getPropertyValue('background-image'), priority = element.style.getPropertyPriority('background-image');
        changeStyle(element, () => element.style.setProperty('background-image', text, 'important'));
        state.writes.push({element, css: true, name: 'style', before, priority, appliedPriority: 'important', value: element.style.getPropertyValue('background-image')});
      }
    } catch (error) { if (version === state.version && !stopped) { state.failed = true; report(error, state.element); } }
    finally { if (version === state.version) state.busy = false; }
  }
  const observer = typeof window.IntersectionObserver === 'function' ? new window.IntersectionObserver(entries => {
    for (const {target, isIntersecting} of entries) for (const state of Object.values(elements.get(target) ?? {})) { state.visible = isIntersecting;
      if (isIntersecting) load(state); else if (state.resources.length) restore(state);
    }
  }, {rootMargin: options.rootMargin ?? '1000px'}) : null;
  function watchMedia(query) {
    if (mediaListeners.has(query)) return;
    const media = window.matchMedia(query); media.addEventListener?.('change', refresh); mediaListeners.set(query, media);
  }
  function watchStyleMedia(rules) {
    for (const rule of rules || []) {
      if (rule.media?.mediaText) watchMedia(rule.media.mediaText);
      try { if (rule.cssRules) watchStyleMedia(rule.cssRules); } catch {}
    }
  }
  function scan(node = root) {
    for (const sheet of document.styleSheets || []) { try { watchStyleMedia(sheet.cssRules); } catch {} }
    watchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    if (node.nodeType === 1) register(node); for (const element of node.querySelectorAll?.('*') ?? []) register(element); }
  function refresh() { if (scheduled || stopped) return; scheduled = true; queueMicrotask(() => { scheduled = false; if (stopped) return;
    for (const [element, pair] of elements) if (!element.isConnected || !root.contains(element)) { for (const state of Object.values(pair)) { restore(state); states.delete(state); } observer?.unobserve(element); elements.delete(element); }
    scan();
  }); }
  const mutations = new window.MutationObserver(records => {
    let changed = false;
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      if (measuring.has(record.target) || record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].every(node => measuring.has(node))) continue;
      if (record.attributeName === 'style') {
        const next = records.slice(index + 1).find(row => row.target === record.target && row.attributeName === 'style');
        const after = next ? next.oldValue : record.target.getAttribute('style'), writes = styleWrites.get(record.target);
        const own = writes?.findIndex(write => write.before === record.oldValue && write.after === after) ?? -1;
        if (own >= 0) { writes.splice(own, 1); continue; }
        changed = true; continue;
      }
      if (record.type === 'childList' || ![...states].some(state => state.writes.some(write => !write.css && write.element === record.target && write.name === record.attributeName && write.value === record.target.getAttribute(record.attributeName)))) changed = true;
    }
    if (changed) refresh();
  });
  mutations.observe(root, {subtree: true, childList: true, attributes: true, attributeOldValue: true, attributeFilter: ['src', 'srcset', 'sizes', 'type', 'media', 'href', 'style', 'class', 'loading', 'crossorigin', 'referrerpolicy']});
  window.addEventListener('resize', refresh); document.addEventListener('load', refresh, true);
  const policy = async event => {
    if (stopped || event.disposition !== 'enforce' || event.effectiveDirective !== 'img-src') return;
    if (imageMode === 'blob' && /^(blob|blob:)/.test(event.blockedURI)) {
      imageMode = 'data';
      for (const entry of cache.values()) if (entry.blob) {
        try { const previous = entry.objectURL, replacement = await displayURL(entry.blob);
          if (stopped || !entry.users.size || entry.abort.signal.aborted) { URL.revokeObjectURL(replacement); continue; }
          entry.objectURL = replacement; entry.promise = Promise.resolve(replacement); URL.revokeObjectURL(previous); }
        catch (error) { for (const state of entry.users) report(error, state.element); }
      }
      if (stopped) return;
      for (const state of states) if (state.writes.length || state.busy) { restore(state, true); if (state.visible) load(state); }
    } else if (imageMode === 'data' && /^(data|data:)/.test(event.blockedURI)) {
      imageMode = 'blocked';
      for (const state of states) { restore(state); state.failed = true; report(fail('JXL_IMAGE_CSP', 'Image policy refuses decoded image URLs.'), state.element); }
    }
  };
  document.addEventListener('securitypolicyviolation', policy);
  function disconnect() { if (stopped) return; stopped = true; mutations.disconnect(); observer?.disconnect(); window.removeEventListener('resize', refresh); document.removeEventListener('load', refresh, true); document.removeEventListener('securitypolicyviolation', policy);
    for (const media of mediaListeners.values()) media.removeEventListener?.('change', refresh); mediaListeners.clear();
    for (const state of states.values()) restore(state); states.clear(); elements.clear(); for (const client of clients) client.close(); for (const job of jobs.splice(0)) job.reject(fail('JXL_CLOSED', 'Polyfill disconnected.')); measures.get(document)?.remove(); measures.delete(document); controller.status = 'closed';
  }
  scan(); return controller;
}

