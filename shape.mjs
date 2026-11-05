// SPDX-License-Identifier: MIT
// What a value is, as the realm that holds it sees it: used on the page and inside workers to name the exact shape
// that reaches rapier-jxl's worker (structured clone of ImageBitmap / ImageData / records in Safari).
export function shape(v) {
  if (v === null || typeof v !== 'object') return {type: v === null ? 'null' : typeof v};
  const proto = Object.getPrototypeOf(v), safe = f => { try { return f(); } catch (e) { return 'threw: ' + (e?.message || e); } };
  const data = safe(() => v.data);
  return {
    type: typeof v,
    ctor: safe(() => v.constructor?.name ?? null),
    tag: Object.prototype.toString.call(v),
    proto: proto === null ? 'null' : proto === Object.prototype ? 'Object.prototype' : safe(() => proto.constructor?.name ?? '?'),
    keys: Object.keys(v).slice(0, 16),
    own: Object.getOwnPropertyNames(v).slice(0, 16),
    imageBitmap: typeof ImageBitmap === 'function' && v instanceof ImageBitmap,
    imageData: typeof ImageData === 'function' && v instanceof ImageData,
    canvas: typeof v.getContext === 'function',
    width: safe(() => v.width), height: safe(() => v.height),
    dataType: typeof data,
    dataCtor: data && typeof data === 'object' ? safe(() => data.constructor?.name ?? null) : null,
    dataView: ArrayBuffer.isView(data),
    dataLength: data && typeof data === 'object' ? safe(() => data.length ?? data.byteLength ?? null) : null,
  };
}
export const brief = s => !s ? 'none' : s.type !== 'object' ? s.type :
  `${s.ctor} ${s.tag} proto=${s.proto} keys=[${s.keys.join(',')}] ib=${s.imageBitmap} id=${s.imageData} ${s.width}x${s.height} data=${s.dataType}${s.dataCtor ? ':' + s.dataCtor : ''}${s.dataView ? ' view ' + s.dataLength : ''}`;
// The worker realm's relevant globals.
export const realm = () => ({ImageBitmap: typeof ImageBitmap, ImageData: typeof ImageData, OffscreenCanvas: typeof OffscreenCanvas,
  createImageBitmap: typeof createImageBitmap, BroadcastChannel: typeof BroadcastChannel, location: String(self.location?.href || '').slice(0, 80)});
