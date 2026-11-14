// SPDX-License-Identifier: MIT
// createCodec / worker routes: which value reaches the worker, and whether it can be read there.
// A: a plain harness worker (no rapier-jxl), module and blob: URL, given ImageBitmap (transferred, cloned), ImageData and
//    a {data, width, height} record. B: rapier-jxl's own worker file behind a shim (workerFactory) whose first listener
//    reports each job's input shape on a BroadcastChannel; the product code is unchanged. C: the default worker.
// Heartbeat: window.__result after every step (done:true at end).
import {shape, brief} from './shape.mjs';
const pkg = document.documentElement.dataset.pkg;
// 8.3 returns a result record; 8.2.0 returned the bytes. Rows compare bytes.
const B = r => (r && r.bytes instanceof Uint8Array) ? r.bytes : r;
const W = f => f && (async (...a) => B(await f(...a)));
const _m = await import('rapier-jxl');
const capture = W(_m.capture ?? (await import('rapier-jxl/capture')).capture);
const {createCodec} = await import('rapier-jxl/codec');
const steps = [], probes = [];
const beat = at => { window.__result = {done: false, at, pkg, userAgent: navigator.userAgent, steps: steps.slice(), probes: probes.slice()}; document.getElementById('state').textContent = at; };
const timeout = (p, ms, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`timeout ${ms} ms: ${what}`)), ms))]);
const step = async (name, f) => {
  beat('before:' + name);
  try { steps.push({name, ...await timeout(f(), 60000, name)}); }
  catch (e) { steps.push({name, pass: false, error: String(e?.message || e).slice(0, 240), code: e?.code, stack: String(e?.stack || '').split('\n').slice(0, 4).join(' | ').slice(0, 400)}); }
  beat('after:' + name);
};
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const rAF = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

// The picture: a 160x100 WRF canvas, attached and shown; pixel (0,0) is rgb(200,100,50).
const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 100;
canvas.style.cssText = 'display:block;width:160px;height:100px;'; document.getElementById('host').appendChild(canvas);
const g = canvas.getContext('2d', {colorSpace: 'srgb', willReadFrequently: true});
[[200, 100, 50], [40, 160, 90], [90, 80, 220], [250, 250, 250], [128, 128, 128], [230, 30, 40]].forEach(([r, gr, b], i) => { g.fillStyle = `rgb(${r},${gr},${b})`; g.fillRect(i * 27, 0, 27, 100); });
await rAF();
// The same picture on a bare canvas (plain getContext('2d'), as SnapDOM's toCanvas hands it over).
const bare = document.createElement('canvas'); bare.width = 160; bare.height = 100;
bare.style.cssText = 'display:block;width:160px;height:100px;'; document.getElementById('host').appendChild(bare);
bare.getContext('2d').drawImage(canvas, 0, 0);
await rAF();
const imageData = () => g.getImageData(0, 0, 160, 100);
const record = () => { const d = imageData(); return {data: new Uint8Array(d.data), width: 160, height: 100}; };
beat('start');

let reference = null;
await step('page: capture(canvas) reference', async () => { reference = await capture(canvas); return {pass: reference.length > 0, bytes: reference.length, shape: brief(shape(canvas))}; });
await step('page: createImageBitmap(canvas) shape', async () => { const b = await createImageBitmap(canvas); const s = brief(shape(b)); b.close(); return {pass: true, shape: s}; });

// --- A: plain harness workers ---
const plainWorker = kind => kind === 'module' ? new Worker('./probe-worker.mjs', {type: 'module'})
  : new Worker(URL.createObjectURL(new Blob([`import ${JSON.stringify(new URL('./probe-worker.mjs', location.href).href)};`], {type: 'text/javascript'})), {type: 'module'});
