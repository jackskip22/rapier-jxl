// SPDX-License-Identifier: MIT
import {check, dimensions, fail, blobBytes} from './primitives.mjs';

const SETS = /*#__PURE__*/ (() => ({
  b: new Set('heic heix hevc hevx heim heis hevm hevs mif1 msf1 avif avis'.split(' ')),
  s: new Set('hevc hevx heim hevm msf1 avis'.split(' ')),
}))();
const MAX_META_BYTES = 64 * 1024 * 1024;
const bad = message => fail('JXL_INPUT', `phone ${message}`);
const no = message => fail('JXL_UNSUPPORTED', `phone ${message}`);
const txt = (b, a, n = 4) => String.fromCharCode(...b.subarray(a, a + n));

function rdr(b, at = 0) {
  const take = n => { if (!Number.isSafeInteger(n) || n < 0 || at + n > b.length) throw bad('image: incomplete'); const s = b.subarray(at, at + n); at += n; return s; };
  const u = n => { if (n > 8) throw no('item offset: unsupported; use host pixels'); let v = 0; for (const x of take(n)) v = v * 256 + x; if (!Number.isSafeInteger(v)) throw bad('item offset: too large'); return v; };
  return {
    get at() { return at; }, take, u,
    str() { const s = at; while (at < b.length && b[at]) { if (at - s === 256) throw bad('item name: max 256 bytes'); at++; } take(1); },
    full(vs) { const v = u(1), f = u(3); if (!vs.includes(v)) throw no('metadata version: unsupported; use host pixels'); return [v, f]; },
  };
}

function boxHdr(b, rem) {
  const r = rdr(b); let sz = r.u(4); const t = txt(r.take(4), 0);
  if (sz === 1) sz = r.u(8); else if (!sz) sz = rem;
  if (sz < r.at || sz > rem) throw bad('box extent: invalid');
  return {t, sz, h: r.at};
}
function* kids(b, at = 0) { while (at < b.length) { const bx = boxHdr(b.subarray(at, at + 16), b.length - at); yield {t: bx.t, d: b.subarray(at + bx.h, at + bx.sz)}; at += bx.sz; } }

