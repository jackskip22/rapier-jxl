// SPDX-License-Identifier: MIT
// Rows for the candidate only, on real Safari. Each row passes or fails. Heartbeat: window.__result after every step;
// done:true when finished.
//   verify: Display P3 and alpha (WebKit's ImageBitmap premultiplies alpha and turns P3 into sRGB, so verify refused them);
//   animation: an animated PNG and WebP Blob (8.3.5 encodes an animated WebP Blob as a still; a still is a fail, a refusal
//     by name or every frame is a pass);
//   gif: a GIF as a Blob and as a File, through the codec, four calls at once, an abort;
//   round trip: 300 generated pictures, exact at efforts 1 to 9 in turn, decoded by Safari itself (createImageBitmap), every
//     sample compared where the picture is opaque.
const steps = [], pkg = document.documentElement.dataset.pkg;
const {encode} = await import('rapier-jxl');
const {verify, configureDecoder} = await import('rapier-jxl/verify');
const {restore} = await import('rapier-jxl/jpeg');
const animation = await import('rapier-jxl/animation');
const {decode} = await import('rapier-jxl/decode');
const {createCodec} = await import('rapier-jxl/codec');
const beat = at => { window.__result = {done: false, at, pkg, userAgent: navigator.userAgent, steps: steps.slice()}; document.getElementById('state').textContent = at; };
const step = async (name, f) => {
  beat('before:' + name);
  const t = performance.now();
  try { const r = await f(); steps.push({name, pass: r?.pass !== false, ms: Math.round(performance.now() - t), ...r}); }
  catch (e) { steps.push({name, pass: false, ms: Math.round(performance.now() - t), error: (e?.code ? e.code + ': ' : '') + String(e?.message ?? e).slice(0, 200)}); }
  beat('after:' + name);
};
const file = async name => new Uint8Array(await (await fetch('./files/' + name)).arrayBuffer());

// verify: a canvas in Display P3 and a canvas with alpha, encoded exact, verified against the same canvas (on the browser's
// own JPEG XL decoder; where it has none, rapier-jxl/decode, and the row says so).
let packageDecoder = false;
for (const [name, colorSpace, alpha] of [['verify: Display P3 canvas, exact', 'display-p3', false], ['verify: alpha canvas, exact', 'srgb', true]]) {
  await step(name, async () => {
    const c = document.createElement('canvas'); c.width = 96; c.height = 64;
    const g = c.getContext('2d', {colorSpace, willReadFrequently: true});
    for (let x = 0; x < 96; x++) { g.fillStyle = colorSpace === 'display-p3' ? `color(display-p3 ${x / 95} ${1 - x / 95} 0.4${alpha ? ' / 0.5' : ''})` : `rgba(${x * 2}, 90, ${255 - x * 2}, ${alpha ? (x % 8) / 7 : 1})`; g.fillRect(x, 0, 1, 64); }
    const result = await encode(c, {fidelity: 'exact', ...colorSpace === 'display-p3' && {readAs: 'display-p3'}});
    let receipt;
    try { receipt = await verify(c, result); }
    catch (e) { if (e?.code !== 'JXL_UNSUPPORTED' || packageDecoder) throw e; packageDecoder = true; configureDecoder(decode, restore); receipt = await verify(c, result); }
    return {bytes: result.bytes.length, kind: receipt?.kind, decoder: packageDecoder ? 'rapier-jxl/decode' : 'the browser'};
  });
}

// animation: an animated PNG and an animated WebP Blob (eight frames each).
for (const [name, type] of [['pan8.png', 'image/png'], ['pan8.webp', 'image/webp']]) {
  await step('animation: ' + name + ' Blob', async () => {
    let result;
    try { result = await animation.encode(new Blob([await file(name)], {type}), {fidelity: 'exact', effort: 1}); }
    catch (e) { return {pass: /^JXL_/.test(e?.code ?? ''), refused: e?.code, message: String(e?.message).slice(0, 120)}; }
    const frames = (await decode(result.bytes)).frames?.length ?? 1;
    return {pass: frames === 8, frames, bytes: result.bytes.length};
  });
}

