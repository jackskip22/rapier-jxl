// JPEG XL for SnapDOM 3: snapdom(element, { plugins: [jxl()] }), then result.toJxl(), or toBlob or download with
// { format: 'jxl' }; toWebp()'s options and defaults, plus effort, signal, onProgress and onEncoded.
// Copy jxl.js and jxl.d.ts into your app; rapier-jxl/page-rects comes from the package.
import { measure, pageRects } from 'rapier-jxl/page-rects';

// Options: module ('rapier-jxl/capture-complete', 'rapier-jxl/capture' or 'rapier-jxl/upload'), codec (your own
// encoder with prepare and capture), effort (each export's default), webgpu (false or 'required') and helpers.
export function jxl(options = {}) {
  const { module = 'rapier-jxl/capture-complete', codec, effort: preset, webgpu, helpers: asked } = options;
  // The same helpers written in another order share one codec.
  const helpers = asked && typeof asked === 'object'
    ? { count: asked.count, ...(asked.memoryBytes !== undefined && { memoryBytes: asked.memoryBytes }) } : asked || undefined;
  // Equal options give the same plugin, so SnapDOM's memo of an unchanged capture holds for an
  // inline `jxl()` too.
  const id = JSON.stringify([module, helpers, preset, webgpu]);
  const made = codec ? byCodec.get(codec) ?? byCodec.set(codec, new Map()).get(codec) : plugins;
  if (!made.has(id)) made.set(id, create(module, codec, preset, webgpu, helpers));
  return made.get(id);
}

const plugins = new Map(), byCodec = new WeakMap();

