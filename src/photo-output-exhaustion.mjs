// SPDX-License-Identifier: MIT
const exhaustedOutputs = new WeakSet();
export const photoOutputExhausted = error => exhaustedOutputs.has(error);
export function exhaustPhotoOutput(error) {
  exhaustedOutputs.add(error); return error;
}
