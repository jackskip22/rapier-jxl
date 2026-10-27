// SPDX-License-Identifier: MIT
export function spawnJxlHelper() {
  return new Worker(new URL('./rapier-worker.mjs', import.meta.url), {type: 'module'});
}