function create(module, codec, preset, webgpu, helpers) {
  const key = JSON.stringify([module, helpers]);
  const exactOnly = module === 'rapier-jxl/capture';
  // Edges are measured with the page, for any export effort from 4 (a scan of about 0.1 ms on
  // SnapDOM's demo pages): measuring the page again at export could see it changed.
  const edges = module !== 'rapier-jxl/upload';
  if (!DOORS[module]) throw new Error(`The jxl plugin's module is ${Object.keys(DOORS).join(', ')} or left out.`);
  // Start loading now, so the first export does not wait on the network.
  if (!codec) DOORS[module]().catch(() => {});
  return {
    name: 'jxl',
    // The measurement reads the live DOM and nothing else, so SnapDOM can keep memoizing
    // unchanged captures.
    pure: true,

    // Exact capture needs no rectangles. Otherwise text and photos are measured on the page
    // as it was captured; the export maps them onto the drawn canvas.
    ...(exactOnly ? {} : {
      afterClone(context) {
        const element = context.element;
        // Only what SnapDOM cloned is drawn: exclude, filter and unslotted children add nothing.
        const keep = context.nodeMap ? new Set(context.nodeMap.values()) : undefined;
        context[SNAPSHOT] = element ? { ...measured(measure, element, edges, keep), frame: frameOf(element, context.outerTransforms !== false) } : null;
      },
    }),

    defineExports: ({ exports }) => {
      const encoded = async (context, options) => {
        // The export's own options first: a beforeExport plugin may have changed them, and a
        // direct call has nothing else.
        const asked = context.export?.requestedOptions ?? {}, pick = k => options[k] !== undefined ? options[k] : asked[k];
        const effort = pick('effort') ?? preset, signal = pick('signal'), onProgress = pick('onProgress'), onEncoded = pick('onEncoded');
        signal?.throwIfAborted();
        if (!codec && !codecs.has(key)) {
          codecs.set(key, DOORS[module]().then(({ createCodec }) => createCodec({ module, maxPixels: MAX_PIXELS, ...(helpers !== undefined && { helpers }) }),
            error => { codecs.delete(key); throw needs(error); }));
        }
        const encoder = codec ?? await abortable(codecs.get(key), signal);
        encoder.prepare('capture').catch(() => {});
        const canvas = await abortable(exports.canvas({ ...options, backgroundColor: options.backgroundColor ?? '#ffffff' }), signal);
        signal?.throwIfAborted();

        const { quality = 0.92 } = options;
        const photo = { quality: Math.max(1, quality * 100) };
        // The canvas shows the capture's viewBox: the measurement moves into it the way SnapDOM
        // drew the root (its outer shadow, transform and clip window), or, where it cannot, the
        // whole capture stays exact.
        const both = o => Number.isFinite(o.width) && Number.isFinite(o.height);
        const fitted = both(context) && !safari(), exported = both(options) && firefox() && options;
        const shot = inView(context[SNAPSHOT], context.meta, fitted, exported);
        // WebKit draws a clip window's positioned boxes as if the window began at the element's corner
        // (SnapDOM 3.7.2): in Safari the text stays exact in both places.
        const unclipped = shot && safari() && context.meta?.clip ? inView(context[SNAPSHOT], { ...context.meta, clip: null }, fitted, exported) : null;
        const area = {};

        // Below 1:1, text boxes map through the drawn scale (outward to whole pixels) so glyphs
        // stay exact, and photos still take the quality. With no photos left the page stays exact;
        // with photos, the smaller of that file and the whole page exact wins, so a scaled export
        // is never larger.
        const naturalW = shot?.box.width, naturalH = shot?.box.height;
        const below = !!(shot && naturalW && naturalH &&
          (canvas.width < Math.floor(naturalW) || canvas.height < Math.floor(naturalH)));
        const measured = [shot, unclipped].filter(Boolean).map(s => pageRects(s, canvas, { area, edges: !below && (effort ?? 3) >= 4 }));
        let rects = quality < 1 && !exactOnly && measured.length
          ? { exactRects: measured.flatMap(r => r.exactRects), photoRects: measured.flatMap(r => r.photoRects),
            ...(measured.every(r => r.textComplete === true) && { textComplete: true }) } : null;
        // A page SnapDOM had to shrink to its canvas limit is drawn with its text moved from where
        // the page has it, so the rectangles cannot follow: it stays exact.
        if (below && (!rects?.photoRects?.length || atLimit(canvas))) rects = null;

        let exact = false;
        const base = { ...(effort !== undefined && { effort }), ...(webgpu !== undefined && { webgpu }), ...(signal && { signal }) };
        const hooks = { signal, onProgress, onEncoded: record => { exact = record?.exact; onEncoded?.(record); } };
        const file = below && rects
          ? await smaller(encoder, canvas, base, [{ fidelity: photo, ...rects }, { fidelity: 'exact' }], hooks)
          : await encoder.capture(canvas, {
            ...(rects ? { fidelity: photo, ...rects } : { fidelity: 'exact' }),
            ...base, ...(onProgress !== undefined && { onProgress }), onEncoded: hooks.onEncoded,
          });
        // An encoder that finished after the abort still loses to it.
        signal?.throwIfAborted();
        return { blob: new Blob([bytesOf(file)], { type: 'image/jxl' }), canvas, exact };
      };
      const encode = async (context, options) => {
        const { blob, canvas } = await encoded(context, options);
        if (canvas !== options.canvas) free(canvas);
        return blob;
      };
      // `type` is SnapDOM's older name for `format`, which it keeps for its own formats only. A format
      // chosen for this export (the call, a beforeExport plugin) wins; the capture's own does not.
      const isJxl = (context, options) => {
        if (String(options.format).toLowerCase() === 'jxl') return true;
        const asked = context.export?.requestedOptions ?? options;
        return asked.format === undefined && String(asked.type).toLowerCase() === 'jxl' &&
          (options.__explicitFormat ?? null) === (context.__explicitFormat ?? null);
      };
      const signalOf = (context, options) => options.signal ?? context.export?.requestedOptions?.signal;

      return {
        jxl: async (context, options = {}) => {
          const { blob, canvas: drawn, exact } = await encoded(context, options);
          return image(blob, drawn, drawn !== options.canvas, options.dpr || 1, signalOf(context, options), exact);
        },
        blob: (context, options = {}) => isJxl(context, options) ? encode(context, options) : exports.blob(options),
        async download(context, options = {}) {
          const format = isJxl(context, options) ? 'jxl' : options.format === 'jpg' ? 'jpeg' : options.format || 'png';
          const name = options.filename || 'snapdom';
          const filename = /\.(png|jpe?g|webp|svg|jxl)$/i.test(name) ? name : `${name}.${format}`;
          const next = { ...options, dpr: 1 };
          const blob = format === 'jxl' ? await encode(context, next) : await exports.blob({ ...next, format });
          signalOf(context, options)?.throwIfAborted();
          await save(blob, filename);
        },
      };
    },
  };
}

const SNAPSHOT = Symbol('jxl measurement');
// SnapDOM's raster limits: 32767 pixels a side (16384 in Safari) and 16384 * 16384 in all.
const atLimit = ({ width, height }) => [16384, 32767].includes(Math.max(width, height)) || width * height > 0.99 * 16384 * 16384;
const MAX_PIXELS = 16384 * 16384;
const codecs = new Map();
let decoder = null;

