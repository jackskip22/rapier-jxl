// SPDX-License-Identifier: MIT
import {headerSegments, isoGainMap, validIsoGainMap, mpfScan, jpegEnd} from './jpeg-reconstruction.mjs';

const XMP = 'http://ns.adobe.com/xap/1.0/\0', XMP_EXT = 'http://ns.adobe.com/xmp/extension/\0';
const UTF8 = /* @__PURE__ */ new TextDecoder(), MAX_XMP_BYTES = 1 << 20, SCAN_WINDOW = 65536;
const named = (bytes, text) => bytes.length >= text.length && [...text].every((c, i) => bytes[i] === c.charCodeAt(0));

function xmpText(jpeg) {
  let primary = null;
  const rawExt = [];
  let extBytes = 0;
  for (const {marker, body, end} of headerSegments(jpeg)) {
    if (marker !== 0xE1 || end > jpeg.length || end <= body) continue;
    const seg = jpeg.subarray(body, end).slice();
    if (primary === null && named(seg, XMP)) {
      primary = UTF8.decode(seg.subarray(XMP.length));
    } else if (named(seg, XMP_EXT) && seg.length >= XMP_EXT.length + 40) {
      const at = XMP_EXT.length;
      const guid = UTF8.decode(seg.subarray(at, at + 32));
      const view = new DataView(seg.buffer, seg.byteOffset + at + 32, 8);
      const fullLength = view.getUint32(0), offset = view.getUint32(4);
      const payload = seg.subarray(at + 40);
      extBytes += payload.length;
      if (extBytes <= MAX_XMP_BYTES && fullLength <= MAX_XMP_BYTES && offset + payload.length <= fullLength) {
        rawExt.push({guid: guid.toUpperCase(), fullLength, offset, bytes: payload});
      }
    }
  }
  if (!primary) return '';
  const wantGuid = findExtendedGuid(primary);
  if (!wantGuid || !rawExt.length) return primary;
  const matched = rawExt.filter(part => part.guid === wantGuid).sort((a, b) => a.offset - b.offset);
  if (!matched.length) return primary;
  const expectedLength = matched[0].fullLength;
  const merged = new Uint8Array(expectedLength);
  let cursor = 0;
  for (const part of matched) {
    if (part.fullLength !== expectedLength || part.offset !== cursor || cursor + part.bytes.length > expectedLength) return primary;
    merged.set(part.bytes, cursor);
    cursor += part.bytes.length;
  }
  if (cursor !== expectedLength) return primary;
  return primary + UTF8.decode(merged);
}

const isSpace = c => c === 32 || c === 9 || c === 10 || c === 13;


function findAttrValue(xmp, lowerName) {
  const lower = xmp.toLowerCase();
  for (let from = 0; ;) {
    const at = lower.indexOf(lowerName, from);
    if (at < 0) return null;
    from = at + lowerName.length;
    if (at > 0) {
      const prev = lower.charCodeAt(at - 1);
      if ((prev >= 97 && prev <= 122) || (prev >= 48 && prev <= 57) || prev === 95 || prev === 45 || prev === 58) continue;
    }
    let p = from;
    while (p < xmp.length && isSpace(xmp.charCodeAt(p))) p++;
    if (xmp.charCodeAt(p) !== 61) continue;
    p++;
    while (p < xmp.length && isSpace(xmp.charCodeAt(p))) p++;
    const quote = xmp.charCodeAt(p);
    if (quote !== 34 && quote !== 39) continue;
    const end = xmp.indexOf(quote === 34 ? '"' : "'", p + 1);
    if (end < 0) return null;
    return xmp.slice(p + 1, end);
  }
}

