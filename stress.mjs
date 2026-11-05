// SPDX-License-Identifier: MIT
// Stress: an intermittent "Out of bounds memory access" in the decoder's kernels in WebKit. Repeats the
// consumer's decode-region-partial and encode-exact-roundtrip rows (?n=200 times) in one page; records every failure's
// message and stack (which kernel), the iteration, and whether results stay exact.
const {encode} = await import('rapier-jxl');
const {decode} = await import('rapier-jxl/decode');
const n = Number(new URLSearchParams(location.search).get('n') || 200);
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const photoLike = (w, h) => { const d = new Uint8Array(w * h * 4); let s = 1;
  for (let i = 0; i < w * h; i++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; const x = i % w, y = (i / w) | 0, k = (s >>> 24) & 31;
    d.set([(x / w * 200 + k) | 0, (y / h * 200 + k) | 0, (128 + Math.sin(x / 17) * 40 + k) | 0, 255], i * 4); } return {data: d, width: w, height: h}; };
const grad = (w, h) => { const d = new Uint8Array(w * h * 4); for (let i = 0; i < w * h; i++) { const x = i % w, y = (i / w) | 0;
  d[i * 4] = (x * 255 / w) | 0; d[i * 4 + 1] = (y * 255 / h) | 0; d[i * 4 + 2] = ((x ^ y) & 63) * 4; d[i * 4 + 3] = 255; } return {data: d, width: w, height: h}; };
const p = photoLike(512, 384), lossy = await encode(p, {fidelity: {quality: 90}}), whole = await decode(lossy);
const g = grad(200, 150), region = {x: 100, y: 60, width: 200, height: 150};
const failures = [], counts = {region: 0, partial: 0, whole: 0, exact: 0};
const beat = (at) => { window.__result = {done: false, at, pkg: document.documentElement.dataset.pkg, userAgent: navigator.userAgent, n, counts: {...counts}, failureCount: failures.length, steps: [{name: `decoder stress x${n}`, pass: false, error: 'in progress'}]}; document.getElementById('state').textContent = at; };
const t0 = performance.now();
beat('start');
for (let i = 0; i < n; i++) {
  const step = async (name, f) => { try { if (!await f()) failures.push({i, name, wrong: true}); else counts[name]++; } catch (e) { failures.push({i, name, error: String(e?.message || e).slice(0, 160), code: e?.code, stack: String(e?.stack || '').split('\n').slice(0, 6).join(' | ').slice(0, 600)}); } };
  await step('whole', async () => same((await decode(lossy)).data, whole.data));
  await step('region', async () => {
    const r = await decode(lossy, {region}); if (r.width !== 200 || r.height !== 150) return false;
    const ch = [0, 0, 0, 0]; for (let y = 0; y < 150; y++) for (let x = 0; x < 200; x++) for (let k = 0; k < 4; k++) if (r.data[(y * 200 + x) * 4 + k] !== whole.data[((y + 60) * 512 + 100 + x) * 4 + k]) ch[k]++;
    if (ch.some(Boolean)) throw new Error('region pixels differ from the whole decode, RGBA ' + ch.join('/'));
    return true;
  });
  await step('partial', async () => { const r = await decode(lossy.subarray(0, Math.floor(lossy.length * 0.6)), {partial: true}); return r.width === 64 && !!r.partial; });
  await step('exact', async () => { const b = await encode(g, {fidelity: 'exact'}); return same((await decode(b)).data, g.data); });
  if (i % 20 === 19) beat(`${i + 1}/${n}`);
}
window.__result = {done: true, at: 'done', pkg: document.documentElement.dataset.pkg, userAgent: navigator.userAgent, n, ms: Math.round(performance.now() - t0), counts, failures: failures.slice(0, 40), failureCount: failures.length,
  steps: [{name: `decoder stress x${n}`, pass: failures.length === 0, bytes: failures.length}]};
document.getElementById('state').textContent = 'done';
