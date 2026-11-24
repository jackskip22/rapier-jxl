// SPDX-License-Identifier: MIT
// JPEG XL pictures in a Void app's storage (void/storage, inferred from this import), shared by its two routes:
//   POST /api/images      a JPEG XL file the page encoded from a JPEG (src/jxl-upload.mjs), checked here to restore
//                         that JPEG exactly, or a JPEG or PNG, which the Worker keeps exact itself.
//   GET  /api/images/<id> image/jxl to a browser that accepts it, else the exact original JPEG (or the PNG), Vary: Accept.
// The URL is the picture's own hash, so it is cached for good. Call these after your own authentication.
import {storage} from 'void/storage';
import {configure as configureJpeg, recompress, restore} from 'jpegxl/jpeg';
import {configure as configureUpload, encode} from 'jpegxl/upload';
import {serve} from 'jpegxl/serve';

// What a Worker's 128 MB holds, as the Workers example measured in workerd: a JPEG up to 12.6 MP at effort 1,
// a PNG up to 2.7 MP. A larger JPEG is encoded in the page; a larger PNG is refused.
const JPEG_PIXELS = 12_600_000, PNG_PIXELS = 2_700_000, MAX_BYTES = 25_000_000;
configureJpeg({maxPixels: JPEG_PIXELS});
configureUpload({maxPixels: PNG_PIXELS});

const PREFIX = 'jxl/', ROUTE = '/api/images/';
const NO_STORE = {'cache-control': 'no-store', 'x-content-type-options': 'nosniff'};
const fault = (code, message, status = 400) => Object.assign(new Error(message), {code, status});
const hex = bytes => Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
const digest = bytes => crypto.subtle.digest('SHA-256', bytes).then(hex);
const isJpeg = b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const isPng = b => [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => b[i] === byte);
const isJxl = b => b[0] === 0xff && b[1] === 0x0a || [0, 0, 0, 12, 74, 88, 76, 32].every((byte, i) => b[i] === byte);

function failure(error, method) {
  const code = typeof error?.code === 'string' && /^JXL_[A-Z_]+$/.test(error.code) ? error.code : 'JXL_STORAGE';
  const status = error?.status ?? ({JXL_INPUT: 400, JXL_JPEG: 400, JXL_DIMENSIONS: 413, JXL_MEMORY: 413,
    JXL_UNSUPPORTED: 415, JXL_RECONSTRUCTION: 422, JXL_ABORT: 499, JXL_WASM: 503}[code] ?? 500);
  const message = code === 'JXL_STORAGE' ? 'Image storage failed. Try the request again.' : error.message;
  if (status >= 500) console.error(JSON.stringify({code, message}));
  return new Response(method === 'HEAD' ? null : JSON.stringify({error: {code, message}}),
    {status, headers: {...NO_STORE, 'content-type': 'application/json'}});
}

async function store(request) {
  const type = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (!['image/jxl', 'image/jpeg', 'image/png'].includes(type)) throw fault('JXL_UNSUPPORTED', 'Send a JPEG, a PNG or the page\'s JPEG XL as the request body.', 415);
  if (Number(request.headers.get('content-length')) > MAX_BYTES) throw fault('JXL_DIMENSIONS', 'The image is larger than 25 MB.', 413);
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > MAX_BYTES) throw fault('JXL_DIMENSIONS', 'The image is larger than 25 MB.', 413);
  if (!(type === 'image/jxl' ? isJxl : type === 'image/jpeg' ? isJpeg : isPng)(body)) throw fault('JXL_INPUT', 'The image does not match its Content-Type.');
  let jxl, sourceType, sourceSha256, sourceBytes;
  if (type === 'image/jxl') {
    // The page's file is kept only when it restores, here, the very JPEG the page says it encoded.
    sourceSha256 = request.headers.get('x-jxl-source-sha256')?.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sourceSha256 ?? '')) throw fault('JXL_INPUT', 'Send x-jxl-source-sha256: the SHA-256 of the JPEG the file was made from.');
    const restored = await restore(body, {signal: request.signal});
    if (await digest(restored.bytes) !== sourceSha256) throw fault('JXL_INPUT', 'The JPEG XL file does not restore that JPEG.', 422);
    jxl = body; sourceType = 'image/jpeg'; sourceBytes = restored.bytes.byteLength;
  } else {
    sourceSha256 = await digest(body); sourceType = type; sourceBytes = body.byteLength;
    const result = type === 'image/jpeg' ? await recompress(body, {effort: 1, signal: request.signal})
      : await encode(new Blob([body]), {effort: 1, fidelity: 'exact', signal: request.signal});
    if (!result.bytes || !result.meetsTarget || !['jpeg-bytes', 'pixels'].includes(result.kept)) throw fault('JXL_TARGET', 'The image could not be kept exact.', 422);
    jxl = result.bytes;
  }
  const sha256 = await digest(jxl);
  // Two PNG files can make the same JPEG XL file, and each keeps its own original: the id names both.
  const id = await digest(new TextEncoder().encode(`${sourceSha256}:${sha256}`));
  // The JPEG XL object goes last, so every one that can be read has its PNG beside it. A JPEG is inside the file.
  if (sourceType === 'image/png') await storage.put(`${PREFIX}${id}.png`, body, {httpMetadata: {contentType: 'image/png'}});
  await storage.put(`${PREFIX}${id}.jxl`, jxl, {httpMetadata: {contentType: 'image/jxl'},
    customMetadata: {sourceType, sourceSha256, sourceBytes: String(sourceBytes)}});
  const url = ROUTE + id;
  return Response.json({id, url, sha256, sourceSha256, bytes: jxl.byteLength, sourceBytes, encoded: type === 'image/jxl' ? 'page' : 'worker'},
    {status: 201, headers: {...NO_STORE, location: url}});
}

async function show(request, id) {
  if (!/^[0-9a-f]{64}$/.test(id ?? '')) throw fault('JXL_INPUT', 'Image not found.', 404);
  const stored = await storage.get(`${PREFIX}${id}.jxl`);
  if (!stored) throw fault('JXL_INPUT', 'Image not found.', 404);
  const sourceType = stored.customMetadata?.sourceType;
  if (sourceType !== 'image/jpeg' && sourceType !== 'image/png') throw fault('JXL_STORAGE', 'The stored image is incomplete.', 500);
  const fallback = sourceType === 'image/png' ? {type: 'image/png', bytes: async () => {
    const original = await storage.get(`${PREFIX}${id}.png`);
    if (!original) throw fault('JXL_STORAGE', 'The original image is missing.', 500);
    return new Uint8Array(await original.arrayBuffer());
  }} : undefined;
  const response = await serve(new Uint8Array(await stored.arrayBuffer()), request, {etag: `"${id}"`, maxPixels: JPEG_PIXELS,
    cacheControl: 'public, max-age=31536000, immutable', signal: request.signal, ...fallback && {fallback}});
  response.headers.set('x-content-type-options', 'nosniff');
  return response;
}

export const upload = request => store(request).catch(error => failure(error, request.method));
export const image = (request, id) => show(request, id).catch(error => failure(error, request.method));