function findElementBody(xmp, lowerTag, startAt = 0) {
  const lower = xmp.toLowerCase(), openNeedle = '<' + lowerTag, closeNeedle = '</' + lowerTag;
  for (let from = startAt; ;) {
    const at = lower.indexOf(openNeedle, from);
    if (at < 0) return null;
    from = at + openNeedle.length;
    const next = xmp.charCodeAt(from);
    if (next !== 62 && next !== 47 && !isSpace(next)) continue;
    const gt = xmp.indexOf('>', from);
    if (gt < 0) return null;
    const nextLt = xmp.indexOf('<', from);
    if (nextLt >= 0 && nextLt < gt) { from = nextLt; continue; }
    if (xmp.charCodeAt(gt - 1) === 47) continue;
    for (let cSearch = gt + 1; ;) {
      const closeAt = lower.indexOf(closeNeedle, cSearch);
      if (closeAt < 0) return null;
      let p = closeAt + closeNeedle.length;
      while (p < xmp.length && isSpace(xmp.charCodeAt(p))) p++;
      if (xmp.charCodeAt(p) === 62) return {body: xmp.slice(gt + 1, closeAt), next: p + 1};
      cSearch = p;
    }
  }
}

function findExtendedGuid(primary) {
  const attr = findAttrValue(primary, 'hasextendedxmp');
  const trimmedAttr = attr?.trim();
  if (trimmedAttr && /^[0-9A-Fa-f]{32}$/.test(trimmedAttr)) return trimmedAttr.toUpperCase();
  for (let from = 0; ;) {
    const at = primary.indexOf('HasExtendedXMP', from);
    if (at < 0) return null;
    from = at + 14;
    const lt = primary.lastIndexOf('<', at);
    if (lt < 0 || primary.indexOf('>', lt) < at) continue;
    const gt = primary.indexOf('>', from);
    if (gt < 0) return null;
    const innerLt = primary.indexOf('<', from);
    if (innerLt >= 0 && innerLt < gt) continue;
    const closeLt = primary.indexOf('<', gt + 1);
    if (closeLt < 0) return null;
    const text = primary.slice(gt + 1, closeLt).trim();
    if (/^[0-9A-Fa-f]{32}$/.test(text)) return text.toUpperCase();
  }
}

function parseHdrgmTagValues(xmp, tag) {
  const name = 'hdrgm:' + tag.toLowerCase();
  const attr = findAttrValue(xmp, name);
  if (attr !== null) return [attr.trim()];
  const elem = findElementBody(xmp, name);
  if (!elem) return null;
  const li = [];
  for (let pos = 0; ;) {
    const item = findElementBody(elem.body, 'rdf:li', pos);
    if (!item) break;
    pos = item.next;
    if (item.body.includes('<')) return null;
    li.push(item.body.trim());
  }
  return li.length ? li : [elem.body.trim()];
}

function parseHdrgmNumbers(xmp, tag, fallback) {
  const raw = parseHdrgmTagValues(xmp, tag);
  if (!raw) return [fallback, fallback, fallback, false];
  if (raw.some(v => v === '')) return null;
  const nums = raw.map(Number);
  if (nums.some(v => !Number.isFinite(v))) return null;
  if (nums.length === 1) return [nums[0], nums[0], nums[0], false];
  if (nums.length === 3) return [nums[0], nums[1], nums[2], nums[0] !== nums[1] || nums[1] !== nums[2]];
  return null;
}

function toIso21496Payload(meta) {
  const multichannel = !!meta.multichannel;
  const count = multichannel ? 3 : 1;
  const out = new Uint8Array(21 + count * 40);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0);
  view.setUint16(2, 0);
  out[4] = (multichannel ? 0x80 : 0) | (meta.useBaseColorSpace !== false ? 0x40 : 0);
  const DEN = 1000000;
  const putU = (at, v) => {
    const clamped = Math.max(0, Math.min(4294, v));
    view.setUint32(at, Math.round(clamped * DEN) >>> 0);
    view.setUint32(at + 4, DEN);
  };
  const putS = (at, v) => {
    const clamped = Math.max(-2147, Math.min(2147, v));
    view.setInt32(at, Math.round(clamped * DEN) | 0);
    view.setUint32(at + 4, DEN);
  };
  putU(5, meta.baseHdrHeadroom);
  putU(13, meta.alternateHdrHeadroom);
  for (let c = 0; c < count; c++) {
    const ch = meta.channels[c], base = 21 + c * 40;
    putS(base, ch.gainMapMin);
    putS(base + 8, ch.gainMapMax);
    putU(base + 16, ch.gamma);
    putS(base + 24, ch.baseOffset);
    putS(base + 32, ch.alternateOffset);
  }
  return out;
}

