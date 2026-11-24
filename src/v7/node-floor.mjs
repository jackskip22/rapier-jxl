// SPDX-License-Identifier: MIT
export const FLOOR = 'Use Node 22.3 or later.';
export const belowFloor = version => {
  const [major, minor] = version.split('.').map(Number);
  return !(major > 22 || major === 22 && minor >= 3);
};
export const oldNode = () => {
  const versions = globalThis.process?.versions, node = versions?.node;
  return typeof node === 'string' && !globalThis.Deno && !versions.bun && belowFloor(node) ? node : null;
};
