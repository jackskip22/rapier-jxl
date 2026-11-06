// SPDX-License-Identifier: MIT
// Safari lossy native-decode rows: for each Kodak .jxl, page + dedicated-worker
// createImageBitmap(Blob, image/jxl), OffscreenCanvas 8-bit readback, maxAbsDiff vs
// rapier-jxl decode({format:'uint8', colorSpace:'srgb'}). Evidence for capture margin —
// not a product fallback decoder.
import { decode } from './p/cand/package/dist/decode.mjs';

const params = new URLSearchParams(location.search);
const subset = params.get('subset') === '24' || params.get('subset') === 'true';
const logEl = document.getElementById('log');
const log = (...a) => { logEl.textContent += a.join(' ') + '\n'; console.log(...a); };

async function fetchBytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('fetch ' + url + ' ' + r.status);
  return new Uint8Array(await r.arrayBuffer());
}

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('fetch ' + url + ' ' + r.status);
  return r.json();
}

function maxAbsDiff(a, b) {
  if (a.length !== b.length) return { maxAbsDiff: 255, differingSamples: Math.max(a.length, b.length), lengthMismatch: true };
  let maxAbs = 0, diffCount = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] > b[i] ? a[i] - b[i] : b[i] - a[i];
    if (d) { diffCount++; if (d > maxAbs) maxAbs = d; }
  }
  return { maxAbsDiff: maxAbs, differingSamples: diffCount, lengthMismatch: false };
}

function callWorker(worker, payload, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('worker timeout')), timeoutMs);
    worker.onmessage = (ev) => { clearTimeout(t); resolve(ev.data); };
    worker.onerror = (ev) => { clearTimeout(t); reject(ev.error || new Error(ev.message)); };
    const bytes = payload.bytes instanceof Uint8Array ? payload.bytes.slice() : payload.bytes;
    worker.postMessage({ ...payload, bytes }, bytes?.buffer ? [bytes.buffer] : []);
  });
}

async function pageBitmapRgba(bytes) {
  const blob = new Blob([bytes], { type: 'image/jxl' });
  const t0 = performance.now();
  const bmp = await createImageBitmap(blob);
  const decodeMs = performance.now() - t0;
  // Prefer OffscreenCanvas when available (Safari page context); fall back to canvas.
  let rgba, width, height, colorSpace;
  if (typeof OffscreenCanvas === 'function') {
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
    if (!ctx) throw new Error('OffscreenCanvas 2d null');
    ctx.drawImage(bmp, 0, 0);
    const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
    rgba = new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength);
    width = bmp.width; height = bmp.height; colorSpace = img.colorSpace || null;
  } else {
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
    rgba = new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength);
    width = bmp.width; height = bmp.height; colorSpace = img.colorSpace || null;
  }
  bmp.close();
  return { ok: true, decoded: true, width, height, decodeMs, colorSpace, rgba };
}

async function oursDecode(bytes) {
  const t0 = performance.now();
  const img = await Promise.resolve(decode(bytes, { format: 'uint8', colorSpace: 'srgb' }));
  const ms = performance.now() - t0;
  const data = img.data instanceof Uint8ClampedArray
    ? new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength)
    : new Uint8Array(img.data);
  return { ok: true, width: img.width, height: img.height, decodeMs: ms, rgba: data };
}

window.__result = { done: false, at: 'start' };