for (const kind of ['module', 'blob']) {
  let w = null, realm = null;
  await step(`plain ${kind} worker: start`, async () => {
    w = plainWorker(kind);
    realm = await new Promise((yes, no) => { w.onerror = e => no(new Error('worker error: ' + (e.message || 'load failed'))); w.onmessage = e => e.data?.ready && yes(e.data.realm); });
    return {pass: true, shape: JSON.stringify(realm)};
  });
  const ask = (tag, value, transfer = []) => new Promise((yes, no) => { w.onmessage = e => e.data?.tag === tag && yes(e.data); w.onerror = e => no(new Error('worker error: ' + e.message)); w.postMessage({tag, value}, transfer); });
  const row = (name, make, transfer) => step(`plain ${kind} worker: ${name}`, async () => {
    if (!w) throw new Error('skipped: worker did not start');
    const value = await make(), r = await ask(name, value, transfer ? [value] : []);
    return {pass: !!r.read?.ok && r.read.first?.[0] === 200, shape: brief(r.shape), read: r.read?.ok ? `${r.read.via} ${r.read.first}` : r.read?.error, error: r.read?.ok ? undefined : r.read?.error};
  });
  await row('ImageBitmap transferred', () => createImageBitmap(canvas), true);
  await row('ImageBitmap cloned', () => createImageBitmap(canvas), false);
  await row('ImageData cloned', () => imageData(), false);
  await row('record {data,width,height} cloned', () => record(), false);
  w?.terminate();
}

// --- B: rapier-jxl's worker file behind the probe shim ---
const channel = new BroadcastChannel('rapier-jxl-probe');
channel.onmessage = e => probes.push(e.data);
const viaShim = async (module, input, options) => {
  const file = `./shim-${pkg}-${module.replace('rapier-jxl/', '')}.mjs`, from = probes.length;
  const q = createCodec({module, workerFactory: () => new Worker(file, {type: 'module', name: module + ' worker'})});
  let bytes, error;
  try { bytes = B(await q.capture(input, options)); } catch (e) { error = e; } finally { await q.close().catch(() => {}); }
  await new Promise(r => setTimeout(r, 300));
  const jobs = probes.slice(from).filter(p => p.kind === 'job'), boot = probes.slice(from).find(p => p.kind === 'boot');
  return {bytes, error, arrived: jobs.map(j => `${j.operation}: ${brief(j.input)} opts=[${j.options}]`).join(' ; ') || (boot ? 'no job message' : 'shim did not boot'), realm: boot?.realm};
};
const shimRow = (name, module, make, options) => step(`codec+probe ${module.replace('rapier-jxl/', '')}: ${name}`, async () => {
  const r = await viaShim(module, await make(), options);
  if (r.error) return {pass: false, code: r.error.code, error: String(r.error.message || r.error).slice(0, 200), arrived: r.arrived, shape: r.arrived};
  return {pass: module !== 'rapier-jxl/capture' || !reference || same(r.bytes, reference), bytes: r.bytes.length, arrived: r.arrived, shape: r.arrived};
});
await shimRow('capture(WRF canvas)', 'rapier-jxl/capture', () => canvas);
await shimRow('capture(bare canvas)', 'rapier-jxl/capture', () => bare);
await shimRow('capture(ImageBitmap)', 'rapier-jxl/capture', () => createImageBitmap(canvas));
await shimRow('capture(ImageData)', 'rapier-jxl/capture', () => imageData());
await shimRow('capture({data,width,height})', 'rapier-jxl/capture', () => record());
await shimRow('capture(WRF canvas) q80', 'rapier-jxl/capture-complete', () => canvas, {fidelity: {quality: 80}});

// --- C: the default worker (what a SnapDOM plug-in gets) ---
const viaDefault = async (input, module = 'rapier-jxl/capture') => { const q = createCodec({module}); try { return B(await q.capture(input)); } finally { await q.close(); } };
for (const [name, make] of [['WRF canvas', () => canvas], ['bare canvas', () => bare], ['ImageBitmap', () => createImageBitmap(canvas)], ['ImageData', () => imageData()], ['{data,width,height}', () => record()]])
  await step(`codec default capture: ${name}`, async () => { const b = await viaDefault(await make()); return {pass: !reference || same(b, reference), bytes: b.length}; });

channel.close();
window.__result = {done: true, at: 'done', pkg, userAgent: navigator.userAgent, steps, probes};
document.getElementById('state').textContent = 'done';
