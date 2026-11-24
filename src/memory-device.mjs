import {LIMITS} from './limits.mjs';
export const WHOLE = 40000000;
export const BAND_PIXELS = 4194304;
export const COMPACT_WHOLE = 16777216;
export const BANDED_LIMITS = LIMITS;
export const bandRows = width => Math.max(64, Math.floor(BAND_PIXELS / width / 64) * 64);

export const WHOLE_BYTES = 106;
export function wholeBudget({deviceMemory, mobile, processMemory, unknownNode = false} = device(), unknownPixels = COMPACT_WHOLE) {
  if (processMemory > 0) return processMemory / 2;
  if (unknownNode) return 0;
  if (deviceMemory >= 16 && mobile === false) return 4 * 2 ** 30;
  return (Number.isFinite(deviceMemory) && deviceMemory > 0 ? deviceMemory <= 4 ? BAND_PIXELS : COMPACT_WHOLE : unknownPixels) * WHOLE_BYTES;
}
export const RETAINED_BYTES = 200;
export const BANDED_BYTES = 26, ONE_PLANE_BYTES = 24, BAND_CACHE_BYTES = 32;
export const retainsWhole = (pixels, bytes) => wholeBudget(undefined, 0) >= pixels * (WHOLE_BYTES + bytes);
const PREDICT_FIXED_BYTES = 119_000_000, PREDICT_PIXEL_BYTES = 12, HELPER_RESIDENT_BYTES = 44 * 1048576;
export const SPLIT_TOKEN_BYTES = 6;
export function uploadCacheBudget(pixels, helpers = 0, deviceInfo) {
  const budget = wholeBudget(deviceInfo, 0);
  if (!(budget > 0) || !(pixels > 0)) return 0;
  return Math.max(0, budget - (PREDICT_FIXED_BYTES + pixels * PREDICT_PIXEL_BYTES + helpers * HELPER_RESIDENT_BYTES));
}
export const keepsSplitTokens = (pixels, helpers = 0, fallbackPixels = 0) => pixels <= fallbackPixels;
const positive = value => Number.isFinite(value) && value > 0 ? value : 0;
const attempt = fn => { try { return positive(fn()); } catch { return 0; } };
export function nodeMemoryBudget(host = globalThis.process) {
  if (!host?.versions?.node) return 0;
  const total = attempt(() => host.getBuiltinModule?.('node:os')?.totalmem?.()), limit = attempt(() => host.constrainedMemory?.());
  return limit && total ? Math.min(limit, total) : limit || total;
}
function device() {
  const nav = globalThis.navigator;
  if (Number.isFinite(nav?.deviceMemory)) return {deviceMemory: nav.deviceMemory, mobile: nav.userAgentData?.mobile};
  const host = globalThis.process;
  return host?.versions?.node ? {processMemory: nodeMemoryBudget(host), unknownNode: true} : {};
}