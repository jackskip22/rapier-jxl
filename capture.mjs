// SPDX-License-Identifier: MIT
// In a browser, with the staged package under package/dist/ (import map in capture.html): capture from a 2D canvas and from
// a WebGL canvas, in the page and through createCodec's worker, capture-complete in its worker, encode(canvas). Each step runs
// on its own and reports its error; an exact capture must decode (rapier-jxl/decode) to the canvas's own pixels, and the
// codec must write the page's bytes. Canvas text is from NASA's public-domain Apollo 12 page (see README).
const {encode, capture} = await import('rapier-jxl');
const {capture: capturePhoto} = await import('rapier-jxl/capture-complete');
const {decode} = await import('rapier-jxl/decode');
const {createCodec} = await import('rapier-jxl/codec');
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const steps = [], platform = {context2dAttributes: typeof CanvasRenderingContext2D.prototype.getContextAttributes,
  webgl2: !!document.createElement('canvas').getContext('webgl2'), offscreen: typeof OffscreenCanvas, gpu: !!navigator.gpu};
const step = async (name, f) => { try { steps.push({name, ...await f()}); } catch (e) { steps.push({name, pass: false, error: String(e?.message || e).slice(0, 200), code: e?.code, stack: String(e?.stack || '').split('\n').slice(0, 4).join(' | ').slice(0, 400)}); } };
const viaCodec = async (module, input, options) => { const q = createCodec({module}); try { return await q.capture(input, options); } finally { await q.close(); } };

const c2 = document.createElement('canvas'); c2.width = 300; c2.height = 200;
const g = c2.getContext('2d');
g.fillStyle = '#f4f4ef'; g.fillRect(0, 0, 300, 200); g.fillStyle = '#123'; g.font = '14px sans-serif';
g.fillText('Apollo 12: The Pinpoint Mission', 10, 28);
g.font = '11px sans-serif';
g.fillText('NASA public-domain text', 10, 46);
for (let y = 60; y < 200; y++) for (let x = 120; x < 300; x += 2) { g.fillStyle = `rgb(${(x * 7 + y * 3) % 40 + x},${(y * 5 + x) % 40 + y / 2 | 0},${150 + (x * y) % 40})`; g.fillRect(x, y, 2, 1); }
const px2d = g.getImageData(0, 0, 300, 200).data;
let page2d;
await step('2D canvas, in page', async () => { page2d = await capture(c2); return {pass: same((await decode(page2d)).data, px2d), bytes: page2d.length}; });
await step('2D canvas, through createCodec', async () => { const b = await viaCodec('rapier-jxl/capture', c2); return {pass: !!page2d && same(b, page2d), bytes: b.length}; });

const glCanvas = document.createElement('canvas'); glCanvas.width = 256; glCanvas.height = 160;
const gl = glCanvas.getContext('webgl', {preserveDrawingBuffer: true});
if (!gl) steps.push({name: 'WebGL canvas', pass: true, skipped: 'no WebGL'});
else {
  gl.enable(gl.SCISSOR_TEST);
  for (let i = 0; i < 8; i++) { gl.scissor(i * 32, 0, 32, 160 - i * 12); gl.clearColor(i / 8, 1 - i / 8, (i * 3 % 8) / 8, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
  const raw = new Uint8Array(256 * 160 * 4), flipped = new Uint8Array(raw.length);
  gl.readPixels(0, 0, 256, 160, gl.RGBA, gl.UNSIGNED_BYTE, raw);
  for (let y = 0; y < 160; y++) flipped.set(raw.subarray((159 - y) * 1024, (160 - y) * 1024), y * 1024);
  let pageGl;
  await step('WebGL canvas, in page', async () => { pageGl = await capture(glCanvas); return {pass: same((await decode(pageGl)).data, flipped), bytes: pageGl.length}; });
  await step('WebGL canvas, through createCodec', async () => { const b = await viaCodec('rapier-jxl/capture', glCanvas); return {pass: !!pageGl && same(b, pageGl), bytes: b.length}; });
}
const big = document.createElement('canvas'); big.width = 640; big.height = 400;
const bg = big.getContext('2d');
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
bg.drawImage(await createImageBitmap(await (await fetch('photo.jpg')).blob()), 300, 20, 320, 375);
await step('capture-complete q80, page = worker', async () => {
  const a = await capturePhoto(big, {fidelity: {quality: 80}}), b = await viaCodec('rapier-jxl/capture-complete', big, {fidelity: {quality: 80}}), exact = await capturePhoto(big);
  return {pass: same(a, b) && a.length < exact.length && same((await decode(exact)).data, bg.getImageData(0, 0, 640, 400).data), bytes: a.length, exactBytes: exact.length};
});
await step('encode(canvas)', async () => { const b = await encode(c2); return {pass: b.length > 0 && (await decode(b)).width === 300, bytes: b.length}; });
window.__result = {userAgent: navigator.userAgent, platform, steps};
document.getElementById('state').textContent = 'done';
