// The jxl plugin as released against the plugin with the patches, on pages with text over a photograph, in the
// engine BROWSER names. Both use the same encoder (jpegxl/capture-complete) at the plugin's default effort, through
// the same recording codec, so only the plugin differs. One JSON line per page and density, written to
// measure-<engine>.jsonl in the project root:
//   before/after: bytes, the median time of three exports (after one warm-up), whether the three files were identical,
//   and wrong text samples: text samples (where the page drawn with its text transparent differs) that the decoded
//   file does not reproduce exactly. Each arm also records its fixture: a digest of the canvas its encoder was given,
//   its own text-sample count, and how many samples that canvas differs from the reference drawing
//   (canvasNotExport). measure-summary.mjs admits a row only when both arms had the same fixture.
import { it, expect } from 'vitest'
import { server } from 'vitest/browser'
import { snapdom } from '../src/api/snapdom.js'
import { clearPlugins } from '../src/core/plugins.js'
import { jxl as patched } from '../packages/plugins/jxl.js'
import { jxl as released } from './zz-jxl-released.js'
import { createCodec } from 'jpegxl/codec'
import { createCodec as createDecoder } from 'jpegxl/codec/decode'

const photo = n => new URL(`../__measure__/${n}.jpg`, import.meta.url).href
const P = ['AS12-46-6832', 'S68-26668', 'S69-34968', '9515834'].map(photo)
const BOX = 'position:relative;width:600px;height:360px;overflow:hidden;background:#fff;font-family:sans-serif'
const IMG = src => `<img src="${src}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">`
const PAGES = {
  'hero-headline': `${IMG(P[0])}<h1 style="position:absolute;left:40px;top:120px;margin:0;font:700 46px sans-serif;color:#fff">One small step</h1>`,
  'caption-scrim': `${IMG(P[1])}<div style="position:absolute;left:0;right:0;bottom:0;padding:14px 20px;background:rgba(0,0,0,.5);color:#fff;font:18px sans-serif">The crew trains for the lunar landing at the simulator.</div>`,
  'price-badge': `${IMG(P[2])}<span style="position:absolute;right:20px;top:20px;padding:6px 12px;background:#d22;color:#fff;font:700 20px sans-serif">$1,969</span>`,
  'small-gray': `${IMG(P[3])}<p style="position:absolute;left:24px;top:220px;width:300px;margin:0;font:13px/1.4 sans-serif;color:#ddd">Photograph by NASA. The image is in the public domain and may be used without permission for any purpose.</p>`,
  'text-shadow': `${IMG(P[0])}<h2 style="position:absolute;left:40px;top:40px;margin:0;font:700 36px sans-serif;color:#fff;text-shadow:0 2px 6px #000">Tranquility Base</h2>`,
  'gradient-over-photo': `${IMG(P[1])}<div style="position:absolute;inset:0;background:linear-gradient(transparent 40%,rgba(0,0,0,.7))"></div><h2 style="position:absolute;left:28px;bottom:24px;margin:0;font:700 30px sans-serif;color:#fff">Apollo 8 launch</h2>`,
  'watermark': `${IMG(P[2])}<div style="position:absolute;left:60px;top:140px;font:700 64px sans-serif;color:rgba(255,255,255,.35)">SAMPLE</div>`,
  'article (no photo, control)': `<article style="padding:24px;font:16px/1.5 serif;color:#222">${'<p>A page of article text with no photograph at all, which the plugin draws once.</p>'.repeat(6)}</article>`,
}
const HIDE = '*{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important}'
const median = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]
const u32 = d => new Uint32Array(d.buffer, d.byteOffset, d.length >> 2)
// Per sample, red, green and blue: text samples (the reference drawing a against the same drawing with its text
// transparent, b), those the decoded file f does not reproduce from the encoder's canvas d, and the samples where d
// is not the reference drawing. A plain function, called after the decode: in WebKit the same loop written inside
// the async closure that awaits the decode counted 187,669 differing samples between arrays whose digests were equal.
function count(a, b, d, f) {
  const rgb = 0x00ffffff, A = u32(a), B = u32(b), D = u32(d), F = u32(f)
  let wrong = 0, text = 0, drawnDiffers = 0
  for (let i = 0; i < A.length; i++) {
    const ai = A[i] & rgb, di = D[i] & rgb
    if (di !== ai) drawnDiffers++
    if (ai === (B[i] & rgb)) continue
    text++
    if ((F[i] & rgb) !== di) wrong++
  }
  return { wrong, text, drawnDiffers, fixture: `${d.length}:${digest(d)}` }
}
// FNV-1a over the samples: equal only for the same canvas.
const digest = d => { let h = 0x811c9dc5; for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 0x01000193); return (h >>> 0).toString(16) }
const rgba = c => c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data

