// Harness only: the plug-in's encoder module, unchanged, with a record of what reaches capture().
// The record names the input as the page sees it and the error as rapier-jxl throws it.
import * as real from '/rapier-jxl/dist/codec-capture-complete.mjs'
const log = globalThis.__jxlInputs ??= []
const is = (v, name) => { try { return typeof globalThis[name] === 'function' && v instanceof globalThis[name] } catch { return 'throws' } }
export function describe(v) {
  if (v === null || typeof v !== 'object') return { type: typeof v }
  let proto = null
  try { proto = Object.getPrototypeOf(v) } catch {}
  return {
    tag: Object.prototype.toString.call(v),
    ctor: proto?.constructor?.name ?? null,
    plainHere: proto === Object.prototype,
    getContext: typeof v.getContext,
    canvas: is(v, 'HTMLCanvasElement'), offscreen: is(v, 'OffscreenCanvas'),
    bitmap: is(v, 'ImageBitmap'), imageData: is(v, 'ImageData'), blob: is(v, 'Blob'),
    width: v.width, height: v.height,
    keys: proto === Object.prototype ? Object.keys(v).slice(0, 12) : undefined,
    data: v.data ? Object.prototype.toString.call(v.data) : undefined,
  }
}
export function createCodec(config) {
  const codec = real.createCodec(config)
  const wrapped = {}
  for (const k of Object.keys(codec)) wrapped[k] = typeof codec[k] === 'function' ? codec[k].bind(codec) : codec[k]
  wrapped.capture = async (input, options) => {
    const rec = { input: describe(input), options: options && Object.keys(options) }
    try { return await codec.capture(input, options) } catch (e) {
      rec.error = { code: e?.code, message: String(e?.message ?? e).slice(0, 200), stack: String(e?.stack ?? '').split('\n').slice(0, 8).join(' | ').slice(0, 900), cause: e?.cause ? String(e.cause?.message ?? e.cause).slice(0, 200) : undefined }
      throw e
    } finally { if (log.length < 40) log.push(rec) }
  }
  Object.defineProperty(wrapped, 'stats', { get: () => codec.stats })
  return Object.freeze(wrapped)
}

// The same encoder on inputs made here, without SnapDOM: a bare, a forced-readable and an
// OffscreenCanvas, ImageData, a {data, width, height} record and an ImageBitmap.
export async function boundary() {
  const env = {
    ua: navigator.userAgent, gpu: !!navigator.gpu, worker: typeof Worker, offscreen: typeof OffscreenCanvas,
    videoFrame: typeof VideoFrame, float16: typeof Float16Array, createImageBitmap: typeof createImageBitmap,
    shim: HTMLCanvasElement.prototype.getContext.toString().includes('willReadFrequently'),
  }
  const draw = c => { const x = c.getContext('2d'); x.fillStyle = '#c33'; x.fillRect(0, 0, 32, 32); x.fillStyle = '#36c'; x.fillRect(8, 8, 16, 16); return x }
  const el = () => { const c = document.createElement('canvas'); c.width = c.height = 32; draw(c); return c }
  const codec = real.createCodec({ module: 'rapier-jxl/capture-complete' })
  const cases = {
    canvas: el,
    offscreen: () => { const c = new OffscreenCanvas(32, 32); draw(c); return c },
    imageData: () => el().getContext('2d').getImageData(0, 0, 32, 32),
    record: () => { const d = el().getContext('2d').getImageData(0, 0, 32, 32); return { data: d.data, width: 32, height: 32 } },
    bitmap: () => createImageBitmap(el()),
  }
  const rows = {}
  for (const [name, make] of Object.entries(cases)) {
    let input
    try {
      input = await make()
      const bytes = await codec.capture(input, { fidelity: 'exact' })
      rows[name] = { ok: true, bytes: bytes?.byteLength ?? bytes?.size ?? bytes?.data?.byteLength ?? bytes?.bytes?.byteLength ?? Object.prototype.toString.call(bytes), input: describe(input) }
    } catch (e) {
      rows[name] = { ok: false, code: e?.code, message: String(e?.message ?? e).slice(0, 200), stack: String(e?.stack ?? '').split('\n').slice(0, 6).join(' | ').slice(0, 700), input: describe(input) }
    }
  }
  // An ImageBitmap posted to a module worker: what the worker sees.
  try {
    const src = 'onmessage = e => postMessage({ bitmap: typeof ImageBitmap === "function" && e.data instanceof ImageBitmap, tag: Object.prototype.toString.call(e.data), w: e.data?.width, offscreen: typeof OffscreenCanvas })'
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })), { type: 'module' })
    const b = await createImageBitmap(el())
    rows.workerBitmap = await new Promise((res, rej) => { w.onmessage = e => res(e.data); w.onerror = e => rej(new Error(e.message || 'worker error')); w.postMessage(b, [b]); setTimeout(() => rej(new Error('timeout')), 5000) })
    w.terminate()
  } catch (e) { rows.workerBitmap = { ok: false, message: String(e?.message ?? e) } }
  try { rows.stats = JSON.parse(JSON.stringify(codec.stats ?? null)) } catch {}
  try { await codec.close?.() } catch {}
  return { env, rows }
}