// Each module's codec comes through its own door, named in full, so a bundler ships the workers of
// these three modules and no others; a page loads only the one it uses.
const DOORS = {
  'rapier-jxl/capture-complete': () => import('rapier-jxl/codec/capture-complete'),
  'rapier-jxl/capture': () => import('rapier-jxl/codec/capture'),
  'rapier-jxl/upload': () => import('rapier-jxl/codec/upload'),
};
const needs = error => new Error('The jxl plugin needs rapier-jxl 8.3.2 or later: npm install rapier-jxl', { cause: error });

// SnapDOM draws <html> without the top margins that collapse through its first children (<body>'s
// own included), so what lies in <body>'s flow is drawn higher by that much; a box positioned on the
// page itself is not. Those boxes are measured on their own, and the rest moves up.
function measured(measure, element, edges, keep) {
  const lift = keep ? liftOf(element) : 0;
  if (!lift) return measure(element, { edges, keep });
  const placed = onPage(element.ownerDocument.body), inFlow = new Set(keep);
  for (const el of placed) inFlow.delete(el);
  const up = r => ({ ...r, top: r.top - lift, bottom: r.bottom - lift });
  const shot = measure(element, { edges, keep: inFlow });
  shot.text = shot.text.map(t => ({ ...t, r: up(t.r) }));
  shot.photos = shot.photos.map(up);
  if (shot.edges) shot.edges = shot.edges.map(up);
  for (const el of placed) {
    if (!keep.has(el)) continue;
    const own = measure(el, { edges, keep });
    shot.text.push(...own.text);
    shot.photos.push(...own.photos);
    if (shot.edges) shot.edges.push(...own.edges);
  }
  return shot;
}

function liftOf(element) {
  const doc = element.ownerDocument, body = doc?.body;
  if (element !== doc?.documentElement || !body) return 0;
  const s = getComputedStyle(element);
  // As SnapDOM decides it: an edge with a border or padding, or a root that starts its own block
  // formatting context, keeps the margins.
  if (parseFloat(s.borderTopWidth) || parseFloat(s.paddingTop) || /flex|grid|table|inline-block|flow-root/.test(s.display) ||
    s.position === 'absolute' || s.position === 'fixed' || s.float !== 'none' || s.overflowX !== 'visible' || s.overflowY !== 'visible' ||
    /layout|content|paint|strict/.test(s.contain)) return 0;
  // A relatively positioned <body> keeps its offset in the clone.
  const b = getComputedStyle(body), moved = b.position === 'relative' ? parseFloat(b.top) || 0 : 0;
  return body.getBoundingClientRect().top - moved - element.getBoundingClientRect().top;
}

// The outermost absolute or fixed boxes in <body> whose containing block is the page.
function onPage(body) {
  const placed = [];
  const fixedBlock = s => s.transform !== 'none' || s.perspective !== 'none' || s.filter !== 'none' ||
    /layout|content|paint|strict/.test(s.contain) || /transform|perspective|filter/.test(s.willChange);
  const visit = (el, absolute, fixed) => {
    for (const child of el.children) {
      const s = getComputedStyle(child);
      if (s.position === 'absolute' && absolute || s.position === 'fixed' && fixed) { placed.push(child); continue; }
      visit(child, absolute && s.position === 'static' && !fixedBlock(s), fixed && !fixedBlock(s));
    }
  };
  const s = getComputedStyle(body);
  visit(body, s.position === 'static' && !fixedBlock(s), !fixedBlock(s));
  return placed;
}

