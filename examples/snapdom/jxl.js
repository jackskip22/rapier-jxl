// JPEG XL for SnapDOM 3: snapdom(element, { plugins: [jxl()] }), then result.toJxl(), or toBlob or download with
// { format: 'jxl' }; toWebp()'s options and defaults, plus effort, signal, onProgress and onEncoded.
// Copy jxl.js and jxl.d.ts into your app; rapier-jxl/page-rects comes from the package.
import { createCodec } from 'rapier-jxl/codec';
import { measure, pageRects } from 'rapier-jxl/page-rects';

const codecs = new Map();

export function jxl({ module = 'rapier-jxl/capture-complete', codec, effort: preset, webgpu, helpers: asked } = {}) {
  const helpers = asked && typeof asked === 'object' ? { ...asked } : asked, key = JSON.stringify([module, helpers]);
  return {
    name: 'jxl',
    // Exact-only needs no rectangles, so SnapDOM may reuse its clone; otherwise they are measured on the clone's page.
    ...(module === 'rapier-jxl/capture' ? {} : {
      afterClone(context) { const el = context.element; context[SNAPSHOT] = el ? [measure(el, { edges: (preset ?? 3) >= 4 }), lift(el)] : null; },
    }),
    defineExports: ({ exports }) => {
      const encoded = async (context, options) => {
        const { effort = preset, signal, onProgress, onEncoded } = context.export?.requestedOptions ?? {};
        signal?.throwIfAborted();
        if (!codec && !codecs.has(key)) codecs.set(key, createCodec({ module, maxPixels: 16384 * 16384, ...(helpers !== undefined && { helpers }) }));
        const encoder = codec ?? codecs.get(key);
        encoder.prepare('capture').catch(() => {});
        const canvas = await abortable(exports.canvas({ ...options, backgroundColor: options.backgroundColor ?? '#ffffff' }), signal);
        signal?.throwIfAborted();
        const { quality = 0.92 } = options, photo = { quality: Math.max(1, quality * 100) }, [shot, up = 0] = context[SNAPSHOT] ?? [], clip = context.meta?.clip;
        const area = { x: clip?.x, y: (clip?.y ?? 0) + up, width: clip?.width ?? context.meta?.w0, height: clip?.height ?? context.meta?.h0 };
        // Below 1:1: page-rects maps text boxes through the drawn scale (outward whole pixels) so
        // glyphs stay exact; photos still take the quality. A canvas-limit scale with no photos stays exact.
        // When photos remain, measure scaled boxes against the whole page exact and keep the smaller file
        // (same one-job hooks and abort-checked finish as keepSmaller), so the export never writes larger.
        const naturalW = area.width ?? shot?.box.width, naturalH = area.height ?? shot?.box.height;
        const below = !!(shot && naturalW && naturalH && (canvas.width < naturalW || canvas.height < naturalH));
        let rects = quality < 1 && module !== 'rapier-jxl/capture' && shot
          ? pageRects(shot, canvas, { area, edges: !below && (effort ?? 3) >= 4 }) : null;
        if (below && !(rects?.photoRects?.length)) rects = null;
        let exact = false;
        const base = {
          ...(effort !== undefined && { effort }), ...(webgpu !== undefined && { webgpu }), ...(signal && { signal }),
        };
        const hooks = { signal, onProgress, onEncoded: record => { exact = record?.exact; onEncoded?.(record); } };
        let file;
        if (below && rects) {
          // Candidate A: scaled exactRects + photo quality. Candidate B: the whole page exact.
          file = await captureKeepSmallerJobs(encoder, canvas, base, [
            { fidelity: photo, ...rects },
            { fidelity: 'exact' },
          ], hooks);
        } else {
          file = await encoder.capture(canvas, { ...(rects ? { fidelity: photo, ...rects } : { fidelity: 'exact' }),
            ...base, ...(onProgress !== undefined && { onProgress }), onEncoded: record => { exact = record.exact; onEncoded?.(record); } });
        }
        return { blob: new Blob([resultBytes(file)], { type: 'image/jxl' }), canvas, exact };
      };
      const encode = async (context, options) => (await encoded(context, options)).blob;
      const jxlFormat = options => String(options.format).toLowerCase() === 'jxl';
      return {
        jxl: async (context, options = {}) => {
          const { blob, canvas, exact } = await encoded(context, options);
          return image(blob, options.dpr || 1, context.export?.requestedOptions?.signal, exact ? canvas : null);
        },
        blob: (context, options = {}) => jxlFormat(options) ? encode(context, options) : exports.blob(options),
        async download(context, options = {}) {
          const format = jxlFormat(options) ? 'jxl' : options.format === 'jpg' ? 'jpeg' : options.format || 'png';
          const name = options.filename || 'snapdom', filename = /\.(png|jpe?g|webp|svg|jxl)$/i.test(name) ? name : `${name}.${format}`;
          const next = { ...options, dpr: 1 };
          const blob = format === 'jxl' ? await encode(context, next) : await exports.blob({ ...next, format });
          await save(blob, filename);
        },
      };
    },
  };
}

