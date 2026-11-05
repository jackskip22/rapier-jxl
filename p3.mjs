// SPDX-License-Identifier: MIT
// Heartbeat: window.__result updates after every step (done:true at end).
// readAs 'display-p3' checks. 2D contexts use willReadFrequently (see capture.mjs / check.mjs).
const {capture} = await import('rapier-jxl/capture');
const {encode} = await import('rapier-jxl');
const {capture: capturePhoto} = await import('rapier-jxl/capture-complete');
const {createCodec} = await import('rapier-jxl/codec');
const colours = [[200, 100, 50], [40, 160, 90], [90, 80, 220], [250, 250, 250], [128, 128, 128], [230, 30, 40]];
const steps = [];
const sample = async bytes => {
  const bitmap = await createImageBitmap(new Blob([bytes], {type: 'image/jxl'}));
  const c = document.createElement('canvas'); c.width = bitmap.width; c.height = bitmap.height;
  const g = c.getContext('2d', {colorSpace: 'srgb', willReadFrequently: true}); g.drawImage(bitmap, 0, 0);
  return colours.map((_, i) => Array.from(g.getImageData(i * 20 + 10, 10, 1, 1).data.slice(0, 3)));
};
const draw = space => {
  const c = document.createElement('canvas'); c.width = colours.length * 20; c.height = 20;
  const g = c.getContext('2d', space ? {colorSpace: space, willReadFrequently: true} : {colorSpace: 'srgb', willReadFrequently: true});
  colours.forEach(([r, gr, b], i) => { g.fillStyle = `rgb(${r},${gr},${b})`; g.fillRect(i * 20, 0, 20, 20); });
  return {c, delivered: g.getContextAttributes?.().colorSpace ?? 'unknown'};
};
const beat = (at) => { window.__result = {done: false, at, userAgent: navigator.userAgent, steps: steps.slice()}; document.getElementById('state').textContent = at; };
const judge = async (name, f, delivered) => {
  beat('before:' + name);
  try {
    const bytes = await f(), got = await sample(bytes);
    const worst = Math.max(...got.map((p, i) => Math.max(...p.map((v, k) => Math.abs(v - colours[i][k])))));
    steps.push({name, pass: worst <= 3, worst, delivered, got: got.map(p => p.join(',')).join(' '), bytes: bytes.length});
  } catch (e) { steps.push({name, pass: false, error: String(e?.message || e).slice(0, 200), code: e?.code}); }
  beat('after:' + name);
};
beat('start');
const srgb = draw();
await judge('sRGB canvas, no readAs', () => capture(srgb.c), srgb.delivered);
await judge("sRGB canvas, readAs 'display-p3', in page", () => capture(srgb.c, {readAs: 'display-p3'}), srgb.delivered);
await judge("sRGB canvas, readAs 'display-p3', codec", async () => { const q = createCodec({module: 'rapier-jxl/capture'}); try { return await q.capture(srgb.c, {readAs: 'display-p3'}); } finally { await q.close(); } }, srgb.delivered);
await judge("sRGB canvas, readAs 'display-p3', capture-complete", () => capturePhoto(srgb.c, {readAs: 'display-p3'}), srgb.delivered);
await judge("sRGB canvas, readAs 'display-p3', encode exact", () => encode(srgb.c, {readAs: 'display-p3', fidelity: 'exact'}), srgb.delivered);
await judge("sRGB canvas, readAs 'display-p3', encode q95", () => encode(srgb.c, {readAs: 'display-p3', fidelity: {quality: 95}}), srgb.delivered);
const p3 = draw('display-p3');
await judge("canvas asked for display-p3, no readAs", () => capture(p3.c), p3.delivered);
await judge("canvas asked for display-p3, readAs 'display-p3'", () => capture(p3.c, {readAs: 'display-p3'}), p3.delivered);
window.__result = {done: true, at: 'done', userAgent: navigator.userAgent, steps};
document.getElementById('state').textContent = 'done';
