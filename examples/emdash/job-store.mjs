// SPDX-License-Identifier: MIT
export const EMDASH_JOB_STORAGE = Object.freeze({jxlParts: Object.freeze({indexes: Object.freeze([])})});
// EmDash's own limit is 1 MiB of JSON a stored value, none a read; a batch is the driver's 128 parts and 8 MiB.
const MAX_PART = 1024 * 1024, MAX_BATCH = 8 * MAX_PART, FRAGMENT = Math.floor((MAX_PART - 2) / 4) * 3;
const HASH = /^[a-f0-9]{64}$/;
const fail = (code, message) => Object.assign(new Error(message), {code});

// Native processing shares the site's server process. The sandbox's ten-subrequest quota is not a native limit.
export function createEmDashCallCounter() {
  let used = 0;
  return {get used() { return used; },
    async call(action) {
      used++;
      return action();
    }};
}

// A job's parts are named by its own ID and their SHA-256, so a job deletes only what it wrote: `jxl:<job>:<hash>:<n>`.
// A browser candidate is staged under its own job ID too: no part is shared, and no reference is counted.
const OWNER = /^[a-f0-9]{32}$/;
// A write admitted before a job ended is certainly dead after a request's longest life; until then its parts are awaited.
// Wall-time horizon, not a fence: a write admitted and still unfinished this long after it began is presumed dead.
const WRITE_HORIZON_MS = 24 * 60 * 60 * 1000;
function fragments(ref, owner) {
  if (!HASH.test(ref?.hash ?? '') || !Number.isSafeInteger(ref.length) || ref.length < 0 || ref.length > MAX_PART)
    throw fail('JXL_INPUT', 'Expected an immutable part of at most 1 MiB.');
  return Array.from({length: Math.max(1, Math.ceil(ref.length / FRAGMENT))}, (_, index) => ({
    key: `jxl:${owner}:${ref.hash}:${index}`, offset: index * FRAGMENT,
    length: Math.min(FRAGMENT, ref.length - index * FRAGMENT),
  }));
}
// The runtime's own base64 where it has one; else a table, seven times faster than btoa over fromCharCode on a part.
const ALPHABET = new TextEncoder().encode('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'), ascii = new TextDecoder('latin1');
const base64 = bytes => {
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  const n = bytes.length, out = new Uint8Array(4 * Math.ceil(n / 3));
  let o = 0, i = 0;
  for (; i + 2 < n; i += 3) {
    const v = bytes[i] << 16 | bytes[i + 1] << 8 | bytes[i + 2];
    out[o++] = ALPHABET[v >> 18]; out[o++] = ALPHABET[v >> 12 & 63]; out[o++] = ALPHABET[v >> 6 & 63]; out[o++] = ALPHABET[v & 63];
  }
  if (i < n) {
    const v = bytes[i] << 16 | (i + 1 < n ? bytes[i + 1] << 8 : 0);
    out[o++] = ALPHABET[v >> 18]; out[o++] = ALPHABET[v >> 12 & 63]; out[o++] = i + 1 < n ? ALPHABET[v >> 6 & 63] : 61; out[o++] = 61;
  }
  return ascii.decode(out);
};