// Where JPEG XL does not show, a PNG of the exact canvas or of rapier-jxl/decode's copy (loaded only then).
let decoder;
async function image(blob, dpr, signal, exact) {
  const img = new Image(), wait = promise => abortable(promise, signal);
  try { await wait(shown(img, await wait(dataURL(blob)))); } catch (error) {
    if (signal?.aborted) throw signal.reason;
    let canvas = exact;
    if (!canvas) {
      decoder ??= createCodec({ module: 'rapier-jxl/decode', maxPixels: 16384 * 16384 });
      const { data, width, height } = await wait(decoder.decode(blob, { format: 'uint8', colorSpace: 'srgb', maxPixels: 16384 * 16384, ...(signal && { signal }) }));
      canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width, height), 0, 0);
    }
    await wait(shown(img, await wait(dataURL(await wait(new Promise(resolve => canvas.toBlob(resolve, 'image/png')))))));
  }
  signal?.throwIfAborted();
  img.style.width = `${img.naturalWidth / dpr}px`; img.style.height = `${img.naturalHeight / dpr}px`;
  return img;
}
const shown = (img, src) => new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = src; })
  .finally(() => { img.onload = img.onerror = null; });
const dataURL = blob => new Promise((resolve, reject) => {
  const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob);
});

// iOS saves a file only through the share sheet.
async function save(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  const ios = navigator.userAgentData ? navigator.userAgentData.platform === 'iOS'
    : /iPhone|iPad|iPod/.test(navigator.userAgent) || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  if (ios && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return; } catch (error) { if (error.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const SNAPSHOT = Symbol('jxl snapshot');
// SnapDOM draws <html> from <body>'s top.
const lift = el => el === document.documentElement && document.body ? document.body.getBoundingClientRect().top - el.getBoundingClientRect().top : 0;


// Below-1:1 dual job: encode each candidate quietly, then one public onEncoded + progress 1 through
// the same abort-checked finish path keepSmaller uses (run-capture-photo.mjs). Progress spans are
// contiguous 0→1 with no restart; fields on the caller's hooks beyond onProgress/onEncoded stay on
// every candidate via ...base.
async function captureKeepSmallerJobs(encoder, canvas, base, jobs, hooks) {
  const n = jobs.length, span = 1 / n;
  let best = null, record = null;
  for (let i = 0; i < n; i++) {
    const from = i * span;
    let got = null;
    const result = await encoder.capture(canvas, {
      ...base,
      ...jobs[i],
      onProgress: hooks.onProgress && (f => { if (f < 1) hooks.onProgress(from + f * span); }),
      onEncoded: r => { got = r; },
    });
    if (result.fits && result.bytes &&
        (!best || result.bytes.byteLength < best.bytes.byteLength)) { best = result; record = got; }
  }
  const signal = hooks.signal;
  signal?.throwIfAborted();
  resultBytes(best);
  hooks.onEncoded?.(record ?? { exact: false });
  signal?.throwIfAborted();
  hooks.onProgress?.(1);
  signal?.throwIfAborted();
  return best;
}

function resultBytes(result) {
  if (!result?.fits || !result.bytes)
    throw Object.assign(new Error(result?.reason?.message ?? 'The JPEG XL rendition did not meet the requested target.'),
      { code: result?.reason?.code ?? 'JXL_UNSUPPORTED' });
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
