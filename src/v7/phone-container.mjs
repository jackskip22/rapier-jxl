// SPDX-License-Identifier: MIT
import {check, dimensions, fail} from './primitives.mjs';

const MAX_META = 16 * 1024 * 1024, MAX_BOXES = 16384;
const BRANDS = new Set(['heic','heix','hevc','hevx','heim','heis','hevm','hevs','mif1','msf1','avif','avis']);
const SEQUENCE = new Set(['hevc','hevx','heim','hevm','msf1','avis']);
const bad = message => fail('JXL_INPUT', `The phone image ${message}.`);
const unsupported = message => fail('JXL_UNSUPPORTED', `The phone image ${message}.`);
const text = (bytes, at, length = 4) => String.fromCharCode(...bytes.subarray(at, at + length));

class Reader {
  constructor(bytes, at = 0) { this.bytes = bytes; this.at = at; }
  take(length) {
    if (!Number.isSafeInteger(length) || length < 0 || this.at + length > this.bytes.length) throw bad('container is incomplete');
    const value = this.bytes.subarray(this.at, this.at + length); this.at += length; return value;
  }
  uint(length) {
    if (length > 8) throw unsupported('uses an unsupported item offset');
    let value = 0; for (const byte of this.take(length)) value = value * 256 + byte;
    if (!Number.isSafeInteger(value)) throw bad('item offset exceeds the supported range');
    return value;
  }
  string() { const start = this.at; while (this.at < this.bytes.length && this.bytes[this.at]) { if (this.at - start === 256) throw bad('item name exceeds 256 bytes'); this.at++; } this.take(1); return text(this.bytes, start, this.at - start - 1); }
  full(versions) { const version = this.uint(1), flags = this.uint(3); if (!versions.includes(version)) throw unsupported('uses an unsupported metadata version'); return {version, flags}; }
}

function boxHeader(bytes, remaining) {
  const r = new Reader(bytes); let size = r.uint(4); const type = text(r.take(4), 0);
  if (size === 1) size = r.uint(8); else if (size === 0) size = remaining;
  if (size < r.at || size > remaining) throw bad('box extent is invalid');
  return {type, size, header: r.at};
}

