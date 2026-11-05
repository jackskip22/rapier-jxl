// SPDX-License-Identifier: MIT
// Heartbeat: window.__result updates after every step (done:true at end) so a hang names its step.
// Harness: canvases attached + visible + rAF; getImageData/readPixels/photo inside step().
// 2D contexts opened with {colorSpace:'srgb', willReadFrequently:true} — same as check.mjs.
// Dual columns (8.2.0 vs candidate); createCodec worker dig probes;
// WebGL in-page: 26 B on 8.2.0; the candidate refuses a lost canvas.
// Canvas text is from NASA's public-domain Apollo 12 page (see README).
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const steps = [], platform = {context2dAttributes: typeof CanvasRenderingContext2D.prototype.getContextAttributes,
  webgl2: !!document.createElement('canvas').getContext('webgl2'), offscreen: typeof OffscreenCanvas, gpu: !!navigator.gpu};
const beat = (at) => { window.__result = {done: false, at, userAgent: navigator.userAgent, platform, steps: steps.slice()}; document.getElementById('state').textContent = at; };
const step = async (name, f) => { beat('before:' + name); try { steps.push({name, ...await f()}); } catch (e) { steps.push({name, pass: false, error: String(e?.message || e).slice(0, 200), code: e?.code, stack: String(e?.stack || '').split('\n').slice(0, 4).join(' | ').slice(0, 400)}); } beat('after:' + name); };
const rAF = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
const host = document.getElementById('host');
const attach = (c) => { c.style.cssText = `display:block;width:${c.width}px;height:${c.height}px;`; host.appendChild(c); };
const ctx2d = (c) => c.getContext('2d', {colorSpace: 'srgb', willReadFrequently: true});

// Dual package: import map → published 8.2.0; candidate via path.
const pkgs = {
  '8.2.0': {
    capture: () => import('rapier-jxl').then(m => m.capture),
    encode: () => import('rapier-jxl').then(m => m.encode),
    decode: () => import('rapier-jxl/decode').then(m => m.decode),
    createCodec: () => import('rapier-jxl/codec').then(m => m.createCodec),
    capturePhoto: () => import('rapier-jxl/capture-complete').then(m => m.capture),
    // Named MODULES keys; workers resolve via import.meta.url of the imported codec.mjs.
    captureModule: 'rapier-jxl/capture',
    captureCompleteModule: 'rapier-jxl/capture-complete',
  },
  candidate: {
    capture: () => import('./package-cand/dist/index.mjs').then(m => m.capture),
    encode: () => import('./package-cand/dist/index.mjs').then(m => m.encode),
    decode: () => import('./package-cand/dist/decode.mjs').then(m => m.decode),
    createCodec: () => import('./package-cand/dist/codec.mjs').then(m => m.createCodec),
    capturePhoto: () => import('./package-cand/dist/capture-complete.mjs').then(m => m.capture),
    captureModule: 'rapier-jxl/capture',
    captureCompleteModule: 'rapier-jxl/capture-complete',
  },
};
const viaCodec = async (pkg, module, input, options) => {
  const createCodec = await pkgs[pkg].createCodec();
  const q = createCodec({module});
  try { return await q.capture(input, options); } finally { await q.close(); }
};

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

let px2d = null;
await step('2D canvas, getImageData', async () => {
  px2d = g.getImageData(0, 0, 300, 200).data;
  return {pass: px2d.length === 300 * 200 * 4, bytes: px2d.length, willReadFrequently: g.getContextAttributes?.().willReadFrequently ?? null};
});