async function run() {
  const report = {
    done: false,
    at: 'manifest',
    ua: navigator.userAgent,
    platform: navigator.platform,
    ts: new Date().toISOString(),
    subset,
    rows: [],
    ok: true,
  };
  window.__result = report;

  const manifest = await fetchJson('./files/manifest.json');
  const stems = subset ? manifest.subset24 : manifest.stems;
  report.stemCount = stems.length;
  report.manifestCount = manifest.count;
  report.corpus = manifest.corpus;
  log('stems', stems.length, 'subset', subset, 'ua', navigator.userAgent.slice(0, 80));

  const worker = new Worker('./workers/dedicated.js');

  for (let i = 0; i < stems.length; i++) {
    const stem = stems[i];
    report.at = stem;
    const row = { stem, decoded: false, page: null, worker: null, ours: null, pageMaxAbsDiff: null, workerMaxAbsDiff: null };
    try {
      const bytes = await fetchBytes('./files/' + stem + '.jxl');
      // ours decode first (reference) — copy so later paths keep original bytes
      try {
        row.ours = await oursDecode(bytes.slice());
      } catch (e) {
        row.ours = { ok: false, error: String(e && e.stack || e) };
      }
      // page path
      try {
        const page = await pageBitmapRgba(bytes.slice());
        row.page = { ok: page.ok, decoded: page.decoded, width: page.width, height: page.height, decodeMs: page.decodeMs, colorSpace: page.colorSpace };
        if (row.ours?.ok) {
          const m = maxAbsDiff(page.rgba, row.ours.rgba);
          row.pageMaxAbsDiff = m.maxAbsDiff;
          row.pageDifferingSamples = m.differingSamples;
          row.pageLengthMismatch = m.lengthMismatch;
        }
      } catch (e) {
        row.page = { ok: false, decoded: false, error: String(e && e.stack || e) };
      }
      // worker path (callWorker copies again before transfer)
      try {
        const w = await callWorker(worker, { id: stem, bytes: bytes.slice() });
        row.worker = { ok: !!w.ok, decoded: !!w.decoded, width: w.width, height: w.height, decodeMs: w.decodeMs, colorSpace: w.colorSpace, error: w.error || null };
        if (w.ok && w.rgba && row.ours?.ok) {
          const m = maxAbsDiff(w.rgba, row.ours.rgba);
          row.workerMaxAbsDiff = m.maxAbsDiff;
          row.workerDifferingSamples = m.differingSamples;
          row.workerLengthMismatch = m.lengthMismatch;
        }
      } catch (e) {
        row.worker = { ok: false, decoded: false, error: String(e && e.stack || e) };
      }
      row.decoded = !!(row.page?.decoded || row.worker?.decoded);
      if (!row.page?.ok || !row.worker?.ok || !row.ours?.ok) report.ok = false;
      // drop ours rgba from report (huge)
      if (row.ours) { delete row.ours.rgba; }
    } catch (e) {
      row.error = String(e && e.stack || e);
      report.ok = false;
    }
    report.rows.push(row);
    if ((i + 1) % 12 === 0 || i === stems.length - 1) {
      log(`[${i + 1}/${stems.length}] ${stem} page=${row.page?.ok} w=${row.worker?.ok} pageΔ=${row.pageMaxAbsDiff} workerΔ=${row.workerMaxAbsDiff}`);
    }
  }

  worker.terminate();
  report.done = true;
  report.at = 'done';
  // summary
  const pageOk = report.rows.filter(r => r.page?.ok).length;
  const workerOk = report.rows.filter(r => r.worker?.ok).length;
  const pageWorst = Math.max(0, ...report.rows.map(r => r.pageMaxAbsDiff ?? -1).filter(n => n >= 0));
  const workerWorst = Math.max(0, ...report.rows.map(r => r.workerMaxAbsDiff ?? -1).filter(n => n >= 0));
  report.summary = { pageOk, workerOk, total: stems.length, pageWorstMaxAbsDiff: pageOk ? pageWorst : null, workerWorstMaxAbsDiff: workerOk ? workerWorst : null };
  window.__result = report;
  document.getElementById('state').textContent = 'done';
  document.title = 'LOSSY_ROWS_DONE';
  log('DONE', JSON.stringify(report.summary));
  if (params.get('smoke') === '1') {
    try {
      await fetch('/results', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report) });
    } catch (e) { log('smoke post failed', String(e)); }
  }
}

run().catch((e) => {
  log('FATAL', String(e && e.stack || e));
  window.__result = { done: true, ok: false, fatal: String(e && e.stack || e), ua: navigator.userAgent, rows: [] };
  document.getElementById('state').textContent = 'fail';
  document.title = 'LOSSY_ROWS_FAIL';
  if (new URLSearchParams(location.search).get('smoke') === '1') {
    fetch('/results', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(window.__result) }).catch(() => {});
  }
});
