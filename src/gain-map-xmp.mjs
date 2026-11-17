// SPDX-License-Identifier: MIT
import {headerSegments, isoGainMap, validIsoGainMap, mpfImages} from './jpeg-reconstruction.mjs';

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
  const mGuid = /HasExtendedXMP\s*=\s*"([0-9A-Fa-f]{32})"|<[^>]*HasExtendedXMP[^>]*>\s*([0-9A-Fa-f]{32})\s*</.exec(primary);
  if (!mGuid || !rawExt.length) return primary;
  const wantGuid = (mGuid[1] ?? mGuid[2]).toUpperCase();
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

function parseHdrgmTagValues(xmp, tag) {
  const attrRe = new RegExp('hdrgm:' + tag + '\\s*=\\s*"([^"]+)"', 'i');
  const mAttr = attrRe.exec(xmp);
  if (mAttr) return [mAttr[1].trim()];
  const elemRe = new RegExp('<hdrgm:' + tag + '[^>]*>([\\s\\S]*?)</hdrgm:' + tag + '>', 'i');
  const mElem = elemRe.exec(xmp);
  if (!mElem) return null;
  const body = mElem[1];
  const li = [...body.matchAll(/<rdf:li[^>]*>([^<]+)<\/rdf:li>/gi)].map(m => m[1].trim());
  return li.length ? li : [body.trim()];
}

function parseHdrgmNumbers(xmp, tag, fallback) {
  const raw = parseHdrgmTagValues(xmp, tag);
  if (!raw) return [fallback, fallback, fallback, false];
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
  if (!xmp || !/hdrgm:Version\s*=\s*"1\.0"|<hdrgm:Version>\s*1\.0\s*<\/hdrgm:Version>/i.test(xmp)) return null;
  const gmMax = parseHdrgmNumbers(xmp, 'GainMapMax', 1.0);
  const gmMin = parseHdrgmNumbers(xmp, 'GainMapMin', 0.0);
  const gamma = parseHdrgmNumbers(xmp, 'Gamma', 1.0);
  const offSdr = parseHdrgmNumbers(xmp, 'OffsetSDR', 1 / 64);
  const offHdr = parseHdrgmNumbers(xmp, 'OffsetHDR', 1 / 64);
  if (!gmMax || !gmMin || !gamma || !offSdr || !offHdr) return null;
  if (gamma.slice(0, 3).some(g => !(g > 0))) return null;
  if ([0, 1, 2].some(c => gmMin[c] > gmMax[c])) return null;
  const hasParams = parseHdrgmTagValues(xmp, 'GainMapMax') || parseHdrgmTagValues(xmp, 'HDRCapacityMax');
  if (!hasParams) return null;
  const capMinRaw = parseHdrgmTagValues(xmp, 'HDRCapacityMin');
  const capMaxRaw = parseHdrgmTagValues(xmp, 'HDRCapacityMax');
  const capMin = capMinRaw ? Number(capMinRaw[0]) : 0;
  const capMax = capMaxRaw ? Number(capMaxRaw[0]) : Math.max(gmMax[0], gmMax[1], gmMax[2]);
  if (!Number.isFinite(capMin) || !Number.isFinite(capMax) || capMin < 0 || capMax < capMin) return null;
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

function gainMapMetadataOf(mapBytes) {
  const iso = isoGainMap(mapBytes);
  if (iso && validIsoGainMap(iso)) return iso.slice();
  return parseHdrgmXmp(xmpText(mapBytes))?.isoPayload ?? null;
}

const DIRECTORY = /Semantic\s*=\s*"GainMap"|<Item:Semantic>\s*GainMap\s*<\/Item:Semantic>/;
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

export function promotedGainMap(jpeg, end) {
  for (const image of mpfImages(jpeg)) {
    if (image.start < end) continue;
    const metadata = gainMapMetadataOf(jpeg.subarray(image.start, image.start + image.size));
    if (metadata && metadata.length < 65536) return {start: image.start, metadata};
  }
  if (!DIRECTORY.test(xmpText(jpeg))) return null;
  for (const start of candidateSOIs(jpeg, end)) {
    const metadata = gainMapMetadataOf(jpeg.subarray(start));
    if (metadata && metadata.length < 65536) return {start, metadata};
  }
  return null;
}