// --- createCodec dig (no product change): what brand reaches a worker after transfer? ---
await step('dig: ImageBitmap brand after worker transfer', async () => {
  const bmp = await createImageBitmap(c2);
  const report = await new Promise((resolve, reject) => {
    const src = `
      self.onmessage = async (ev) => {
        const v = ev.data;
        const tag = Object.prototype.toString.call(v);
        const typeofIB = typeof ImageBitmap;
        const inst = typeof ImageBitmap !== 'undefined' && v instanceof ImageBitmap;
        const typeofOC = typeof OffscreenCanvas;
        let drawOk = false, drawErr = null, bytes = 0, first = null, ctx2d = null;
        try {
          if (typeof OffscreenCanvas !== 'function') throw new Error('no OffscreenCanvas');
          const oc = new OffscreenCanvas(v.width || 0, v.height || 0);
          const ctx = oc.getContext('2d');
          ctx2d = !!ctx;
          if (!ctx) throw new Error('OffscreenCanvas getContext(2d) null');
          ctx.drawImage(v, 0, 0);
          const d = ctx.getImageData(0, 0, v.width, v.height).data;
          bytes = d.length; first = d[0]; drawOk = bytes === v.width * v.height * 4;
        } catch (e) { drawErr = String(e?.message || e).slice(0, 160); }
        self.postMessage({tag, typeofIB, inst, typeofOC, ctx2d, width: v?.width, height: v?.height, hasGetContext: typeof v?.getContext, drawOk, drawErr, bytes, first,
          keys: v && typeof v === 'object' ? Object.keys(v).slice(0, 12) : []});
      };
    `;
    const w = new Worker(URL.createObjectURL(new Blob([src], {type: 'text/javascript'})));
    const t = setTimeout(() => { w.terminate(); reject(new Error('worker dig timeout')); }, 10000);
    w.onmessage = (ev) => { clearTimeout(t); w.terminate(); resolve(ev.data); };
    w.onerror = (e) => { clearTimeout(t); w.terminate(); reject(e.error || e.message); };
    try { w.postMessage(bmp, [bmp]); } catch (e) {
      // Safari may refuse transfer — fall back to structured clone
      try { w.postMessage(bmp); } catch (e2) { clearTimeout(t); w.terminate(); reject(e2); }
    }
  });
  bmp.close?.();
  // pass = we got a report; the interesting bit is inst vs tag (hypothesis: tag ImageBitmap but inst false)
  return {pass: true, ...report, hypothesis: report.typeofIB === 'undefined' ? 'no-ImageBitmap-in-worker' : (!report.ctx2d ? 'no-offscreencanvas-2d' : (report.tag === '[object ImageBitmap]' && report.inst === false ? 'instanceof-fails-tag-ok' : (report.inst && report.drawOk ? 'bitmap-transfer-ok' : (report.inst ? 'instanceof-ok-draw-fail' : 'not-bitmap'))))};
});

await step('dig: ImageData brand after worker structured clone', async () => {
  const id = g.getImageData(0, 0, 300, 200);
  const report = await new Promise((resolve, reject) => {
    const src = `
      self.onmessage = (ev) => {
        const v = ev.data;
        const tag = Object.prototype.toString.call(v);
        const inst = typeof ImageData !== 'undefined' && v instanceof ImageData;
        const dataView = ArrayBuffer.isView(v?.data);
        self.postMessage({tag, inst, width: v?.width, height: v?.height, dataView, dataLen: v?.data?.length ?? null,
          keys: v && typeof v === 'object' ? Object.keys(v).slice(0, 12) : []});
      };
    `;
    const w = new Worker(URL.createObjectURL(new Blob([src], {type: 'text/javascript'})));
    const t = setTimeout(() => { w.terminate(); reject(new Error('worker dig timeout')); }, 10000);
    w.onmessage = (ev) => { clearTimeout(t); w.terminate(); resolve(ev.data); };
    w.onerror = (e) => { clearTimeout(t); w.terminate(); reject(e.error || e.message); };
    w.postMessage(id);
  });
  return {pass: true, ...report, hypothesis: report.tag === '[object ImageData]' && report.inst === false ? 'instanceof-fails-tag-ok' : (report.inst ? 'instanceof-ok' : 'not-imagedata')};
});

await step('dig: plain {data,width,height} after worker transfer', async () => {
  const pixels = {data: new Uint8ClampedArray(px2d), width: 300, height: 200};
  const report = await new Promise((resolve, reject) => {
    const src = `
      self.onmessage = (ev) => {
        const v = ev.data;
        self.postMessage({
          isPlain: !!v && typeof v === 'object' && !Array.isArray(v),
          dataView: ArrayBuffer.isView(v?.data),
          dataLen: v?.data?.length ?? null,
          width: v?.width, height: v?.height,
          detached: v?.data?.buffer?.byteLength === 0,
        });
      };
    `;
    const w = new Worker(URL.createObjectURL(new Blob([src], {type: 'text/javascript'})));
    const t = setTimeout(() => { w.terminate(); reject(new Error('worker dig timeout')); }, 10000);
    w.onmessage = (ev) => { clearTimeout(t); w.terminate(); resolve(ev.data); };
    w.onerror = (e) => { clearTimeout(t); w.terminate(); reject(e.error || e.message); };
    w.postMessage(pixels, [pixels.data.buffer]);
  });
  return {pass: report.dataView === true && report.width === 300, ...report};
});

