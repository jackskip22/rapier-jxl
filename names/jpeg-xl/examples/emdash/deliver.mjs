// A single variants job reads the original for the remaining responsive widths.
// The main copy is already stored and must never be encoded again here.
export const QUALITY = 85;

export function deliveryWidths(width, widths, available = []) {
  if (!Number.isSafeInteger(width) || width < 1 || !Array.isArray(widths) || !Array.isArray(available) ||
      widths.some(w => !Number.isSafeInteger(w) || w < 1) || available.some(w => !Number.isSafeInteger(w) || w < 1))
    throw new TypeError('Expected picture dimensions and positive widths');
  const kept = new Set(available);
  return [...new Set(widths)].filter(w => w < width && !kept.has(w)).sort((a, b) => a - b);
}

export async function deliveryCopies(source, {width, height}, widths, {variants},
  {fidelity = {quality: QUALITY}, maxBytes, signal, onProgress} = {}) {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(height) || height < 1)
    throw new TypeError('Expected picture dimensions and positive widths');
  const sizes = deliveryWidths(width, widths);
  if (!sizes.length) {
    onProgress?.(1);
    signal?.throwIfAborted();
    return [];
  }
  const outputs = sizes.map(w => ({width: w, height: Math.max(1, Math.round(height * w / width)), fidelity,
    ...(maxBytes !== undefined && {maxBytes})}));
  const copies = await variants(source, {outputs, signal, onProgress});
  signal?.throwIfAborted();
  return copies.filter(result => result.fits);
}