// Only the JSON transport splits a part. The shared driver owns all source pages and journal records.
const randomHex = () => [...crypto.getRandomValues(new Uint8Array(8))].map(byte => byte.toString(16).padStart(2, '0')).join('');
export function createEmDashJobStore(ctx, {readSource, calls = createEmDashCallCounter(), owner, now = () => Date.now()} = {}) {
  if (!OWNER.test(owner ?? '')) throw fail('JXL_OPTIONS', 'Expected the job ID that owns these parts.');
  const parts = ctx?.storage?.jxlParts;
  if (typeof parts?.getMany !== 'function' || typeof parts?.putMany !== 'function' || typeof readSource !== 'function')
    throw fail('JXL_OPTIONS', 'Expected EmDash jxlParts storage and an immutable source reader.');
  const cache = new Map();
  async function readMany(refs) {
    if (!Array.isArray(refs) || refs.length > 128 || refs.reduce((n, ref) => n + ref.length, 0) > MAX_BATCH)
      throw fail('JXL_LIMIT', 'Read at most 128 parts and 8 MiB per batch.');
    const groups = refs.map(ref => fragments(ref, owner)), keys = [...new Set(groups.flat().map(part => part.key))].filter(key => !cache.has(key));
    if (keys.length) {
      const found = await calls.call(() => parts.getMany(keys));
      if (!(found instanceof Map)) throw fail('JXL_IO', 'EmDash returned an invalid part batch.');
      for (const key of keys) cache.set(key, found.get(key));
    }
    return refs.map((ref, index) => {
      const bytes = new Uint8Array(ref.length);
      for (const part of groups[index]) {
        const saved = cache.get(part.key);
        if (typeof saved !== 'string' || saved.length !== 4 * Math.ceil(part.length / 3))
          throw fail('JXL_IO', 'An immutable part is missing or truncated.');
        // The runtime's own decoder where it has one (setFromBase64: strict, written in place, about a tenth of the
        // time of atob and a loop over its string); else atob.
        if (typeof bytes.setFromBase64 === 'function') {
          let done;
          try { done = bytes.subarray(part.offset, part.offset + part.length).setFromBase64(saved, {lastChunkHandling: 'strict'}); }
          catch { throw fail('JXL_IO', 'An immutable part is not base64 data.'); }
          if (done.read !== saved.length || done.written !== part.length) throw fail('JXL_IO', 'An immutable part has the wrong length.');
          continue;
        }
        let text;
        try { text = atob(saved); } catch { throw fail('JXL_IO', 'An immutable part is not base64 data.'); }
        if (text.length !== part.length) throw fail('JXL_IO', 'An immutable part has the wrong length.');
        for (let i = 0; i < text.length; i++) bytes[part.offset + i] = text.charCodeAt(i);
      }
      return bytes;
    });
  }
  // Parts are named by their SHA-256 and the driver checks each one it reads, so a write is an idempotent upsert:
  // one putMany for a call's new parts, at most 128 rows and 8 MiB of JSON a batch.
  async function writeMany(items) {
    const rows = [], named = new Set();
    for (const {ref, bytes} of items) {
      const pieces = fragments(ref, owner);
      if (!(bytes instanceof Uint8Array) || bytes.length !== ref.length) throw fail('JXL_INPUT', 'Part length differs from its bytes.');
      for (const part of pieces) {
        if (cache.has(part.key) || named.has(part.key)) continue;
        named.add(part.key);
        rows.push({id: part.key, data: base64(bytes.subarray(part.offset, part.offset + part.length))});
      }
    }
    const token = cleaning ? randomHex() : null;
    try {
    for (let at = 0; at < rows.length;) {
      let end = at, size = 0;
      while (end < rows.length && end - at < 128 && size + rows[end].data.length + 2 <= MAX_BATCH) size += rows[end++].data.length + 2;
      const batch = rows.slice(at, end);
      // The ledger names the keys before they exist, so a part can never be written that its job cannot find again.
      await ledger(batch.map(row => row.id), [], false, {admit: token});
      await calls.call(() => parts.putMany(batch));
      if (cleaning && ledgerOf(await calls.call(() => parts.getVersioned(ledgerKey))).closed) {
        const own = batch.map(row => row.id);
        await deleteKeys(own); await ledger([], own, true, {done: token}); throw closedError();
      }
      for (const row of batch) cache.set(row.id, row.data);
      at = end;
    }
    } finally {
      // Each admitted write has its own entry; clear() waits for it. A lost release only costs a wait up to the horizon.
      if (token) await ledger([], [], true, {done: token}).catch(() => {});
    }
  }
  // One row lists every key the job holds: {closed, keys}. Closing it (by compare-and-set, with the revision read) ends
  // the job's right to write; a write that was admitted before the close deletes its own parts when it sees the close.
  const cleaning = typeof parts.deleteMany === 'function' && typeof parts.getVersioned === 'function' &&
    typeof parts.compareAndSet === 'function';
  const ledgerKey = `jxl:led:${owner}`;
  const closedError = () => fail('JXL_IO', 'This job has ended; its parts are no longer kept.');
  const ledgerOf = row => ({closed: row?.value?.closed === true, keys: Array.isArray(row?.value?.keys) ? row.value.keys : [],
    at: Number.isFinite(row?.value?.at) ? row.value.at : 0,
    pending: row?.value?.pending && typeof row.value.pending === 'object' ? {...row.value.pending} : {}});
  const valueOf = (held, keys, pending, closed = held.closed, at = held.at) =>
    ({...(closed ? {closed: true, at} : {closed: false}), keys: [...keys], ...(Object.keys(pending).length ? {pending} : {})});
  async function ledger(add, remove, closedOk = false, writer = {}) {
    if (!cleaning) return;
    for (let attempt = 0; attempt < 8; attempt++) {
      const row = await calls.call(() => parts.getVersioned(ledgerKey)), held = ledgerOf(row);
      if (held.closed && !closedOk) throw closedError();
      const keys = new Set(held.keys), pending = {...held.pending};
      for (const key of add) keys.add(key);
      for (const key of remove) keys.delete(key);
      if (writer.admit) pending[writer.admit] = pending[writer.admit] ?? now();
      if (writer.done) delete pending[writer.done];
      if (row && keys.size === held.keys.length && !add.length && Object.keys(pending).length === Object.keys(held.pending).length) return;
      const saved = await calls.call(() => parts.compareAndSet(ledgerKey, row?.revision ?? null, valueOf(held, keys, pending)));
      if (saved?.applied === true) return;
      if (saved?.applied !== false) throw fail('JXL_IO', 'The part ledger write was not acknowledged.');
    }
    throw fail('JXL_IO', 'The part ledger changed too often.');
  }
  async function deleteKeys(keys) {
    let deleted = 0;
    for (let at = 0; at < keys.length; at += 128) {
      const batch = keys.slice(at, at + 128);
      deleted += Number(await calls.call(() => parts.deleteMany(batch))) || 0;
      for (const key of batch) cache.delete(key);
    }
    return deleted;
  }
  return {
    readSource,
    // Parts the saved checkpoint no longer reaches. Call after the host has kept that checkpoint.
    async release(refs) {
      if (!cleaning || !Array.isArray(refs) || !refs.length) return 0;
      const keys = [...new Set(refs.flatMap(ref => fragments(ref, owner).map(part => part.key)))];
      await deleteKeys(keys); await ledger([], keys);
      return keys.length;
    },
    // Everything the job wrote, once it is done, canceled or failed: close the ledger (stamping the time), then delete every
    // key it names. A write admitted before the close that has not committed yet leaves its key absent: clear() then
    // throws JXL_BUSY and keeps the names, so the job's work row stays until that write commits (and the next clear()
    // deletes it) or the 24-hour horizon passes (wall time, not a fence). A clean pass drops the names. Repeating clear() is always safe.
    async clear() {
      if (!cleaning) return 0;
      for (let attempt = 0; attempt < 8; attempt++) {
        const row = await calls.call(() => parts.getVersioned(ledgerKey)), held = ledgerOf(row);
        let revision = row?.revision ?? null, closedAt = held.at;
        if (!held.closed) {
          closedAt = now();
          const saved = await calls.call(() => parts.compareAndSet(ledgerKey, revision, valueOf(held, held.keys, held.pending, true, closedAt)));
          if (saved?.applied === false) continue;
          if (saved?.applied !== true) throw fail('JXL_IO', 'The part ledger close was not acknowledged.');
          revision = saved.revision;
        }
        const keys = held.keys.filter(key => typeof key === 'string' && key.startsWith(`jxl:${owner}:`));
        const deleted = await deleteKeys(keys), absent = keys.length - deleted;
        const live = Object.values(held.pending).filter(at => Number.isFinite(at) && now() - at < WRITE_HORIZON_MS).length;
        if ((absent > 0 && now() - closedAt < WRITE_HORIZON_MS) || live > 0)
          throw fail('JXL_BUSY', 'A write admitted before this job ended may still commit; its parts are reclaimed on a later wake.');
        if (keys.length || Object.keys(held.pending).length)
          await calls.call(() => parts.compareAndSet(ledgerKey, revision, valueOf(held, [], {}, true, closedAt)));
        return deleted;
      }
      throw fail('JXL_IO', 'The part ledger changed too often.');
    },
    read: async ref => (await readMany([ref]))[0],
    readMany,
    writeMany,
    write: (ref, bytes) => writeMany([{ref, bytes}]),
  };
}

