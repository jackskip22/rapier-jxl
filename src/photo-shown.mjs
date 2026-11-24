// SPDX-License-Identifier: MIT
const watchers = new Set();
export const hasShownWatchers = () => watchers.size !== 0;
export const shown = (bytes, picture, plan) => {
  if (watchers.size && bytes instanceof Uint8Array && picture) for (const watch of watchers) watch(bytes, picture, plan);
  return bytes;
};
export const watchShown = watch => { watchers.add(watch); return () => { watchers.delete(watch); }; };
export async function withShown(produce) {
  const pictures = new Map(), stop = watchShown((bytes, picture) => pictures.set(bytes, picture));
  try { return {value: await produce(), pictures}; } finally { stop(); }
}
export const EXACT = /* @__PURE__ */ Object.freeze({exact: true});
export function* exactCapture(request) { return shown(yield request, EXACT); }