// gif: a GIF as a Blob, as a File, through the codec; four codec calls at once; an abort.
const gif = await file('two-frames.gif');
const framesOf = async bytes => (await decode(bytes)).frames?.length ?? 1;
await step('gif: GIF Blob', async () => { const r = await animation.encode(new Blob([gif], {type: 'image/gif'}), {fidelity: 'exact'}); const n = await framesOf(r.bytes); return {pass: n === 2, frames: n}; });
await step('gif: GIF as a File', async () => { const r = await animation.encode(new File([gif], 'a.gif', {type: 'image/gif'}), {fidelity: 'exact'}); const n = await framesOf(r.bytes); return {pass: n === 2, frames: n}; });
const codec = createCodec({module: 'rapier-jxl/animation'});
await step('gif: codec GIF Blob', async () => { const r = await codec.encode(new Blob([gif], {type: 'image/gif'}), {fidelity: 'exact'}); const n = await framesOf(r.bytes); return {pass: n === 2, frames: n}; });
await step('gif: codec, four at once', async () => {
  const all = await Promise.allSettled(Array.from({length: 4}, () => codec.encode(new Blob([gif], {type: 'image/gif'}), {fidelity: 'exact'})));
  return {pass: all.every(r => r.status === 'fulfilled' && r.value.bytes?.length), fulfilled: all.filter(r => r.status === 'fulfilled').length};
});
await step('gif: codec abort', async () => {
  const controller = new AbortController(), call = codec.encode(new Blob([gif], {type: 'image/gif'}), {fidelity: 'exact', signal: controller.signal});
  controller.abort('stop');
  try { await call; return {pass: false, error: 'resolved after abort'}; } catch (e) { return {pass: true, rejected: String(e?.message ?? e).slice(0, 80)}; }
});
codec.close?.();

// round trip: 300 pictures, Safari's own decoder.
await step('round trip: 300 pictures, exact, Safari decodes', async () => {
  let s = 300, worst = null, failed = 0;
  const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
  const c = document.createElement('canvas'), g = c.getContext('2d', {willReadFrequently: true});
  for (let i = 0; i < 300; i++) {
    const w = 1 + Math.floor(rnd() * 96), h = 1 + Math.floor(rnd() * 96), kind = i % 4, alpha = i % 5 === 0, data = new Uint8ClampedArray(w * h * 4);
    for (let p = 0; p < w * h; p++) {
      const x = p % w, y = (p / w) | 0, n = rnd() * 255;
      const v = kind === 0 ? [n, n * 0.7, 255 - n] : kind === 1 ? [x * 255 / w, y * 255 / h, (x ^ y) & 255] : kind === 2 ? [x % 7 ? 250 : 20, 240, 230] : [n, n, n];
      data.set([...v.map(Math.round), alpha ? (x * 37 + y) & 255 : 255], p * 4);
    }
    try {
      const r = await encode({data, width: w, height: h}, {fidelity: 'exact', effort: 1 + i % 9});
      const bitmap = await createImageBitmap(new Blob([r.bytes], {type: 'image/jxl'}));
      c.width = w; c.height = h; g.clearRect(0, 0, w, h); g.drawImage(bitmap, 0, 0);
      const got = g.getImageData(0, 0, w, h).data;
      for (let p = 0; p < w * h; p++) {
        if (data[p * 4 + 3] !== 255) continue; // Safari's canvas holds premultiplied pixels: compare the opaque ones
        for (let k = 0; k < 4; k++) if (got[p * 4 + k] !== data[p * 4 + k]) { failed++; worst ??= {i, w, h, x: p % w, y: (p / w) | 0, k, got: got[p * 4 + k], want: data[p * 4 + k]}; p = w * h; break; }
      }
    } catch (e) { failed++; worst ??= {i, w, h, error: (e?.code ?? '') + ' ' + String(e?.message ?? e).slice(0, 100)}; }
    if (i % 25 === 0) beat('round trip ' + i);
  }
  return {pass: failed === 0, failed, first: worst};
});

window.__result = {done: true, pkg, userAgent: navigator.userAgent, steps};
document.getElementById('state').textContent = 'done';