export async function inspectPhone(blob, head, {maxPixels, signal} = {}) {
  if (head.length < 12 || text(head, 4) !== 'ftyp') return null;
  const first = boxHeader(head, blob.size);
  if (first.size > 65536 || first.size < first.header + 8 || (first.size - first.header) % 4) throw bad('file type box is invalid');
  const read = async (start, length) => { check(signal); const bytes = new Uint8Array(await blob.slice(start, start + length).arrayBuffer()); check(signal); if (bytes.length !== length) throw bad('container is incomplete'); return bytes; };
  const ftyp = await read(first.header, first.size - first.header), brands = [text(ftyp, 0)];
  for (let at = 8; at < ftyp.length; at += 4) brands.push(text(ftyp, at));
  if (!brands.some(brand => BRANDS.has(brand))) return null;
  let boxesLeft = MAX_BOXES, meta;
  const tracks = [];
  const countBox = () => { if (!boxesLeft--) throw fail('JXL_LIMIT', 'The phone image has too many metadata boxes.'); };
  const children = function* (bytes, start = 0) {
    for (let at = start; at < bytes.length;) {
      countBox(); const box = boxHeader(bytes.subarray(at, at + 16), bytes.length - at);
      yield {type: box.type, data: bytes.subarray(at + box.header, at + box.size), start: at + box.header}; at += box.size;
    }
  };
  for (let at = first.size; at < blob.size;) {
    countBox(); const box = boxHeader(await read(at, Math.min(16, blob.size - at)), blob.size - at);
    if (box.type === 'meta') { if (meta) throw bad('has more than one file-level metadata box'); if (box.size - box.header > MAX_META) throw fail('JXL_MEMORY', 'The phone image metadata exceeds 16 MiB.'); meta = await read(at + box.header, box.size - box.header); }
    if (box.type === 'moov') tracks.push(at + 4);
    at += box.size;
  }
  if (!meta) return null;
  const root = new Reader(meta); root.full([0]);
  let primary;
  const items = new Map(), refs = [], properties = [null], associations = new Map(), locations = new Map();
  for (const {type, data} of children(meta, root.at)) {
    const r = new Reader(data);
    if (type === 'pitm') {
      if (primary !== undefined) throw bad('has more than one primary item');
      const {version} = r.full([0,1]); primary = r.uint(version ? 4 : 2);
    } else if (type === 'iinf') {
      const {version} = r.full([0,1]), count = r.uint(version ? 4 : 2); let found = 0;
      for (const box of children(data, r.at)) {
        if (box.type !== 'infe') throw bad('item information is invalid');
        const item = new Reader(box.data), {version: v} = item.full([2,3]);
        const id = item.uint(v === 2 ? 2 : 4), protection = item.uint(2), kind = text(item.take(4), 0); item.string();
        if (items.has(id)) throw bad('repeats an item identifier');
        items.set(id, {kind, protection}); found++;
      }
      if (found !== count) throw bad('item count does not match its table');
    } else if (type === 'iref') {
      const {version} = r.full([0,1]), size = version ? 4 : 2;
      for (const box of children(data, r.at)) {
        const ref = new Reader(box.data), from = ref.uint(size), count = ref.uint(2), to = [];
        for (let i = 0; i < count; i++) { countBox(); to.push(ref.uint(size)); } refs.push({type: box.type, from, to});
      }
    } else if (type === 'iprp') {
      for (const box of children(data)) {
        if (box.type === 'ipco') for (const property of children(box.data)) properties.push(property);
        else if (box.type === 'ipma') {
          const table = new Reader(box.data), {version, flags} = table.full([0,1]), count = table.uint(4), size = flags & 1 ? 2 : 1;
          for (let i = 0; i < count; i++) {
            countBox();
            const id = table.uint(version ? 4 : 2), n = table.uint(1), list = associations.get(id) ?? [];
            for (let j = 0; j < n; j++) { countBox(); const value = table.uint(size), index = value & (size === 2 ? 32767 : 127); if (index) list.push(index); }
            associations.set(id, list);
          }
        }
      }
    } else if (type === 'iloc') {
      const {version} = r.full([0,1,2]), sizes = r.uint(1), baseSizes = r.uint(1), count = r.uint(version < 2 ? 2 : 4);
      const offsetSize = sizes >> 4, lengthSize = sizes & 15, baseSize = baseSizes >> 4, indexSize = version ? baseSizes & 15 : 0;
      for (let i = 0; i < count; i++) {
        countBox();
        const id = r.uint(version < 2 ? 2 : 4); if (version) r.take(2);
        const external = r.uint(2); r.take(baseSize); const n = r.uint(2);
        for (let j = 0; j < n; j++) { countBox(); r.take(indexSize + offsetSize + lengthSize); }
        if (locations.has(id)) throw bad('repeats an item location'); locations.set(id, {external});
      }
     
    }
  }
  if (primary === undefined) return null;
  if (!items.has(primary)) throw bad('primary item is missing');
  const byItem = new Map();
  for (const ref of refs) { let map = byItem.get(ref.from); if (!map) byItem.set(ref.from, map = new Map()); const to = map.get(ref.type) ?? []; to.push(...ref.to); map.set(ref.type,to); }
  const references = (id, type) => byItem.get(id)?.get(type) ?? [];
  const propsFor = id => (associations.get(id) ?? []).map(index => { if (!properties[index]) throw bad('item property is missing'); return properties[index]; });
  const spatial = id => {
    const props = propsFor(id), sizes = props.filter(p => p.type === 'ispe');
    if (sizes.length !== 1) throw bad('image item needs one spatial extent');
    const r = new Reader(sizes[0].data); r.full([0]); const width = r.uint(4), height = r.uint(4); dimensions(width, height, maxPixels);
    return {width, height, props};
  };
  const visited = new Set(), active = new Set();
  const visit = (id, depth = 0) => {
    if (active.has(id) || depth > 64) throw bad('derived image dependencies are cyclic or too deep');
    if (visited.has(id)) return;
    const item = items.get(id); if (!item) throw bad('derived image item is missing');
    if (item.protection) throw unsupported('primary image or a dependency is protected');
    if (locations.get(id)?.external) throw unsupported('primary image or a dependency uses external data');
    spatial(id); active.add(id);
    const derived = references(id,'dimg');
    if (['grid','iden','iovl'].includes(item.kind) && !derived.length) throw bad('derived image has no source items');
    for (const child of derived) visit(child, depth + 1);
    active.delete(id); visited.add(id);
  };
  visit(primary);
  const original = spatial(primary); let {width, height} = original, transformed = false;
  for (const {type, data} of original.props) {
    const r = new Reader(data);
    if (type === 'irot') { const angle = r.uint(1); if (angle > 3) throw bad('rotation property is invalid'); if (angle & 1) [width, height] = [height, width]; transformed = true; }
    else if (type === 'imir') { if (r.uint(1) > 1) throw bad('mirror property is invalid'); transformed = true; }
    else if (type === 'clap') {
      const fields = Array.from({length: 8}, () => r.uint(4));
      const [wn,wd,hn,hd,xn,xd,yn,yd] = fields, w = wn/wd, h = hn/hd, x = (xn|0)/xd, y = (yn|0)/yd;
      if (!Number.isInteger(w) || !Number.isInteger(h) || !Number.isFinite(x) || !Number.isFinite(y)) throw unsupported('uses a fractional clean aperture');
      dimensions(w, h, maxPixels);
      if (w + Math.abs(x)*2 > width || h + Math.abs(y)*2 > height) throw bad('clean aperture exceeds its image');
      width = w; height = h; transformed = true;
    }
  }

  let decodeBlob = blob;
  if (tracks.length || brands.some(brand => SEQUENCE.has(brand))) {
    const stillBrand = visited.size && [...visited].some(id => items.get(id).kind === 'av01') ? 'avif' : 'mif1';
    const edits = tracks.map(at => ({at, value: 'free'}));
    if (SEQUENCE.has(brands[0])) edits.push({at: first.header, value: stillBrand});
    for (let i = 1; i < brands.length; i++) if (SEQUENCE.has(brands[i])) edits.push({at: first.header + 4 + i*4, value: stillBrand});
    edits.sort((a,b) => a.at-b.at); const parts = []; let at = 0;
    for (const edit of edits) { parts.push(blob.slice(at, edit.at), Uint8Array.from(edit.value, c => c.charCodeAt(0))); at = edit.at+4; }
    parts.push(blob.slice(at)); decodeBlob = new Blob(parts, {type: blob.type});
  }
  return {primary, kind: items.get(primary).kind, width, height, transformed, decodeBlob};
}
