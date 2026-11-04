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
        const { quality = 0.92 } = options, [shot, up = 0] = context[SNAPSHOT] ?? [], clip = context.meta?.clip;
        const area = { x: clip?.x, y: (clip?.y ?? 0) + up, width: clip?.width ?? context.meta?.w0, height: clip?.height ?? context.meta?.h0 };
        // Drawn below 1:1 (past the canvas limit), text blurs past any box: exact, said up front, skips the photo search.
        const rects = quality < 1 && module !== 'rapier-jxl/capture' && shot && canvas.width >= (area.width ?? shot.box.width)
          && canvas.height >= (area.height ?? shot.box.height) ? pageRects(shot, canvas, { area, edges: (effort ?? 3) >= 4 }) : null;
        let exact = false;
        const file = await encoder.capture(canvas, { ...(rects ? { fidelity: { webp: Math.max(0, quality) }, ...rects } : { fidelity: 'exact' }),
          ...(effort !== undefined && { effort }), ...(webgpu !== undefined && { webgpu }), ...(signal && { signal }),
          ...(onProgress !== undefined && { onProgress }), onEncoded: record => { exact = record.exact; onEncoded?.(record); } });
        return { blob: new Blob([file], { type: 'image/jxl' }), canvas, exact };
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

function abortable(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}
