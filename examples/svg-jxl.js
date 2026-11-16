// Any SVG (text, Blob or File) with its embedded raster pictures as JPEG XL: import { svgJxl } from 'jpegxl/svg-jxl';
//   const { svg, record } = await svgJxl(input, { fidelity: { quality: 92 } }); // smallest of lossy, exact and the original
//   await svgJxl(input, { fidelity: 'exact' });                                 // JPEGs restorable, the rest lossless
// Not a sanitizer: the SVG's own scripts, styles and links pass through unchanged. Sanitize an untrusted SVG yourself.
// Each module is loaded on first use; in a browser each runs in its own worker.
let jpeg, capture, still;
// The browser's own cost, measured: drawing a 774 KB, 16,000 x 16,000 PNG to a canvas took Chrome 155 25.7 s and
// 3.1 GB, before an encoder could refuse it. This example skips pictures over 40 MP.
const MAX_PIXELS = 40_000_000;
const jpegModule = () => jpeg ??= import('jpegxl/jpeg');
const stillModule = () => still ??= import('jpegxl');

const KEYS = ['fidelity', 'effort', 'webgpu', 'signal', 'onProgress', 'codec', 'cache'];
export async function svgJxl(input, options = {}) {
  if (typeof input !== 'string' && !(typeof Blob === 'function' && input instanceof Blob)) throw Object.assign(new TypeError("Invalid input; use SVG text or a Blob."), { code: 'JXL_INPUT' });
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw Object.assign(new TypeError("Invalid options; pass an object."), { code: 'JXL_OPTIONS' });
  const refuse = message => Object.assign(new TypeError(message), { code: 'JXL_OPTIONS' });
  for (const key of Object.keys(options)) if (!KEYS.includes(key)) throw refuse(`Unknown svgJxl option ${key}; remove it.`);
  const { fidelity = { quality: 92 }, effort, webgpu, signal, onProgress, codec, cache = new Map() } = options;
  // fidelity as encode takes it: 'exact', or {quality} from 1 to 100 (100 is exact).
  const named = fidelity !== null && typeof fidelity === 'object' && !Array.isArray(fidelity) && Object.keys(fidelity).join() === 'quality';
  if (fidelity !== 'exact' && !(named && typeof fidelity.quality === 'number' && fidelity.quality >= 1 && fidelity.quality <= 100))
    throw refuse("Invalid fidelity; use 'exact' or {quality: 1 to 100}.");
  const exact = fidelity === 'exact', quality = exact ? 1 : fidelity.quality / 100;
  if (effort !== undefined && !(Number.isInteger(effort) && effort >= 1 && effort <= 9)) throw refuse("Invalid effort; use an integer from 1 to 9.");
  if (webgpu !== undefined && webgpu !== 'required' && webgpu !== false) throw refuse("Invalid webgpu; use 'required', false, or omit it.");
  if (codec !== undefined && typeof codec?.capture !== 'function') throw refuse("Invalid codec; pass a capture module, such as import * as codec from 'jpegxl/capture-complete'.");
  if (signal !== undefined && (!signal || typeof signal !== 'object' || typeof signal.aborted !== 'boolean' ||
      ['throwIfAborted', 'addEventListener', 'removeEventListener'].some(key => typeof signal[key] !== 'function'))) throw refuse("Invalid signal; pass an AbortSignal.");
  if (onProgress !== undefined && typeof onProgress !== 'function') throw refuse("Invalid onProgress; pass a function.");
  if (cache === null || typeof cache !== 'object' || typeof cache.has !== 'function' || typeof cache.get !== 'function' || typeof cache.set !== 'function') throw refuse("Invalid cache; use a Map.");
  signal?.throwIfAborted();
  // A Blob or File is scanned as one character per byte and written back unchanged, whatever its encoding.
  const text = typeof input === 'string', svg = text ? input : latin1(new Uint8Array(await abortable(input.arrayBuffer(), signal)));
  const captureCodec = async () => codec ?? await (capture ??= import('jpegxl/capture-complete'));
  const decoder = !!codec || typeof createImageBitmap === 'function', lossy = decoder && !exact && quality < 1;
  const found = pictures(svg), done = [];
  let callbackFault;
  const report = onProgress && (async fraction => {
    try { await abortable(onProgress(fraction), signal); } catch (reason) { callbackFault = {reason}; throw reason; }
  });
  const captureCall = async (input, options) => {
    try { return await (await captureCodec()).capture(input, options); }
    // An app's codec refusing one picture with a code (JXL_INPUT for a file it cannot read) is that picture's answer, as
    // the module's own refusal is; any other failure of the app's codec is the call's.
    catch (reason) { if (codec && !(typeof reason?.code === 'string' && reason.code.startsWith('JXL_'))) callbackFault = {reason}; throw reason; }
  };
  for (const p of found) if (p.bytes && !p.kept) p.route = p.kind === 'jpeg' ? 'jpeg' : p.kind === 'png' || decoder ? 'lossless' : (p.kept = 'no-decoder', undefined);
  const key = p => `${codecId(codec)} ${lossy ? quality : 'exact'} ${effort} ${webgpu} ${p.uri}`;
  const queue = [...new Set(found.filter(p => p.route && !cache.has(key(p))).map(key))];
  let count = 0;
  const total = queue.length;
  await report?.(0); signal?.throwIfAborted();
  const code = async p => {
    // Sized by its header as a browser sizes it, before any decode or draw.
    const size = dimensions(p.bytes, p.kind);
    if (!size || !size[0] || !size[1] || size[0] * size[1] > MAX_PIXELS) { count++; return { out: null, kept: size?.[0] && size[1] ? 'JXL_DIMENSIONS' : 'no-size', tries: {} }; }
    // Under 64 pixels a side (below the photo check's floor) a picture takes the exact route only.
    const tryLossy = lossy && Math.min(size[0], size[1]) >= 64;
    const blob = new Blob([p.bytes], { type: `image/${p.kind}` }), part = tryLossy ? 0.5 : 1;
    const encode = async (route, from) => {
      const job = { maxPixels: MAX_PIXELS, ...(effort !== undefined && { effort }), ...(signal && { signal }),
        ...(report && { onProgress: fraction => report((count + from + fraction * part) / total) }) },
        gpu = webgpu !== undefined && { webgpu };
      if (route === 'quality') {
        // The whole picture one photo (a box past an oriented side is cut to the picture); capture-complete makes the look.
        const side = Math.max(size[0], size[1]);
        return { out: await captureCall(blob, { ...job, fidelity: { quality: Math.max(1, quality * 100) }, ...gpu, photoRects: [{ x: 0, y: 0, width: side, height: side }] }) };
      }
      if (route === 'jpeg') return { out: await (await jpegModule()).recompress(p.bytes, job) };
      let reader;
      if (p.alpha || !decoder) {
        // The file's own samples (the browser premultiplies); on refusal the browser's decode, named in `reader`.
        try { return { out: await (await stillModule()).encode(blob, { ...job, fidelity: 'exact' }) }; }
        catch (error) { if (callbackFault && Object.is(callbackFault.reason, error) || signal?.aborted || !decoder) throw error; reader = error?.code ?? error?.name ?? 'error'; }
      }
      return { out: await captureCall(blob, { ...job, fidelity: 'exact', ...gpu }), reader };
    };
    const tries = {};
    let out = null, route, reader, kept;
    for (const [r, from] of [[p.route, 0], ...(tryLossy ? [['quality', 0.5]] : [])]) {
      try {
        const made = await encode(r, from);
        const result = made.out;
        if (!result.meetsTarget) throw Object.assign(new Error(result.reason.message), {code: result.reason.code});
        made.out = result.bytes;
        tries[r] = made.out.length;
        if (!out || made.out.length < out.length) ({ out, reader } = made), route = r;
      } catch (error) {
        if (callbackFault && Object.is(callbackFault.reason, error)) throw error;
        if (signal?.aborted) throw signal.reason;
        kept ??= error?.code ?? error?.name ?? 'error';
      }
    }
    if (out && out.length >= p.bytes.length) { out = null; kept = 'larger'; }
    count++;
    return { out, kept: out ? undefined : kept, reader, route, tries, alpha: p.alpha };
  };
  const parts = [];
  let at = 0;
  for (const p of found) {
    const k = p.route && key(p);
    if (k && !cache.has(k)) cache.set(k, await code(p));
    const { out: jxl = null, kept, reader, route, tries, alpha } = (k && cache.get(k)) ?? {};
    if (jxl) { parts.push(svg.slice(at, p.start), `data:image/jxl;base64,${base64(jxl)}`); at = p.end; }
    done.push({ kind: p.kind, ...(p.url ? { url: p.url } : { bytes: p.bytes?.length ?? p.length, jxl: jxl ? jxl.length : p.bytes?.length ?? p.length }),
      route: jxl ? route : 'kept', ...(tries && { tries }), ...(!jxl && { kept: p.kept ?? kept }), ...(jxl && alpha && route === 'lossless' && (reader ? { reader } : { alpha: true })) });
  }
  parts.push(svg.slice(at));
  const out = parts.join('');
  const record = { bytes: text ? new TextEncoder().encode(svg).length : input.size, jxl: text ? new TextEncoder().encode(out).length : out.length, pictures: done, fonts: fonts(svg) };
  await report?.(1); signal?.throwIfAborted();
  if (text) return { svg: out, record };
  const type = input.type || 'image/svg+xml';
  const bytes = Uint8Array.from(out, c => c.charCodeAt(0));
  const file = typeof File === 'function' && input instanceof File ? new File([bytes], input.name, { type, lastModified: input.lastModified }) : new Blob([bytes], { type });
  return { svg: file, record };
}
const codecs = new WeakMap();
let codecCount = 0;
const codecId = codec => { if (!codec) return 0; if (!codecs.has(codec)) codecs.set(codec, ++codecCount); return codecs.get(codec); };
const latin1 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return s; };

