#!/usr/bin/env node
// RAPIER_SITE=https://site RAPIER_TOKEN=... node backfill.mjs [--apply] [--page-size=64] [--concurrency=4] [--effort=7] [--cursor=...]
import {pathToFileURL} from 'node:url';
import {readAll} from './read-all.mjs';
import {recompress} from 'jpegxl/jpeg';
import {digest} from './digest.mjs';

const ROUTE = '/_emdash/api/plugins/rapier-media';
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const LIBRARY_BATCH = 8;

function boundedInt(name, value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new RangeError(`${name}: integer ${min}-${max}`);
  return value;
}

export async function backfill({site, token, apply = false, fetch: send = fetch, onRow = () => {}, onPage = () => {},
  cursor: initialCursor, pageSize = LIBRARY_BATCH, concurrency = 1, effort, signal, maxPixels}) {
  const base = new URL(site);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || !token)
    throw new TypeError('site: URL and token');
  boundedInt('pageSize', pageSize, 1, 100);
  boundedInt('concurrency', concurrency, 1, 16);
  if (effort !== undefined) boundedInt('effort', effort, 1, 9);
  if (initialCursor !== undefined && (typeof initialCursor !== 'string' || !initialCursor.length))
    throw new TypeError('cursor: nonempty string');
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
  const libraryStates = async items => {
    if (!items.length) return [];
    const chunks = [];
    for (let offset = 0; offset < items.length; offset += LIBRARY_BATCH)
      chunks.push(items.slice(offset, offset + LIBRARY_BATCH));
    const batches = new Array(chunks.length);
    let nextBatch = 0;
    const batchWorker = async () => {
      while (nextBatch < chunks.length) {
        signal?.throwIfAborted();
        const index = nextBatch++;
        const {items: rows} = await call(`${ROUTE}/library`, {method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({items: chunks[index].map(item => ({id: item.id, key: item.storageKey, size: item.size}))})});
        batches[index] = rows;
      }
    };
    await Promise.all(Array.from({length: Math.min(concurrency, chunks.length)}, batchWorker));
    return batches.flat();
  };
  const codecOptions = {signal, ...(maxPixels !== undefined && {maxPixels}), ...(effort !== undefined && {effort})};
  const totals = {images: 0, candidates: 0, before: 0, after: 0, retained: 0, added: 0, converted: 0, kept: 0, failed: 0, checked: 0, stale: 0};
  for (let cursor = initialCursor; ;) {
    signal?.throwIfAborted();
    const page = await call(`/_emdash/api/media?mimeType=image%2F&limit=${pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    const rows = await libraryStates(page.items);
    const slots = new Array(page.items.length);
    let nextIndex = 0, nextEmit = 0;
    const flush = () => {
      while (nextEmit < slots.length && slots[nextEmit] && !signal?.aborted) {
        const entry = slots[nextEmit++];
        for (const [k, v] of Object.entries(entry.delta)) totals[k] += v;
        onRow(entry.row);
      }
    };
    const processOne = async index => {
      const item = page.items[index];
      const delta = {images: 1, candidates: 0, before: 0, after: 0, retained: 0, added: 0, converted: 0, kept: 0, failed: 0, checked: 0, stale: 0};
      const row = {id: item.id, filename: item.filename, key: item.storageKey, state: rows[index].state};
      // Ruling 91: a copy made before its color was recorded is checked once (headers only); a copy whose color differs
      // from its source's is stale, and its picture is a candidate again. A dry run writes nothing, so it checks nothing.
      if (apply && row.state === 'sidecar' && rows[index].color === 'unchecked') {
        try {
          const check = await call(`${ROUTE}/color-check`, {method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({key: item.storageKey})});
          delta.checked += check.checked; delta.stale += check.differs;
          if (check.differs) row.state = 'jpeg';
        } catch (error) {
          if (signal?.aborted) throw signal.reason;
          row.result = `failed: ${error.code ?? error.message}`; delta.failed++;
          slots[index] = {row, delta}; flush(); return;
        }
      }
      if (row.state !== 'jpeg' || !/\.(?:jpe?g|jpe|jfif)$/i.test(item.storageKey ?? '')) {
        slots[index] = {row, delta}; flush(); return;
      }
      delta.candidates++;
      try {
        const bytes = await file(item), result = await recompress(bytes, codecOptions);
        const jxl = result.meetsTarget ? result.bytes : null;
        Object.assign(row, {bytes: bytes.byteLength, jxlBytes: jxl?.byteLength ?? null});
        delta.before += bytes.byteLength;
        // Delivery bytes and retained storage are separate totals.
        delta.after += bytes.byteLength;
        delta.retained += bytes.byteLength;
        if (!jxl || jxl.byteLength >= bytes.byteLength || jxl.byteLength > MAX_REQUEST_BYTES) {
          row.result = `kept: ${result.reason?.code ?? (jxl?.byteLength >= bytes.byteLength ? 'not_smaller' : 'request_limit')}`;
          if (apply) delta.kept++;
        } else if (apply) {
          const {bytes: payload, ...metadata} = result;
          const stored = await call(`${ROUTE}/attach?id=${item.id}&key=${encodeURIComponent(item.storageKey)}&source=${await digest(bytes)}`,
            {method: 'POST', body: payload, headers: {'Content-Type': 'application/octet-stream', 'x-rapier-result': JSON.stringify(metadata)}});
          row.result = stored.stored === 'sidecar' ? 'sidecar' : `kept: ${stored.reason}`;
          if (row.result === 'sidecar') { delta.converted++; delta.added += jxl.byteLength; delta.after -= bytes.byteLength - jxl.byteLength; }
          else if (row.result?.startsWith('kept')) delta.kept++;
          else delta.failed++;
        } else delta.after -= bytes.byteLength - jxl.byteLength;
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        row.result = `failed: ${error.code ?? error.message}`; delta.failed++;
      }
      slots[index] = {row, delta}; flush();
    };
    const itemWorker = async () => {
      while (nextIndex < page.items.length && !signal?.aborted) {
        const index = nextIndex++;
        await processOne(index);
      }
    };
    if (page.items.length)
      await Promise.all(Array.from({length: Math.min(concurrency, page.items.length)}, itemWorker));
    signal?.throwIfAborted();
    onPage({cursor: cursor ?? null, nextCursor: page.nextCursor ?? null, items: page.items.length});
    if (!page.nextCursor) break;
    if (page.nextCursor === cursor) throw new Error('media cursor: repeated');
    cursor = page.nextCursor;
  }
  return totals;
}

function flagValue(args, prefix) {
  const found = args.find(arg => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const pageSize = flagValue(args, '--page-size=');
  const concurrency = flagValue(args, '--concurrency=');
  const effort = flagValue(args, '--effort=');
  const cursor = flagValue(args, '--cursor=');
  const totals = await backfill({
    site: process.env.RAPIER_SITE, token: process.env.RAPIER_TOKEN,
    apply: args.includes('--apply'),
    ...(pageSize !== undefined && {pageSize: Number(pageSize)}),
    ...(concurrency !== undefined && {concurrency: Number(concurrency)}),
    ...(effort !== undefined && {effort: Number(effort)}),
    ...(cursor !== undefined && {cursor}),
    onRow: row => console.log(JSON.stringify(row)),
  });
  console.log(JSON.stringify({...totals, saved: totals.before ? 1 - totals.after / totals.before : 0}));
  if (totals.failed) process.exitCode = 1;
}
