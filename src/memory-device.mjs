export const WHOLE = 40000000;
export const BAND_PIXELS = 4194304;
export const COMPACT_WHOLE = 16777216;
export const BANDED_LIMITS = /* @__PURE__ */ Object.freeze({pixels: 16384 * 16384, edge: 16384});
export const bandRows = width => Math.max(64, Math.floor(BAND_PIXELS / width / 64) * 64);

export const WHOLE_BYTES = 106;
export function wholeBudget({deviceMemory, mobile, processMemory} = device(), unknownPixels = COMPACT_WHOLE) {
  if (processMemory > 0) return processMemory / 2;
  if (deviceMemory >= 16 && mobile === false) return 4 * 2 ** 30;
  return (Number.isFinite(deviceMemory) && deviceMemory > 0 ? deviceMemory <= 4 ? BAND_PIXELS : COMPACT_WHOLE : unknownPixels) * WHOLE_BYTES;
}
function device() {
  const nav = globalThis.navigator;
  if (Number.isFinite(nav?.deviceMemory)) return {deviceMemory: nav.deviceMemory, mobile: nav.userAgentData?.mobile};
  try {
    const process = globalThis.process, os = process?.getBuiltinModule?.('node:os'), total = os?.totalmem?.() ?? 0, limit = process?.constrainedMemory?.() ?? 0;
    return {processMemory: limit > 0 && limit < total ? limit : total};
  } catch { return {}; }
}