// --- Dual: 2D in-page + createCodec ---
for (const pkg of ['8.2.0', 'candidate']) {
  await step(`2D canvas, in page [${pkg}]`, async () => {
    if (!px2d) throw new Error('skipped: no px2d');
    const capture = await pkgs[pkg].capture();
    const decode = await pkgs[pkg].decode();
    const page2d = await capture(c2);
    return {pass: same((await decode(page2d)).data, px2d), bytes: page2d.length, pkg};
  });
  await step(`2D canvas, through createCodec [${pkg}]`, async () => {
    const b = await viaCodec(pkg, pkgs[pkg].captureModule, c2);
    return {pass: b instanceof Uint8Array && b.length > 0, bytes: b?.length, pkg};
  });
}

// --- Dual: WebGL ---
const glCanvas = document.createElement('canvas'); glCanvas.width = 256; glCanvas.height = 160;
attach(glCanvas);
await rAF();
const gl = glCanvas.getContext('webgl', {preserveDrawingBuffer: true});
if (!gl) steps.push({name: 'WebGL canvas', pass: true, skipped: 'no WebGL'});
else {
  gl.enable(gl.SCISSOR_TEST);
  for (let i = 0; i < 8; i++) { gl.scissor(i * 32, 0, 32, 160 - i * 12); gl.clearColor(i / 8, 1 - i / 8, (i * 3 % 8) / 8, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
  let flipped = null;
  await step('WebGL canvas, readPixels', async () => {
    const raw = new Uint8Array(256 * 160 * 4);
    flipped = new Uint8Array(raw.length);
    gl.readPixels(0, 0, 256, 160, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    for (let y = 0; y < 160; y++) flipped.set(raw.subarray((159 - y) * 1024, (160 - y) * 1024), y * 1024);
    return {pass: flipped.length === 256 * 160 * 4, bytes: flipped.length};
  });
  for (const pkg of ['8.2.0', 'candidate']) {
    await step(`WebGL canvas, in page [${pkg}]`, async () => {
      if (!flipped) throw new Error('skipped: no flipped');
      const capture = await pkgs[pkg].capture();
      const decode = await pkgs[pkg].decode();
      const pageGl = await capture(glCanvas);
      let match = false, refuse = false;
      try { match = same((await decode(pageGl)).data, flipped); } catch (e) { refuse = true; throw e; }
      return {pass: match, bytes: pageGl.length, pkg, blank26: pageGl.length === 26};
    });
    await step(`WebGL canvas, through createCodec [${pkg}]`, async () => {
      const b = await viaCodec(pkg, pkgs[pkg].captureModule, glCanvas);
      return {pass: b instanceof Uint8Array && b.length > 0 && b.length !== 26, bytes: b?.length, pkg};
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
for (const pkg of ['8.2.0', 'candidate']) {
  await step(`capture-complete q80, page = worker [${pkg}]`, async () => {
    const capturePhoto = await pkgs[pkg].capturePhoto();
    const decode = await pkgs[pkg].decode();
    const a = await capturePhoto(big, {fidelity: {quality: 80}});
    const b = await viaCodec(pkg, pkgs[pkg].captureCompleteModule, big, {fidelity: {quality: 80}});
    const exact = await capturePhoto(big);
    const ref = bg.getImageData(0, 0, 640, 400).data;
    return {pass: same(a, b) && a.length < exact.length && same((await decode(exact)).data, ref), bytes: a.length, exactBytes: exact.length, pkg, q80EqExact: a.length === exact.length};
  });
  await step(`encode(canvas) [${pkg}]`, async () => {
    const encode = await pkgs[pkg].encode();
    const decode = await pkgs[pkg].decode();
    const b = await encode(c2);
    return {pass: b.length > 0 && (await decode(b)).width === 300, bytes: b.length, pkg};
  });
}
window.__result = {done: true, at: 'done', userAgent: navigator.userAgent, platform, steps};
document.getElementById('state').textContent = 'done';
