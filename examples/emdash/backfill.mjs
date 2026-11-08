#!/usr/bin/env node
// RAPIER_SITE=https://site RAPIER_TOKEN=... node backfill.mjs [--apply]
import {pathToFileURL} from 'node:url';
import {readAll} from 'rapier-jxl/storage';
import {recompress} from 'rapier-jxl/jpeg';
import {digest} from './digest.mjs';

const ROUTE = '/_emdash/api/plugins/rapier-media';
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

export async function backfill({site, token, apply = false, fetch: send = fetch, onRow = () => {}, signal}) {
  const base = new URL(site);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || !token)
    throw new TypeError('Expected a site URL and token');
  const call = async (path, init = {}) => {
    const response = await send(new URL(path, base), {...init, signal, redirect: 'error', headers: {Authorization: `Bearer ${token}`,
      'X-EmDash-Request': '1', Accept: 'application/json', ...init.headers}});
    const json = await response.json().catch(() => ({}));
    if (!response.ok || json.success === false) throw new Error(json.error?.message ?? `${path}: ${response.status}`);
    return json.data ?? json;
  };
  const file = async item => {
    const response = await send(new URL(`/_emdash/api/media/file/${encodeURIComponent(item.storageKey)}`, base),
      {signal, redirect: 'error', headers: {Authorization: `Bearer ${token}`, Accept: 'image/jpeg'}});
    if (!response.ok) throw new Error(`read ${item.storageKey}: ${response.status}`);
    return readAll(response.body, {maxBytes: 256 * 1024 * 1024, signal});
  };
  const totals = {images: 0, candidates: 0, before: 0, after: 0, retained: 0, added: 0, converted: 0, kept: 0, failed: 0};
  for (let cursor; ;) {
    signal?.throwIfAborted();
    const page = await call(`/_emdash/api/media?mimeType=image%2F&limit=8${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    const {items: rows} = await call(`${ROUTE}/library`, {method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({items: page.items.map(item => ({id: item.id, key: item.storageKey, size: item.size}))})});
    for (const [i, item] of page.items.entries()) {
      totals.images++;
      const row = {id: item.id, filename: item.filename, key: item.storageKey, state: rows[i].state};
      if (row.state !== 'jpeg') { onRow(row); continue; }
      totals.candidates++;
      try {
        const bytes = await file(item), result = await recompress(bytes, {maxPixels: 24e6, signal});
        const jxl = result.fits ? result.bytes : null;
        Object.assign(row, {bytes: bytes.byteLength, jxlBytes: jxl?.byteLength ?? null});
        totals.before += bytes.byteLength;
        // Delivery bytes and retained storage are separate totals.
        totals.after += bytes.byteLength;
        totals.retained += bytes.byteLength;
        if (!jxl || jxl.byteLength >= bytes.byteLength || jxl.byteLength > MAX_REQUEST_BYTES) {
          row.result = `kept: ${result.reason?.code ?? (jxl?.byteLength >= bytes.byteLength ? 'not_smaller' : 'request_limit')}`;
          if (apply) totals.kept++;
        } else {
          if (apply) {
            const {bytes: payload, ...metadata} = result;
            const stored = await call(`${ROUTE}/attach?id=${item.id}&key=${encodeURIComponent(item.storageKey)}&source=${await digest(bytes)}`,
              {method: 'POST', body: payload, headers: {'Content-Type': 'application/octet-stream', 'x-rapier-result': JSON.stringify(metadata)}});
            row.result = stored.stored === 'sidecar' ? 'sidecar' : `kept: ${stored.reason}`;
            if (row.result === 'sidecar') { totals.converted++; totals.added += jxl.byteLength; totals.after -= bytes.byteLength - jxl.byteLength; }
            else if (row.result?.startsWith('kept')) totals.kept++;
            else totals.failed++;
          } else totals.after -= bytes.byteLength - jxl.byteLength;
        }
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        row.result = `failed: ${error.code ?? error.message}`; totals.failed++;
      }
      onRow(row);
    }
    if (!page.nextCursor) break;
    if (page.nextCursor === cursor) throw new Error('Repeated media cursor');
    cursor = page.nextCursor;
  }
  return totals;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const totals = await backfill({site: process.env.RAPIER_SITE, token: process.env.RAPIER_TOKEN,
    apply: process.argv.includes('--apply'), onRow: row => console.log(JSON.stringify(row))});
  console.log(JSON.stringify({...totals, saved: totals.before ? 1 - totals.after / totals.before : 0}));
  if (totals.failed) process.exitCode = 1;
}