async function page(html) {
  const el = document.createElement('div')
  el.style.cssText = BOX
  el.innerHTML = html
  document.body.append(el)
  await Promise.all([...el.querySelectorAll('img')].map(i => i.decode()))
  return el
}

// One plugin variant on one page: bytes, times, identical files, and the canvas the encoder was given.
async function run(make, el, dpr) {
  const real = createCodec({ module: 'jpegxl/capture-complete' })
  let drawn = null
  const codec = {
    prepare: k => real.prepare(k),
    capture: (canvas, options) => { drawn ??= { w: canvas.width, h: canvas.height, d: rgba(canvas).slice() }; return real.capture(canvas, options) },
  }
  const plugin = make({ codec })
  try {
    const result = await snapdom(el, { dpr, embedFonts: false, burst: false, plugins: [plugin] })
    await result.toBlob({ format: 'jxl' })
    const times = [], files = []
    for (let i = 0; i < 3; i++) {
      const t = performance.now()
      const blob = await result.toBlob({ format: 'jxl' })
      times.push(performance.now() - t)
      files.push(new Uint8Array(await blob.arrayBuffer()))
    }
    const same = files.every(f => f.length === files[0].length && f.every((v, i) => v === files[0][i]))
    return { result, bytes: files[0].length, ms: Math.round(median(times)), same, file: files[0], drawn }
  } finally {
    await plugin.close?.()
    await real.close()
    clearPlugins()
  }
}

it('the jxl plugin as released and with the patches, on text over photographs', async () => {
  const decoder = createDecoder({ module: 'jpegxl/decode' })
  const lines = []
  for (const [name, html] of Object.entries(PAGES)) for (const dpr of [1, 2]) {
    const el = await page(html)
    try {
      const before = await run(o => released(o), el, dpr)
      const after = await run(o => patched(o), el, dpr)
      // Text samples: the export's own drawing against the same drawing with every text transparent.
      const plain = await after.result.toCanvas({ backgroundColor: '#ffffff' })
      const bare = await after.result.toCanvas({ backgroundColor: '#ffffff', css: HIDE })
      const a = rgba(plain), b = rgba(bare)
      const wrong = async (r) => count(a, b, r.drawn.d, (await decoder.decode(r.file)).data)
      const wb = await wrong(before), wa = await wrong(after)
      lines.push({ engine: server.browser, page: name, dpr, width: plain.width, height: plain.height, textSamples: wa.text,
        before: { bytes: before.bytes, ms: before.ms, same: before.same, wrongText: wb.wrong, canvasNotExport: wb.drawnDiffers, textSamples: wb.text, fixture: wb.fixture },
        after: { bytes: after.bytes, ms: after.ms, same: after.same, wrongText: wa.wrong, canvasNotExport: wa.drawnDiffers, textSamples: wa.text, fixture: wa.fixture },
        ratio: +(after.bytes / before.bytes).toFixed(4) })
    } finally {
      el.remove()
    }
  }
  await decoder.close()
  await server.commands.writeFile(`measure-${server.browser}.jsonl`, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  expect(lines.length).toBe(Object.keys(PAGES).length * 2)
}, 60 * 60_000)
