// SPDX-License-Identifier: MIT
// Heartbeat: window.__result updates after every step (done:true at end) so a hang names its step.
// Harness: canvases attached + visible + rAF; getImageData/readPixels/photo inside step().
// 2D contexts opened with {colorSpace:'srgb', willReadFrequently:true} — same as check.mjs
// Opening bare getContext('2d') first would pin a non-WRF context (getContext options are sticky).
// Canvas text is from NASA's public-domain Apollo 12 page (see README).
const {encode, capture} = await import('rapier-jxl');
const {capture: capturePhoto} = await import('rapier-jxl/capture-complete');
const {decode} = await import('rapier-jxl/decode');
const {createCodec} = await import('rapier-jxl/codec');
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const steps = [], platform = {context2dAttributes: typeof CanvasRenderingContext2D.prototype.getContextAttributes,
  webgl2: !!document.createElement('canvas').getContext('webgl2'), offscreen: typeof OffscreenCanvas, gpu: !!navigator.gpu};
const beat = (at) => { window.__result = {done: false, at, pkg: document.documentElement.dataset.pkg, userAgent: navigator.userAgent, platform, steps: steps.slice()}; document.getElementById('state').textContent = at; };
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
  // In page: exact pixels, or a JXL_INPUT refusal for a lost or blank WebGL read; never a wrong file.
  let inPage = null;
  await step('WebGL canvas, in page', async () => {
    if (!flipped) throw new Error('skipped: no flipped');
    try { pageGl = await capture(glCanvas); } catch (e) { inPage = {code: e?.code, error: String(e?.message || e).slice(0, 200)}; throw e; }
    const exact = same((await decode(pageGl)).data, flipped);
    inPage = {bytes: pageGl.length, exact};
    return {pass: exact, bytes: pageGl.length, error: exact ? undefined : 'decoded pixels differ from readPixels (silent wrong file)'};
  });
  // Never a silent wrong file: exact pixels, or a JXL_INPUT refusal.
  await step('WebGL canvas, in page: exact or JXL_INPUT', async () => {
    if (!inPage) throw new Error('skipped: no in-page result');
    if (inPage.code) return {pass: inPage.code === 'JXL_INPUT', code: inPage.code, error: inPage.code === 'JXL_INPUT' ? undefined : inPage.error, refused: inPage.error};
    return {pass: inPage.exact, bytes: inPage.bytes, error: inPage.exact ? undefined : 'returned a wrong file instead of refusing'};
  });
  await step('WebGL canvas, through createCodec', async () => {
    if (!flipped) throw new Error('skipped: no flipped');
    const b = await viaCodec('rapier-jxl/capture', glCanvas);
    return {pass: same((await decode(b)).data, flipped), bytes: b.length};
  });
  // Harness copy route (no rapier-jxl): the WebGL canvas drawn onto a fresh WRF 2D canvas, read there.
  await step('WebGL copy: drawImage onto WRF 2D = readPixels', async () => {
    if (!flipped) throw new Error('skipped: no flipped');
    const c = document.createElement('canvas'); c.width = 256; c.height = 160;
    const g2 = ctx2d(c); g2.drawImage(glCanvas, 0, 0);
    const d = g2.getImageData(0, 0, 256, 160).data;
    let diff = 0; for (let i = 0; i < d.length; i++) diff = Math.max(diff, Math.abs(d[i] - flipped[i]));
    return {pass: diff <= 1, worst: diff, first: Array.from(d.slice(0, 4)).join(',')};
  });
}
// A WebGL canvas whose context is lost (WEBGL_lose_context): capture must refuse it with JXL_INPUT, never write a blank file.
{
  const lost = document.createElement('canvas'); lost.width = 64; lost.height = 48; attach(lost);
  const gl2 = lost.getContext('webgl', {preserveDrawingBuffer: true});
  const ext = gl2?.getExtension('WEBGL_lose_context');
  if (!ext) steps.push({name: 'WebGL lost context: capture refuses', pass: true, skipped: 'no WEBGL_lose_context'});
  else {
    gl2.clearColor(0.2, 0.6, 0.9, 1); gl2.clear(gl2.COLOR_BUFFER_BIT);
    ext.loseContext();
    await step('WebGL lost context: capture refuses with JXL_INPUT', async () => {
      try { const b = await capture(lost); return {pass: false, bytes: b.length, error: 'returned a file for a lost context'}; }
      catch (e) { return {pass: e?.code === 'JXL_INPUT', code: e?.code, refused: String(e?.message || e).slice(0, 160), error: e?.code === 'JXL_INPUT' ? undefined : String(e?.message || e).slice(0, 160)}; }
    });
  }
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
  const sameAB = same(a, b), smaller = a.length < exact.length, exactOk = same((await decode(exact)).data, ref); return {pass: sameAB && smaller && exactOk, sameAB, smaller, exactOk, bytes: a.length, workerBytes: b.length, exactBytes: exact.length};
});
await step('encode(canvas)', async () => {
  const b = await encode(c2);
  return {pass: b.length > 0 && (await decode(b)).width === 300, bytes: b.length};
});
window.__result = {done: true, at: 'done', pkg: document.documentElement.dataset.pkg, userAgent: navigator.userAgent, platform, steps};
document.getElementById('state').textContent = 'done';