function parseHdrgmXmp(xmp) {
  if (!xmp || !/hdrgm:Version\s*=\s*(["'])1\.0\1|<hdrgm:Version>\s*1\.0\s*<\/hdrgm:Version>/i.test(xmp)) return null;
  const gmMax = parseHdrgmNumbers(xmp, 'GainMapMax', 1.0);
  const gmMin = parseHdrgmNumbers(xmp, 'GainMapMin', 0.0);
  const gamma = parseHdrgmNumbers(xmp, 'Gamma', 1.0);
  const offSdr = parseHdrgmNumbers(xmp, 'OffsetSDR', 1 / 64);
  const offHdr = parseHdrgmNumbers(xmp, 'OffsetHDR', 1 / 64);
  if (!gmMax || !gmMin || !gamma || !offSdr || !offHdr) return null;
  if ([0, 1, 2].some(c => !(gamma[c] >= 1e-3 && gamma[c] <= 64))) return null;
  if ([0, 1, 2].some(c => !(gmMin[c] >= -64 && gmMax[c] <= 64 && gmMin[c] <= gmMax[c]))) return null;
  if ([offSdr, offHdr].some(o => [0, 1, 2].some(c => !(o[c] >= 0 && o[c] <= 64)))) return null;
  const hasParams = parseHdrgmTagValues(xmp, 'GainMapMax') || parseHdrgmTagValues(xmp, 'HDRCapacityMax');
  if (!hasParams) return null;
  const capMinRaw = parseHdrgmTagValues(xmp, 'HDRCapacityMin');
  const capMaxRaw = parseHdrgmTagValues(xmp, 'HDRCapacityMax');
  const capMin = capMinRaw ? Number(capMinRaw[0]) : 0;
  const capMax = capMaxRaw ? Number(capMaxRaw[0]) : Math.max(gmMax[0], gmMax[1], gmMax[2]);
  if (!(capMin >= 0 && capMax <= 64 && capMax > capMin)) return null;
  const baseHdrRaw = parseHdrgmTagValues(xmp, 'BaseRenditionIsHDR');
  const baseIsHdr = baseHdrRaw ? /^true$/i.test(baseHdrRaw[0]) : false;
  const multichannel = gmMax[3] || gmMin[3] || gamma[3] || offSdr[3] || offHdr[3];
  const baseHdrHeadroom = baseIsHdr ? capMax : capMin;
  const alternateHdrHeadroom = baseIsHdr ? capMin : capMax;
  const channels = [0, 1, 2].map(c => ({
    gainMapMin: gmMin[c],
    gainMapMax: gmMax[c],
    gamma: gamma[c],
    baseOffset: baseIsHdr ? offHdr[c] : offSdr[c],
    alternateOffset: baseIsHdr ? offSdr[c] : offHdr[c],
  }));
  const meta = {
    format: 'xmp-hdrgm',
    writerVersion: 0,
    multichannel,
    useBaseColorSpace: true,
    baseIsHdr,
    baseHdrHeadroom,
    alternateHdrHeadroom,
    headroom: 2 ** Math.max(baseHdrHeadroom, alternateHdrHeadroom),
    channels,
  };
  meta.isoPayload = toIso21496Payload(meta);
  return meta;
}

function isoValues(payload) {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength), count = payload[4] & 0x80 ? 3 : 1;
  const u = at => view.getUint32(at) / view.getUint32(at + 4), i = at => view.getInt32(at) / view.getUint32(at + 4);
  const out = [u(5), u(13)];
  for (let c = 0; c < 3; c++) { const base = 21 + Math.min(c, count - 1) * 40; out.push(i(base), i(base + 8), u(base + 16), i(base + 24), i(base + 32)); }
  return out;
}
const same = (a, b) => a.length === b.length && a.every((v, k) => Math.abs(v - b[k]) <= 1e-3 + 1e-3 * Math.abs(b[k]));

function gainMapMetadataOf(mapBytes) {
  const iso = isoGainMap(mapBytes), text = xmpText(mapBytes), xmpSaid = /hdrgm:Version/i.test(text);
  const xmp = xmpSaid ? parseHdrgmXmp(text) : null;
  if (iso && validIsoGainMap(iso)) return xmpSaid && !(xmp && same(isoValues(iso), isoValues(xmp.isoPayload))) ? null : iso.slice();
  const converted = xmp?.isoPayload;
  return converted && validIsoGainMap(converted) ? converted : null;
}

const DIRECTORY = /Semantic\s*=\s*(["'])GainMap\1|<Item:Semantic>\s*GainMap\s*<\/Item:Semantic>/;
function* candidateSOIs(jpeg, end) {
  for (let base = end, found = 0; base + 2 < jpeg.length && found < 8; base += SCAN_WINDOW) {
    const chunk = jpeg.subarray(base, Math.min(jpeg.length, base + SCAN_WINDOW + 2));
    for (let i = 0; i + 2 < chunk.length && found < 8; i++) {
      if (chunk[i] === 0xFF && chunk[i + 1] === 0xD8 && chunk[i + 2] === 0xFF) {
        found++;
        yield base + i;
      }
    }
  }
}

function frameOf(jpeg) {
  for (const {marker, body, end} of headerSegments(jpeg)) {
    if (marker >= 0xC0 && marker <= 0xC2 && end <= jpeg.length && end - body >= 6) {
      const f = jpeg.subarray(body, body + 6);
      return {precision: f[0], height: f[1] << 8 | f[2], width: f[3] << 8 | f[4], channels: f[5]};
    }
  }
  return null;
}
function fits(primary, map, metadata) {
  const pa = primary && Math.max(primary.width, primary.height), pb = primary && Math.min(primary.width, primary.height);
  if (!primary || !map || map.precision !== 8 || !map.width || !map.height || !pa || !pb) return false;
  if (Math.max(map.width, map.height) > pa || Math.min(map.width, map.height) > pb) return false;
  return !(metadata[4] & 0x80) || map.channels === 3;
}

export function promotedGainMap(jpeg, end) {
  const frame = frameOf(jpeg), mpf = mpfScan(jpeg);
  if (mpf.bad) return null;
  const found = [];
  for (const image of mpf.images) {
    if (image.start < end) continue;
    const map = jpeg.subarray(image.start, image.start + image.size), metadata = gainMapMetadataOf(map);
    if (metadata && metadata.length < 65536 && fits(frame, frameOf(map), metadata)) found.push({start: image.start, metadata});
  }
  if (found.length) return found.length === 1 ? found[0] : null;
  const directory = xmpText(jpeg), declared = directory.match(new RegExp(DIRECTORY.source, 'g'));
  if (!declared) return null;
  if (declared.length !== 1) return null;
  for (const start of candidateSOIs(jpeg, end)) {
    if (jpegEnd(jpeg, start) < 0) continue;
    const map = jpeg.subarray(start), metadata = gainMapMetadataOf(map);
    if (metadata && metadata.length < 65536 && fits(frame, frameOf(map), metadata)) found.push({start, metadata});
  }
  return found.length === 1 ? found[0] : null;
}
