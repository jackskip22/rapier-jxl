// SPDX-License-Identifier: MIT
export function workerAddress(base, name) {
  return new URL(name + '.mjs', base);
}