function abortable(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (accept, value) => {
      if (done) return;
      done = true;
      try { signal.removeEventListener('abort', stop); }
      catch (reason) { if (accept === resolve) { reject(reason); return; } }
      accept(value);
    };
    const stop = () => {
      try { if (signal.aborted) finish(reject, signal.reason); }
      catch (reason) { finish(reject, reason); }
    };
    Promise.resolve(promise).then(value => finish(resolve, value), reason => finish(reject, reason));
    try { signal.addEventListener('abort', stop, { once: true }); stop(); }
    catch (reason) { finish(reject, reason); }
  });
}

// Where a browser loads a picture: picture attributes and CSS url() outside strings; scanned, never parsed or run.
const PICTURE = { img: 'src', image: 'href', feImage: 'href', video: 'poster', source: 'src' };
const MAGIC = [[0, [0xFF, 0xD8, 0xFF], 'jpeg'], [0, [0x89, 0x50, 0x4E, 0x47], 'png'], [0, [0x47, 0x49, 0x46, 0x38], 'gif'], [0, [0x42, 0x4D], 'bmp'],
  [8, [0x57, 0x45, 0x42, 0x50], 'webp'], [4, [0x66, 0x74, 0x79, 0x70], 'avif'], [0, [0xFF, 0x0A], 'jxl'], [0, [0, 0, 0, 0x0C, 0x4A, 0x58, 0x4C, 0x20], 'jxl']];
