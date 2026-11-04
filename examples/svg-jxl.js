// Any SVG (text, Blob or File) with its embedded raster pictures as JPEG XL: import { svgJxl } from 'rapier-jxl/svg-jxl';
//   const { svg, record } = await svgJxl(input, { quality: 0.92 }); // smallest of lossy, exact and the original
//   await svgJxl(input, { exact: true });                             // JPEGs restorable, the rest lossless
import { createCodec } from 'rapier-jxl/codec';

let jpeg, capture, still;
const MAX_PIXELS = 40_000_000;
const jpegCodec = () => jpeg ??= createCodec({ module: 'rapier-jxl/jpeg' });
const stillCodec = () => still ??= createCodec({ module: 'rapier-jxl' });

export async function svgJxl(input, { quality = 0.92, exact, effort, webgpu, signal, onProgress, codec, cache = new Map() } = {}) {
  signal?.throwIfAborted();
  // A Blob or File is scanned as one character per byte and written back byte for byte, whatever its encoding.
  const text = typeof input === 'string', svg = text ? input : latin1(new Uint8Array(await abortable(input.arrayBuffer(), signal)));
  const captureCodec = () => codec ?? (capture ??= createCodec({ module: 'rapier-jxl/capture-complete' }));
  const decoder = !!codec || typeof createImageBitmap === 'function', lossy = decoder && !exact && quality < 1;
  const found = pictures(svg), done = [];
  for (const p of found) if (p.bytes && !p.kept) p.route = p.kind === 'jpeg' ? 'jpeg' : p.kind === 'png' || decoder ? 'lossless' : (p.kept = 'no-decoder', undefined);
  const key = p => `${codecId(codec)} ${lossy ? quality : 'exact'} ${effort} ${webgpu} ${p.uri}`;
  const queue = [...new Set(found.filter(p => p.route && !cache.has(key(p))).map(key))];
  let count = 0;
  const total = queue.length;
  onProgress?.(0);
  const code = async p => {
    // Sized by its header as a browser sizes it, before any decode or draw.
    const size = dimensions(p.bytes, p.kind);
    if (!size || size[0] * size[1] > MAX_PIXELS) { count++; return { out: null, kept: size ? 'JXL_DIMENSIONS' : 'no-size', tries: {} }; }
    // Under 64 pixels a side (below the photo check's floor) a picture takes the exact route only.
    const tryLossy = lossy && Math.min(size[0], size[1]) >= 64;
    const blob = new Blob([p.bytes], { type: `image/${p.kind}` }), part = tryLossy ? 0.5 : 1;
    const encode = async (route, from) => {
      const job = { maxPixels: MAX_PIXELS, ...(effort !== undefined && { effort }), ...(signal && { signal }),
        ...(onProgress && { onProgress: fraction => onProgress((count + from + fraction * part) / total) }) },
        gpu = webgpu !== undefined && { webgpu };
      if (route === 'quality') {
        // The whole picture one photo (a box past an oriented side is cut to the picture); capture-complete makes the look.
        const side = Math.max(size[0], size[1]);
        return { out: await captureCodec().capture(blob, { ...job, fidelity: { webp: Math.max(0, quality) }, ...gpu, photoRects: [{ x: 0, y: 0, width: side, height: side }] }) };
      }
      if (route === 'jpeg') return { out: await jpegCodec().recompress(p.bytes, job) };
      let reader;
      if (p.alpha || !decoder) {
        // The file's own samples (the browser premultiplies); on refusal the browser's decode, named in `reader`.
        try { return { out: await stillCodec().encode(blob, { ...job, fidelity: 'exact' }) }; }
        catch (error) { if (signal?.aborted || !decoder) throw error; reader = error.code ?? error.name ?? 'error'; }
      }
      return { out: await captureCodec().capture(blob, { ...job, fidelity: 'exact', ...gpu }), reader };
    };
    const tries = {};
    let out = null, route, reader, kept;
    for (const [r, from] of [[p.route, 0], ...(tryLossy ? [['quality', 0.5]] : [])]) {
      try {
        const made = await encode(r, from);
        tries[r] = made.out.length;
        if (!out || made.out.length < out.length) ({ out, reader } = made), route = r;
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        kept ??= error.code ?? error.name ?? 'error';
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
  onProgress?.(1);
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
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

// Where a browser loads a picture: picture attributes and CSS url() outside strings; scanned, never parsed or run.
const PICTURE = { img: 'src', image: 'href', feImage: 'href', video: 'poster', source: 'src' };
const MAGIC = [[0, [0xFF, 0xD8, 0xFF], 'jpeg'], [0, [0x89, 0x50, 0x4E, 0x47], 'png'], [0, [0x47, 0x49, 0x46, 0x38], 'gif'], [0, [0x42, 0x4D], 'bmp'],
  [8, [0x57, 0x45, 0x42, 0x50], 'webp'], [4, [0x66, 0x74, 0x79, 0x70], 'avif'], [0, [0xFF, 0x0A], 'jxl'], [0, [0, 0, 0, 0x0C, 0x4A, 0x58, 0x4C, 0x20], 'jxl']];
const sniff = b => MAGIC.find(([at, magic]) => magic.every((v, i) => b[at + i] === v))?.[2] ?? 'unknown';
function* resources(svg) {
  let i = 0, inStyle = false;
  const name = /[A-Za-z][\w:.-]*/y, space = /\s*/y;
  while (i < svg.length) {
    const lt = svg.indexOf('<', i);
    if (inStyle) yield* cssUrls(svg, i, lt < 0 ? svg.length : lt, false);
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
    if (element === 'style') inStyle = !closing && svg[p - 2] !== '/';
    i = p;
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
    if (!/;base64$/i.test(m[2] ?? '') || !text || /[^A-Za-z0-9+/=]/.test(text)) { p.kept = 'malformed'; continue; }
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
  const be16 = i => (b[i] << 8) | b[i + 1], le16 = i => b[i] | (b[i + 1] << 8), le32 = i => Math.abs(b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24));
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
  // A BMP: the 12-byte core header's 16-bit sides, or the info header's 32-bit ones (a negative height is top-down).
  if (kind === 'bmp') return b[14] === 12 && !b[15] && !b[16] && !b[17] ? [le16(18), le16(20)] : [le32(18), le32(22)];
  if (kind === 'jpeg') for (let p = 2; p + 9 < b.length && b[p] === 0xFF;) {
    if (b[p + 1] === 0xFF) { p++; continue; }  // a fill byte
    const marker = b[p + 1];
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) return [be16(p + 7), be16(p + 5)];
    p += marker === 0xD8 || (marker >= 0xD0 && marker <= 0xD7) || marker === 0x01 ? 2 : 2 + be16(p + 2);
  }
  return null;
}
const unbase64 = text => { const s = atob(text), out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; };
const base64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
