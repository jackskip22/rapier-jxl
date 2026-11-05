// SPDX-License-Identifier: MIT
// Heartbeat: window.__result updates after every step (done:true at end) so a hang names its step.
// Harness: canvases attached + visible + rAF; getImageData/readPixels/photo inside step().
// 2D contexts opened with {colorSpace:'srgb', willReadFrequently:true} — same as check.mjs
// (decode 47/47 on Safari 27.2). Opening bare getContext('2d') first permanently pins a
// non-WRF context (HTML getContext options are sticky), which is what failed on 41979942528.
// Canvas text is from NASA's public-domain Apollo 12 page (see README).
const {encode, capture} = await import('rapier-jxl');
const {capture: capturePhoto} = await import('rapier-jxl/capture-complete');
const {decode} = await import('rapier-jxl/decode');
const {createCodec} = await import('rapier-jxl/codec');
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const steps = [], platform = {context2dAttributes: typeof CanvasRenderingContext2D.prototype.getContextAttributes,
  webgl2: !!document.createElement('canvas').getContext('webgl2'), offscreen: typeof OffscreenCanvas, gpu: !!navigator.gpu};
const beat = (at) => { window.__result = {done: false, at, userAgent: navigator.userAgent, platform, steps: steps.slice()}; document.getElementById('state').textContent = at; };
const step = async (name, f) => { beat('before:' + name); try { steps.push({name, ...await f()}); } catch (e) { steps.push({name, pass: false, error: String(e?.message || e).slice(0, 200), code: e?.code, stack: String(e?.stack || '').split('\n').slice(0, 4).join(' | ').slice(0, 400)}); } beat('after:' + name); };
const viaCodec = async (module, input, options) => { const q = createCodec({module}); try { return await q.capture(input, options); } finally { await q.close(); } };
const rAF = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
const host = document.getElementById('host');
const attach = (c) => { c.style.cssText = `display:block;width:${c.width}px;height:${c.height}px;`; host.appendChild(c); };
const ctx2d = (c) => c.getContext('2d', {colorSpace: 'srgb', willReadFrequently: true});
beat('start');

const c2 = document.createElement('canvas'); c2.width = 300; c2.height = 200;
attach(c2);
const g = ctx2d(c2);
g.fillStyle = '#f4f4ef'; g.fillRect(0, 0, 300, 200); g.fillStyle = '#123'; g.font = '14px sans-serif';
g.fillText('Apollo 12: The Pinpoint Mission', 10, 28);
g.font = '11px sans-serif';
g.fillText('NASA public-domain text', 10, 46);
for (let y = 60; y < 200; y++) for (let x = 120; x < 300; x += 2) { g.fillStyle = `rgb(${(x * 7 + y * 3) % 40 + x},${(y * 5 + x) % 40 + y / 2 | 0},${150 + (x * y) % 40})`; g.fillRect(x, y, 2, 1); }
await rAF();

let px2d = null, page2d = null;
await step('2D canvas, getImageData', async () => {
  px2d = g.getImageData(0, 0, 300, 200).data;
  return {pass: px2d.length === 300 * 200 * 4, bytes: px2d.length, willReadFrequently: g.getContextAttributes?.().willReadFrequently ?? null};
});
await step('2D canvas, in page', async () => {
  if (!px2d) throw new Error('skipped: no px2d');
  page2d = await capture(c2);
  return {pass: same((await decode(page2d)).data, px2d), bytes: page2d.length};
});
await step('2D canvas, through createCodec', async () => {
  if (!page2d) throw new Error('skipped: no page2d');
  const b = await viaCodec('rapier-jxl/capture', c2);
  return {pass: same(b, page2d), bytes: b.length};
});

const glCanvas = document.createElement('canvas'); glCanvas.width = 256; glCanvas.height = 160;
attach(glCanvas);
await rAF();
const gl = glCanvas.getContext('webgl', {preserveDrawingBuffer: true});
if (!gl) steps.push({name: 'WebGL canvas', pass: true, skipped: 'no WebGL'});
else {
  gl.enable(gl.SCISSOR_TEST);
  for (let i = 0; i < 8; i++) { gl.scissor(i * 32, 0, 32, 160 - i * 12); gl.clearColor(i / 8, 1 - i / 8, (i * 3 % 8) / 8, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
  let flipped = null, pageGl = null;
  await step('WebGL canvas, readPixels', async () => {
    const raw = new Uint8Array(256 * 160 * 4);
    flipped = new Uint8Array(raw.length);
    gl.readPixels(0, 0, 256, 160, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    for (let y = 0; y < 160; y++) flipped.set(raw.subarray((159 - y) * 1024, (160 - y) * 1024), y * 1024);
    return {pass: flipped.length === 256 * 160 * 4, bytes: flipped.length};
  });
  await step('WebGL canvas, in page', async () => {
    if (!flipped) throw new Error('skipped: no flipped');
    pageGl = await capture(glCanvas);
    return {pass: same((await decode(pageGl)).data, flipped), bytes: pageGl.length};
  });
  await step('WebGL canvas, through createCodec', async () => {
    if (!pageGl) throw new Error('skipped: no pageGl');
    const b = await viaCodec('rapier-jxl/capture', glCanvas);
    return {pass: same(b, pageGl), bytes: b.length};
  });
}

const big = document.createElement('canvas'); big.width = 640; big.height = 400;
attach(big);
const bg = ctx2d(big);
bg.fillStyle = '#fff'; bg.fillRect(0, 0, 640, 400); bg.fillStyle = '#000'; bg.font = '12px sans-serif';
const nasaLines = [
  'Apollo 12: The Pinpoint Mission (NASA)',
  'The primary mission objectives of the second crewed',
  'lunar landing included an extensive series of lunar',
  'exploration tasks by the lunar module, or LM, crew,',
  'as well as the deployment of the Apollo Lunar Surface',
  'Experiments Package, or ALSEP, which was to be left',
  'on the moon\'s surface to gather seismic, scientific',
  'and engineering data throughout a long period of time.',
  'Other Apollo 12 objectives included a selenological',
  'inspection; surveys and samplings in landing areas;',
  'development of techniques for precision-landing',
  'capabilities; and photography of candidate sites.',
];
nasaLines.forEach((line, i) => bg.fillText(line, 10, 18 + i * 16));
await step('capture page, draw photo.jpg', async () => {
  bg.drawImage(await createImageBitmap(await (await fetch('photo.jpg')).blob()), 300, 20, 320, 375);
  await rAF();
  return {pass: true};
});
await step('capture-complete q80, page = worker', async () => {
  const a = await capturePhoto(big, {fidelity: {quality: 80}}), b = await viaCodec('rapier-jxl/capture-complete', big, {fidelity: {quality: 80}}), exact = await capturePhoto(big);
  const ref = bg.getImageData(0, 0, 640, 400).data;
  return {pass: same(a, b) && a.length < exact.length && same((await decode(exact)).data, ref), bytes: a.length, exactBytes: exact.length};
});
await step('encode(canvas)', async () => {
  const b = await encode(c2);
  return {pass: b.length > 0 && (await decode(b)).width === 300, bytes: b.length};
});
window.__result = {done: true, at: 'done', userAgent: navigator.userAgent, platform, steps};
document.getElementById('state').textContent = 'done';