const sniff = b => MAGIC.find(([at, magic]) => magic.every((v, i) => b[at + i] === v))?.[2] ?? 'unknown';
function* resources(svg) {
  let i = 0;
  const name = /[A-Za-z][\w:.-]*/y, space = /\s*/y, styleEnd = /<\/(?:[A-Za-z][\w.-]*:)?style\s*>/g;
  while (i < svg.length) {
    const lt = svg.indexOf('<', i);
    if (lt < 0) break;
    if (svg.startsWith('<!--', lt)) { const e = svg.indexOf('-->', lt + 4); i = e < 0 ? svg.length : e + 3; continue; }
    if (svg.startsWith('<![CDATA[', lt)) { const e = svg.indexOf(']]>', lt + 9); i = e < 0 ? svg.length : e + 3; continue; }
    const closing = svg[lt + 1] === '/';
    name.lastIndex = lt + (closing ? 2 : 1);
    const tag = name.exec(svg);
    if (!tag || svg[lt + 1] === '!' || svg[lt + 1] === '?') { const e = svg.indexOf('>', lt); i = e < 0 ? svg.length : e + 1; continue; }
    // Names are exact (XML): the local name after any prefix; an SVG picture's href in any namespace.
    const element = tag[0].slice(tag[0].indexOf(':') + 1), attribute0 = Object.hasOwn(PICTURE, element) ? PICTURE[element] : null;
    let p = name.lastIndex;
    while (p < svg.length) {
      space.lastIndex = p; p = space.exec(svg)[0].length + p;
      if (svg[p] === '>') { p++; break; }
      if (svg[p] === '/' || svg[p] === undefined) { p++; continue; }
      name.lastIndex = p;
      const attribute = name.exec(svg);
      if (!attribute) { p++; continue; }
      p = name.lastIndex; space.lastIndex = p; p += space.exec(svg)[0].length;
      if (svg[p] !== '=') continue;
      p++; space.lastIndex = p; p += space.exec(svg)[0].length;
      const quote = svg[p];
      if (quote !== '"' && quote !== "'") continue;
      const start = p + 1, end = svg.indexOf(quote, start);
      if (end < 0) return;
      p = end + 1;
      const key = attribute[0];
      if (key === attribute0 || (attribute0 === 'href' && key.endsWith(':href'))) yield { start, end };
      else if (key === 'style') yield* cssUrls(svg, start, end, true);
    }
    i = p;
    // A style's text runs to its end tag, CDATA included: a `<` in it (`width < 600px`, as an HTML page's inline SVG
    // writes it) opens no tag. Its XML comments are left as they are.
    if (element === 'style' && !closing && svg[p - 2] !== '/') {
      styleEnd.lastIndex = p;
      const close = styleEnd.exec(svg), stop = close ? close.index : svg.length;
      for (let at = p; at < stop;) {
        const comment = svg.indexOf('<!--', at), to = comment < 0 || comment >= stop ? stop : comment;
        yield* cssUrls(svg, at, to, false);
        const e = to < stop ? svg.indexOf('-->', to + 4) : -1;
        at = e < 0 ? stop : e + 3;
      }
      i = close ? close.index + close[0].length : svg.length;
    }
  }
}
function* cssUrls(svg, from, to, attribute) {
  const quotes = attribute ? ['"', "'", '&quot;', '&apos;'] : ['"', "'"];
  for (let p = from; p < to;) {
    const q = quotes.find(q => svg.startsWith(q, p));
    if (q) { for (p += q.length; p < to && !svg.startsWith(q, p); p++) if (svg[p] === '\\') p++; p += q.length; continue; }
    if (svg.startsWith('/*', p)) { const e = svg.indexOf('*/', p + 2); p = e < 0 || e > to ? to : e + 2; continue; }
    if (!/^url\(/i.test(svg.slice(p, p + 4))) { p++; continue; }
    p += 4; while (p < to && /\s/.test(svg[p])) p++;
    const open = quotes.find(q => svg.startsWith(q, p));
    if (open) {
      const start = p + open.length, end = svg.indexOf(open, start);
      if (end < 0 || end > to) return;
      yield { start, end }; p = end + open.length;
    } else {
      const start = p; while (p < to && !/[)\s]/.test(svg[p])) p++;
      yield { start, end: p };
    }
  }
}
function pictures(svg) {
  const list = [];
  for (const { start, end } of resources(svg)) {
    const uri = svg.slice(start, end);
    if (/^(https?|blob):/i.test(uri)) { list.push({ start, end, kind: 'external', url: uri, kept: 'external' }); continue; }
    const m = /^data:image\/([a-z0-9.+-]+)(;[^,]*)?,/i.exec(uri);
    if (!m) continue;  // a font is not a picture
    const type = m[1].toLowerCase(), payload = uri.slice(m[0].length);
    if (type === 'svg+xml') { list.push({ start, end, kind: 'svg', length: payload.length, kept: 'svg' }); continue; }
    const p = { start, end, kind: type, length: payload.length, uri };
    list.push(p);
    // As a browser does, whitespace in base64 is dropped.
    const text = payload.replace(/\s+/g, '');
    // Base64 as a browser reads it (Fetch's data: URL): the type ends with ';', any spaces, then 'base64'.
    if (!/; *base64$/i.test((m[2] ?? '').trim()) || !text || /[^A-Za-z0-9+/=]/.test(text)) { p.kept = 'malformed'; continue; }
    try { p.bytes = unbase64(text); } catch { p.kept = 'malformed'; continue; }
    p.kind = sniff(p.bytes);
    if (p.kind === 'png') p.alpha = alpha(p.bytes) || p.bytes[24] === 16;
    if (p.kind === 'unknown') p.kept = 'malformed';
    else if (/^(webp|avif|jxl)$/.test(p.kind)) p.kept = p.kind;
    else if (p.kind === 'gif' ? gifFrames(p.bytes) > 1 : p.kind === 'png' && apng(p.bytes)) p.kept = 'animated';
  }
  return list;
}
const fonts = svg => [...svg.matchAll(/@font-face\s*\{[^}]*\}/gi)].reduce((total, rule) => total + [...rule[0].matchAll(/url\(\s*(?:["']|&quot;)?(data:[^"')&\s]+)/gi)].reduce((n, m) => n + m[1].length, 0), 0);
function gifFrames(b) {
  let p = 13 + (b[10] & 0x80 ? 3 << ((b[10] & 7) + 1) : 0), frames = 0;
  while (p < b.length && frames < 2) {
    const tag = b[p++];
    if (tag === 0x21) { p++; while (p < b.length && b[p]) p += b[p] + 1; p++; }
    else if (tag === 0x2C) { frames++; const f = b[p + 8]; p += 9 + (f & 0x80 ? 3 << ((f & 7) + 1) : 0) + 1; while (p < b.length && b[p]) p += b[p] + 1; p++; }
    else break;
  }
  return frames;
}
function chunkBeforeData(b, name) {
  for (let p = 8; p + 8 <= b.length;) {
    const length = ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0, type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    if (type === name) return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    p += 12 + length;
  }
  return false;
}
const apng = b => chunkBeforeData(b, 'acTL'), alpha = b => b[25] === 4 || b[25] === 6 || chunkBeforeData(b, 'tRNS');
function dimensions(b, kind) {
  const be16 = i => (b[i] << 8) | b[i + 1], le16 = i => b[i] | (b[i + 1] << 8), le32 = i => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);
  if (kind === 'png') return [((b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19]) >>> 0, ((b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23]) >>> 0];
  // A GIF: its logical screen grown to its first image's extent, as browsers grow it (input.mjs reads it the same way).
  if (kind === 'gif') {
    let width = le16(6), height = le16(8), p = 13 + (b[10] & 0x80 ? 3 << ((b[10] & 7) + 1) : 0);
    while (p < b.length) {
      const tag = b[p++];
      if (tag === 0x21) { p++; while (p < b.length && b[p]) p += b[p] + 1; p++; continue; }
      if (tag === 0x2C && p + 8 < b.length) { width = Math.max(width, le16(p) + le16(p + 4)); height = Math.max(height, le16(p + 2) + le16(p + 6)); }
      break;
    }
    return [width, height];
  }
  // A BMP: the 12-byte core header's 16-bit sides, or the info header's 32-bit ones (a negative height is top-down; a
  // negative width is no picture, as browsers read it).
  if (kind === 'bmp') return b[14] === 12 && !b[15] && !b[16] && !b[17] ? [le16(18), le16(20)] : le32(18) > 0 ? [le32(18), Math.abs(le32(22))] : null;
  if (kind === 'jpeg') for (let p = 2; p + 9 < b.length && b[p] === 0xFF;) {
    if (b[p + 1] === 0xFF) { p++; continue; }  // a fill byte
    const marker = b[p + 1];
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) return [be16(p + 7), be16(p + 5)];
    if (marker === 0xDA || marker === 0xD9) return null;  // a scan or the end before any frame: no size
    p += marker === 0xD8 || (marker >= 0xD0 && marker <= 0xD7) || marker === 0x01 ? 2 : 2 + be16(p + 2);
  }
  return null;
}
const unbase64 = text => { const s = atob(text), out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; };
const base64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