// How the page shows the capture root: the viewport point of its layout corner, the scale of the
// ancestors and the root's own transform. null where an ancestor rotates or skews it, or a
// transform cannot be read: the export then keeps the whole capture exact.
function frameOf(element, keepsRotation) {
  try {
    const box = element.getBoundingClientRect(), style = getComputedStyle(element);
    const width = element.offsetWidth ?? box.width, height = element.offsetHeight ?? box.height;
    // No transform on the root or above it, and its layout size is its box: the page's own pixels.
    let flat = none(style.transform) && none(style.rotate) && none(style.scale);
    for (let up = element.parentElement ?? element.getRootNode?.().host; up && flat; up = up.parentElement ?? up.getRootNode?.().host) {
      const s = getComputedStyle(up);
      flat = none(s.transform) && none(s.rotate) && none(s.scale);
    }
    if (flat && Math.abs(box.width - width) < 0.5 && Math.abs(box.height - height) < 0.5) {
      return { toDrawn: p => ({ x: p.x - box.left, y: p.y - box.top }) };
    }
    const [ox, oy] = style.transformOrigin.split(' ').map(parseFloat);
    const transform = style.transform === 'none' ? new DOMMatrix() : new DOMMatrix(style.transform);
    const rotate = style.rotate && style.rotate !== 'none' ? new DOMMatrix(`rotate(${style.rotate})`) : new DOMMatrix();
    const scale = style.scale && style.scale !== 'none' ? new DOMMatrix(`scale(${style.scale.split(' ').slice(0, 2).join(',')})`) : new DOMMatrix();
    transform.e = transform.f = 0; // SnapDOM drops the root's translation
    const live = rotate.multiply(scale).multiply(transform);
    // SnapDOM keeps the root's transform, or with outerTransforms false only its scale and skew,
    // about its top left corner.
    const drawn = keepsRotation ? live : scale.multiply(scaleSkew(transform));
    for (let up = element.parentElement ?? element.getRootNode().host; up; up = up.parentElement ?? up.getRootNode().host) {
      const s = getComputedStyle(up), m = s.transform === 'none' ? null : new DOMMatrix(s.transform);
      if (m && (m.b || m.c) || s.rotate && s.rotate !== 'none') return null;
    }
    const corners = m => [[0, 0], [width, 0], [0, height], [width, height]].map(([x, y]) => m.transformPoint({ x, y }));
    const about = (m, x, y) => new DOMMatrix().translate(x, y).multiply(m).translate(-x, -y);
    const page = corners(about(live, ox, oy));
    const xs = page.map(p => p.x), ys = page.map(p => p.y);
    const near = v => Math.abs(v - 1) < 0.01 ? 1 : v;
    const sx = near(box.width / (Math.max(...xs) - Math.min(...xs) || 1)), sy = near(box.height / (Math.max(...ys) - Math.min(...ys) || 1));
    // From the page to the root's own layout box.
    const toLayout = about(live, ox, oy).inverse()
      .multiply(new DOMMatrix().scale(1 / sx, 1 / sy).translate(-(box.left - Math.min(...xs) * sx), -(box.top - Math.min(...ys) * sy)));
    const shown = (keepsRotation ? about(live, ox, oy) : drawn).multiply(toLayout);
    return { toDrawn: p => shown.transformPoint(p) };
  } catch {
    return null;
  }
}

const none = v => !v || v === 'none';

// Firefox as SnapDOM tells it (its isFirefox).
const firefox = () => typeof navigator !== 'undefined' && (navigator.userAgent || '').toLowerCase().includes('firefox');

// Safari as SnapDOM tells it (its isSafari): the browsers whose captures it draws its Safari way.
function safari() {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent || '', low = ua.toLowerCase(), webkit = /applewebkit/i.test(ua);
  return low.includes('safari') && !/chrome|crios|fxios|android/.test(low) || webkit && /mobile/i.test(ua) && !/safari/i.test(ua) ||
    /(micromessenger|wxwork|wecom|windowswechat|macwechat)/i.test(ua) || /(baiduboxapp|baidubrowser|baidusearch|baiduboxlite)/i.test(low) ||
    /ipad|iphone|ipod/.test(low) && webkit;
}

// What SnapDOM leaves of a matrix with outerTransforms false: its scale and skew.
function scaleSkew({ a, b, c, d }) {
  const sx = Math.hypot(a, b);
  if (!sx) return new DOMMatrix();
  const a1 = a / sx, b1 = b / sx, shear = a1 * c + b1 * d;
  const sy = Math.hypot(c - a1 * shear, d - b1 * shear);
  return new DOMMatrix([sx, 0, sy ? shear : 0, sy, 0, 0]);
}

