/* dedicated worker: createImageBitmap(image/jxl) + OffscreenCanvas 8-bit RGBA readback */
self.onmessage = async (ev) => {
  const { id, bytes } = ev.data;
  const out = { id, ok: false, decoded: false, error: null };
  try {
    const blob = new Blob([bytes], { type: 'image/jxl' });
    const t0 = performance.now();
    const bmp = await createImageBitmap(blob);
    const decodeMs = performance.now() - t0;
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
    if (!ctx) throw new Error('OffscreenCanvas 2d context null');
    ctx.drawImage(bmp, 0, 0);
    const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
    const rgba = new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength);
    bmp.close();
    out.ok = true;
    out.decoded = true;
    out.width = c.width;
    out.height = c.height;
    out.decodeMs = decodeMs;
    out.colorSpace = img.colorSpace || null;
    out.rgba = rgba; // transferable
    self.postMessage(out, [rgba.buffer]);
  } catch (e) {
    out.error = String(e && e.stack || e);
    self.postMessage(out);
  }
};