export async function inspectPhone(blob, head, {maxPixels, signal} = {}) {
  if (head.length < 12 || txt(head, 4) !== 'ftyp') return null;
  const f0 = boxHdr(head, blob.size); if (f0.sz < f0.h + 8 || (f0.sz - f0.h) % 4) throw bad('file type box: invalid');
  const read = async (s, n) => { check(signal); const b = await blobBytes(blob, signal, s, s + n); if (b.length !== n) throw bad('image: incomplete'); return b; };
  const ftyp = await read(f0.h, f0.sz - f0.h), brands = [txt(ftyp, 0)];
  for (let a = 8; a < ftyp.length; a += 4) brands.push(txt(ftyp, a));
  if (!brands.some(x => SETS.b.has(x))) return null;
  let meta, wAt = 0, win = new Uint8Array(0); const tracks = [];
  for (let at = f0.sz; at < blob.size;) {
    const need = Math.min(16, blob.size - at);
    if (at < wAt || at + need > wAt + win.length) { wAt = at; win = await read(at, Math.min(65536, blob.size - at)); }
    const bx = boxHdr(win.subarray(at - wAt, at - wAt + need), blob.size - at);
    if (bx.t === 'meta') {
      if (meta) throw bad('metadata box: duplicate');
      if (bx.sz - bx.h > MAX_META_BYTES) throw fail('JXL_MEMORY', 'phone metadata box: exceeds 64 MiB; use host pixels');
      meta = await read(at + bx.h, bx.sz - bx.h);
    }
    if (bx.t === 'moov') tracks.push(at + 4);
    at += bx.sz;
  }
  if (!meta) return null;
  const rt = rdr(meta); rt.full([0]);
  let primary; const items = new Map(), refs = new Map(), props = [null], assoc = new Map(), locs = new Map();
  for (const {t, d} of kids(meta, rt.at)) {
    const r = rdr(d);
    if (t === 'pitm') { if (primary !== undefined) throw bad('primary item: duplicate'); const [v] = r.full([0, 1]); primary = r.u(v ? 4 : 2); }
    else if (t === 'iinf') {
      const [v] = r.full([0, 1]), cnt = r.u(v ? 4 : 2); let n = 0;
      for (const bx of kids(d, r.at)) {
        if (bx.t !== 'infe') throw bad('item info: invalid');
        const ir = rdr(bx.d), [iv] = ir.full([2, 3]), id = ir.u(iv === 2 ? 2 : 4), prot = ir.u(2), kind = txt(ir.take(4), 0); ir.str();
        if (items.has(id)) throw bad('item identifier: duplicate'); items.set(id, {kind, prot}); n++;
      }
      if (n !== cnt) throw bad('item count: mismatch');
    } else if (t === 'iref') {
      const [v] = r.full([0, 1]), sz = v ? 4 : 2;
      for (const bx of kids(d, r.at)) { const rr = rdr(bx.d), fr = rr.u(sz), cnt = rr.u(2), to = []; for (let i = 0; i < cnt; i++) to.push(rr.u(sz)); if (bx.t === 'dimg') refs.set(fr, [...(refs.get(fr) ?? []), ...to]); }
    } else if (t === 'iprp') {
      for (const bx of kids(d)) {
        if (bx.t === 'ipco') for (const p of kids(bx.d)) props.push(p);
        else if (bx.t === 'ipma') {
          const tr = rdr(bx.d), [v, fl] = tr.full([0, 1]), cnt = tr.u(4), sz = fl & 1 ? 2 : 1;
          for (let i = 0; i < cnt; i++) { const id = tr.u(v ? 4 : 2), n = tr.u(1), l = assoc.get(id) ?? []; for (let j = 0; j < n; j++) { const ix = tr.u(sz) & (sz === 2 ? 32767 : 127); if (ix) l.push(ix); } assoc.set(id, l); }
        }
      }
    } else if (t === 'iloc') {
      const [v] = r.full([0, 1, 2]), s1 = r.u(1), s2 = r.u(1), cnt = r.u(v < 2 ? 2 : 4), step = (v ? s2 & 15 : 0) + (s1 >> 4) + (s1 & 15);
      for (let i = 0; i < cnt; i++) { const id = r.u(v < 2 ? 2 : 4); if (v) r.take(2); const ext = r.u(2); r.take(s2 >> 4); r.take(r.u(2) * step); if (locs.has(id)) throw bad('item location: duplicate'); locs.set(id, ext); }
    }
  }
  if (primary === undefined) return null;
  if (!items.has(primary)) throw bad('primary item: missing');
  const spatial = id => {
    const ps = (assoc.get(id) ?? []).map(i => { if (!props[i]) throw bad('item property: missing'); return props[i]; }), szs = ps.filter(p => p.t === 'ispe');
    if (szs.length !== 1) throw bad('spatial extent: exactly one');
    const r = rdr(szs[0].d); r.full([0]); const w = r.u(4), h = r.u(4);
    if (!w || !h) throw bad('spatial extent: empty');
    dimensions(w, h, maxPixels); return {w, h, ps};
  };
  const vis = new Set(), act = new Set();
  const visit = (id, d = 0) => {
    if (act.has(id) || d > 64) throw bad('dependencies: cycle or depth >64'); if (vis.has(id)) return;
    const it = items.get(id); if (!it) throw bad('derived item: missing');
    if (it.prot) throw no('protected item: use host pixels');
    if (locs.get(id)) throw no('external data: use host pixels');
    spatial(id); act.add(id); const ch = refs.get(id) ?? [];
    if ((it.kind === 'grid' || it.kind === 'iden' || it.kind === 'iovl') && !ch.length) throw bad('source items: missing');
    for (const c of ch) visit(c, d + 1);
    act.delete(id); vis.add(id);
  };
  visit(primary);
  const orig = spatial(primary); let width = orig.w, height = orig.h, transformed = false;
  const seenTransforms = new Set();
  for (const {t, d} of orig.ps) {
    if (t !== 'irot' && t !== 'imir' && t !== 'clap') continue;
    if (seenTransforms.has(t)) throw bad('transformative property: duplicate');
    seenTransforms.add(t);
    const r = rdr(d);
    if (t === 'irot') { const a = r.u(1); if (a > 3) throw bad('rotation property: 0-3'); if (a & 1) [width, height] = [height, width]; transformed = true; }
    else if (t === 'imir') { if (r.u(1) > 1) throw bad('mirror property: 0-1'); transformed = true; }
    else if (t === 'clap') {
      const [wn,wd,hn,hd,xn,xd,yn,yd] = Array.from({length: 8}, () => r.u(4));
      if (!wn || !hn || !wd || !hd || !xd || !yd) throw bad('clean aperture: invalid');
      const w = wn / wd, h = hn / hd, x = (xn | 0) / xd, y = (yn | 0) / yd;
      if (!Number.isInteger(w) || !Number.isInteger(h) || !Number.isFinite(x) || !Number.isFinite(y)) throw no('clean aperture: use host pixels');
      dimensions(w, h, maxPixels); if (w + Math.abs(x) * 2 > width || h + Math.abs(y) * 2 > height) throw bad('clean aperture: out of bounds');
      width = w; height = h; transformed = true;
    }
  }
  let decodeBlob = blob;
  if (tracks.length || brands.some(x => SETS.s.has(x))) {
    const sb = [...vis].some(id => items.get(id).kind === 'av01') ? 'avif' : 'mif1', ed = tracks.map(a => [a, 'free']);
    if (SETS.s.has(brands[0])) ed.push([f0.h, sb]);
    for (let i = 1; i < brands.length; i++) if (SETS.s.has(brands[i])) ed.push([f0.h + 4 + i * 4, sb]);
    ed.sort((a, b) => a[0] - b[0]); const parts = []; let at = 0;
    for (const [a, v] of ed) { parts.push(blob.slice(at, a), Uint8Array.from(v, c => c.charCodeAt(0))); at = a + 4; }
    parts.push(blob.slice(at)); decodeBlob = new Blob(parts, {type: blob.type});
  }
  return {primary, kind: items.get(primary).kind, width, height, transformed, decodeBlob};
}
