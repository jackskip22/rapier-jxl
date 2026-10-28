// SPDX-License-Identifier: MIT
export async function captureAnswer({data, width, height, colorSpace}) {
  const coder = await import('./capture-codec.mjs').catch(() => null);
  return coder ? coder.encodeCaptureBytes(data, width, height, {colorSpace}) : null;
}
