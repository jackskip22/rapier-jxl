// SPDX-License-Identifier: MIT
export function jpegYCbCr(components, jfif, adobeTransform) {
  if (components.length !== 3 || jfif) return true;
  if (adobeTransform >= 0) return adobeTransform !== 0;
  return components[0].id !== 0x52 || components[1].id !== 0x47 || components[2].id !== 0x42;
}
