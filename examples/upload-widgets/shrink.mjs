// A photograph made smaller on the person's device before it is uploaded: a JPEG XL File when that is smaller, and
// otherwise the original File, unchanged. filepond.mjs calls it; it is also the whole integration for any
// other widget: `const {file} = await shrink(picked)`.
import {encode, configure, close} from 'jpegxl/upload';
import {edit} from 'jpegxl/metadata';

// Still pictures the browser decodes. GIF and animated PNG or WebP keep their file: their frames are rapier-jxl/animation's.
const STILL = /^image\/(jpeg|png|webp|heic|heif)$/;

// fidelity and effort are rapier-jxl/upload's; retainExif copies a JPEG's Exif into the JPEG XL file (dropped by default,
// as the widgets' own compressors do). They are defaults here and per call in shrink. helpers (true, the default, or
// {count, memoryBytes}; false for none) and maxPixels configure rapier-jxl/upload at the first shrink; in a browser it
// runs in its own worker.
export function shrinker({helpers = true, maxPixels, ...preset} = {}) {
  let configured = false;
  const encoder = () => {
    if (!configured) { configure({...(helpers !== false && {helpers}), ...(maxPixels !== undefined && {maxPixels})}); configured = true; }
    return {encode};
  };
  // {file, result, code}: result is rapier-jxl's record when a JPEG XL file was made; code says why the original
  // goes up instead (a JXL_* code, 'larger', 'animated', 'type' or AbortError's name). Never rejects.
  async function shrink(file, options = {}) {
    const {fidelity = {quality: 70}, effort = 3, retainExif = false, signal, onProgress} = {...preset, ...options};
    try {
      if (!STILL.test(file.type)) return {file, result: null, code: 'type'};
      if (await animated(file)) return {file, result: null, code: 'animated'};
      const result = await encoder().encode(file, {fidelity, effort, signal, onProgress});
      if (!result.bytes) return {file, result, code: result.reason?.code ?? 'larger'};
      let bytes = result.bytes;
      if (retainExif && file.type === 'image/jpeg') {
        const exif = await jpegExif(file);
        if (exif) bytes = await edit(bytes, {exif});
      }
      // The file that would go up, Exif included, must be smaller than the one picked.
      if (bytes.length >= file.size) return {file, result, code: 'larger'};
      const name = file.name.replace(/\.[^.]*$/, '') + '.jxl';
      return {file: new File([bytes], name, {type: 'image/jxl', lastModified: file.lastModified}), result, code: null};
    } catch (error) {
      return {file, result: null, code: error?.name === 'AbortError' ? 'AbortError' : error?.code ?? 'error'};
    }
  }
  return {shrink, close: () => { configured = false; return close(); }};
}

// An animated PNG (acTL before the first IDAT) or WebP (VP8X's animation flag).
async function animated(file) {
  if (file.type !== 'image/png' && file.type !== 'image/webp') return false;
  const head = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
  if (file.type === 'image/webp') return text(head, 12, 4) === 'VP8X' && (head[20] & 2) !== 0;
  for (let at = 8; at + 8 <= head.length;) {
    const type = text(head, at + 4, 4);
    if (type === 'acTL') return true;
    if (type === 'IDAT') return false;
    at += 12 + (head[at] << 24 >>> 0) + (head[at + 1] << 16) + (head[at + 2] << 8) + head[at + 3];
  }
  return false;
}

// The TIFF bytes of a JPEG's Exif segment, with its orientation set to 1: the browser has already turned the pixels.
async function jpegExif(file) {
  const head = new Uint8Array(await file.slice(0, 1 << 17).arrayBuffer());
  for (let at = 2; at + 4 <= head.length && head[at] === 0xff;) {
    if (head[at + 1] === 0xff) { at++; continue; } // a fill byte before a marker is legal
    const marker = head[at + 1], end = at + 2 + (head[at + 2] << 8 | head[at + 3]);
    if (marker === 0xda || end > head.length) return null;
    if (marker === 0xe1 && text(head, at + 4, 6) === 'Exif\0\0') return upright(head.slice(at + 10, end));
    at = end;
  }
  return null;
}

function upright(tiff) {
  if (tiff.length < 8) return null;
  const view = new DataView(tiff.buffer), little = tiff[0] === 0x49, ifd = view.getUint32(4, little);
  if (ifd + 2 > tiff.length) return tiff;
  for (let i = 0, count = view.getUint16(ifd, little); i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) break;
    if (view.getUint16(entry, little) !== 0x0112) continue;
    if (view.getUint16(entry + 2, little) === 4) view.setUint32(entry + 8, 1, little); // a LONG holds the value in four bytes
    else view.setUint16(entry + 8, 1, little);
  }
  return tiff;
}

const text = (bytes, at, length) => String.fromCharCode(...bytes.subarray(at, at + length));
