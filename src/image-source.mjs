// SPDX-License-Identifier: MIT
export async function readImage(source, keepJpeg) {
  if (typeof ImageData === 'function' && source instanceof ImageData) return {data: new Uint8Array(source.data.buffer, source.data.byteOffset, source.data.byteLength), width: source.width, height: source.height};
  if (keepJpeg && typeof Blob === 'function' && source instanceof Blob) {
    const bytes = new Uint8Array(await source.arrayBuffer());
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return {jpeg: bytes};
  }
  const bitmap = typeof ImageBitmap === 'function' && source instanceof ImageBitmap ? source : await createImageBitmap(source);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d', {willReadFrequently: true});
  context.drawImage(bitmap, 0, 0);
  const {data, width, height} = context.getImageData(0, 0, bitmap.width, bitmap.height);
  return {data: new Uint8Array(data.buffer), width, height};
}