// The measurement moved into the capture's viewBox, in CSS pixels; null keeps the capture exact.
// The box is what the canvas shows, in viewBox units. A capture given both width and height fits its
// viewBox inside them, centered (Safari stretches it instead), and Firefox draws an export given
// both fitted and centered too (the others stretch it): mapping the box onto the canvas is a stretch.
function inView(shot, meta, fitted, exported) {
  if (!shot?.frame || !meta || !Number.isFinite(meta.vbW)) return null;
  const { contentX = 0, contentY = 0, vbW, vbH, clip, targetW, targetH } = meta, { toDrawn } = shot.frame;
  let width = vbW, height = vbH;
  const fit = (w, h) => { const k = Math.min(w / width, h / height); width = w / k; height = h / k; };
  if (fitted && targetW && targetH) fit(targetW, targetH);
  if (exported) fit(exported.width, exported.height);
  const dx = contentX - (clip?.x ?? 0) + (width - vbW) / 2, dy = contentY - (clip?.y ?? 0) + (height - vbH) / 2;
  const move = r => {
    const ps = [[r.left, r.top], [r.right, r.top], [r.left, r.bottom], [r.right, r.bottom]].map(([x, y]) => toDrawn({ x, y }));
    const xs = ps.map(p => p.x + dx), ys = ps.map(p => p.y + dy);
    return { ...r, left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
  };
  return {
    box: { left: 0, top: 0, width, height },
    text: shot.text.map(t => ({ ...t, r: move(t.r) })),
    photos: shot.photos.map(move),
    ...(shot.textComplete === true && { textComplete: true }),
    ...(shot.edges && { edges: shot.edges.map(move) }),
  };
}

// Where JPEG XL does not display (found on the first try, then remembered), a PNG of the exact
// canvas, or of rapier-jxl/decode's copy (loaded only then). The saved Blob stays JPEG XL. The image
// takes the drawn canvas's CSS size; its own canvases are emptied once read.
let showsJxl;
async function image(blob, drawn, own, dpr, signal, exact) {
  const img = new Image(), wait = promise => abortable(promise, signal);
  const { width, height } = drawn?.style ?? {};
  let decoded = null;
  try {
    try {
      if (showsJxl === false) throw new Error('JPEG XL does not display here');
      await wait(shown(img, await wait(dataURL(blob))));
      showsJxl = true;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (showsJxl === undefined) showsJxl = false;
      if (!exact) {
        decoder ??= import('rapier-jxl/codec/decode').then(({ createCodec }) => createCodec({ module: 'rapier-jxl/decode', maxPixels: MAX_PIXELS }),
          error => { decoder = null; throw needs(error); });
        const { data, width: w, height: h } = await wait((await wait(decoder)).decode(blob, { format: 'uint8', colorSpace: 'srgb', maxPixels: MAX_PIXELS, ...(signal && { signal }) }));
        decoded = document.createElement('canvas');
        decoded.width = w;
        decoded.height = h;
        decoded.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), w, h), 0, 0);
      }
      const source = decoded ?? drawn;
      await wait(shown(img, await wait(dataURL(await wait(new Promise(resolve => source.toBlob(resolve, 'image/png')))))));
    }
  } finally {
    if (own) free(drawn);
    free(decoded);
  }
  signal?.throwIfAborted();
  img.style.width = width || `${img.naturalWidth / dpr}px`;
  img.style.height = height || `${img.naturalHeight / dpr}px`;
  return img;
}

// A canvas holds its pixels until it is emptied, even once nothing reads it. Only the export's own
// canvases are emptied, never one the app passed as `canvas`.
function free(canvas) {
  if (typeof HTMLCanvasElement !== 'undefined' && canvas instanceof HTMLCanvasElement) canvas.width = canvas.height = 0;
}

const shown = (img, src) => new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = src; })
  .finally(() => { img.onload = img.onerror = null; });

const dataURL = blob => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

// iOS saves a file only through the share sheet.
async function save(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  const ios = navigator.userAgentData ? navigator.userAgentData.platform === 'iOS'
    : /iPhone|iPad|iPod/.test(navigator.userAgent) || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  if (ios && navigator.canShare?.({ files: [file] })) {
    // Closing the sheet is the person's choice; any other refusal is the export's failure.
    try { await navigator.share({ files: [file], title: filename }); } catch (error) { if (error.name !== 'AbortError') throw error; }
    return;
  }
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  try {
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
  } finally {
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

// Below 1:1, encode each candidate quietly, keep the smallest, then report one onEncoded and
// a final progress of 1. Progress runs 0 to 1 across the candidates without restarting.
async function smaller(encoder, canvas, base, jobs, hooks) {
  const span = 1 / jobs.length;
  let best = null, record = null;
  for (let i = 0; i < jobs.length; i++) {
    let got = null;
    const result = await encoder.capture(canvas, {
      ...base, ...jobs[i],
      onProgress: hooks.onProgress && (f => { if (f < 1) hooks.onProgress(i * span + f * span); }),
      onEncoded: r => { got = r; },
    });
    if (result.fits && result.bytes && (!best || result.bytes.byteLength < best.bytes.byteLength)) { best = result; record = got; }
  }
  hooks.signal?.throwIfAborted();
  bytesOf(best);
  hooks.onEncoded(record ?? { exact: false });
  hooks.signal?.throwIfAborted();
  hooks.onProgress?.(1);
  hooks.signal?.throwIfAborted();
  return best;
}

function bytesOf(result) {
  if (!result?.fits || !result.bytes) {
    throw Object.assign(new Error(result?.reason?.message ?? 'The JPEG XL file did not meet the requested target.'),
      { code: result?.reason?.code ?? 'JXL_UNSUPPORTED' });
  }
  return result.bytes;
}

function abortable(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}
