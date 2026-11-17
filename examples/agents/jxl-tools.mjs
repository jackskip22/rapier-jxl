// SPDX-License-Identifier: MIT
// JPEG XL tools for agents on Cloudflare: five tools over images in an R2 bucket (binding JXL_BUCKET). An agent names
// objects by key and gets keys, sizes and a verdict back, never the picture's bytes. One definition serves the MCP server
// (jxl-mcp.mjs) and an Agent class (jxl-agent.mjs). A refusal is a result with isError and a JXL_ code, never a thrown error.
import {recompress, restore} from 'jpegxl/jpeg';
import {encode, configureDecoder as configureUploadDecoder} from 'jpegxl/upload';
import {decode} from 'jpegxl/decode';
import {verify, configureDecoder as configureVerifyDecoder} from 'jpegxl/verify';
import {inspect, header} from 'jpegxl/metadata';

// A picture is read whole into the isolate's 128 MB: bound both encoded bytes and pixel area. A JPEG restored or
// verified exactly holds its coefficients only, so it is admitted to 12.2 MP (worker-admission-table.mjs).
const MAX_BYTES = 24_000_000, MAX_PIXELS = 4_500_000, MAX_JPEG_PIXELS = 12_200_000, MAX_BOXES = 1024, MAX_KEY_BYTES = 1024;
const UTF8_ENC = /* @__PURE__ */ new TextEncoder();
const refuse = (code, message) => Object.assign(new Error(message), {code});
const isJpeg = b => b.length >= 2 && b[0] === 0xff && b[1] === 0xd8;
const isPng = b => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
  b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a;
const isJxl = b => b.length >= 2 && b[0] === 0xff && b[1] === 0x0a ||
  b.length >= 12 && b[0] === 0 && b[1] === 0 && b[2] === 0 && b[3] === 12 && b[4] === 0x4a && b[5] === 0x58 && b[6] === 0x4c && b[7] === 0x20;
const besideKey = (key, ext) => key.replace(/\.[^./]+$/, '') + ext;
const safeLabel = key => key.length <= 120 ? key : key.slice(0, 117) + '...';

let decodersConfigured = false;
function ensureDecoders() {
  if (decodersConfigured) return;
  configureVerifyDecoder(decode, restore, recompress);
  configureUploadDecoder(decode, restore, recompress);
  decodersConfigured = true;
}

function admitKey(key, what = 'key') {
  if (typeof key !== 'string' || !key || UTF8_ENC.encode(key).byteLength > MAX_KEY_BYTES || /[\x00-\x1f\x7f\\]/.test(key))
    throw refuse('JXL_OPTIONS', `Invalid ${what}; pass a relative R2 object key up to 1024 bytes.`);
  if (key.startsWith('/') || key.endsWith('/') || key.includes('//') || /^[a-z][a-z0-9+.-]*:\/\//i.test(key))
    throw refuse('JXL_OPTIONS', `Invalid ${what}; pass a relative R2 object key inside the bucket.`);
  const segments = key.split('/');
  if (segments.some(seg => !seg || seg === '.' || seg === '..' || seg === '.jxl-parts'))
    throw refuse('JXL_OPTIONS', `Invalid ${what}; path traversal and .jxl-parts keys are not allowed.`);
  return key;
}

function admitDistinctOut(key, out) {
  admitKey(out, 'out');
  if (out === key) throw refuse('JXL_OPTIONS', 'Invalid out; pass an output key distinct from key.');
  return out;
}

async function admitImageDimensions(bytes, key, maxPixels = MAX_PIXELS) {
  const info = await inspect(bytes, {maxPixels, maxBoxes: MAX_BOXES, maxInputBytes: MAX_BYTES});
  if (info.width * info.height > maxPixels)
    throw refuse('JXL_DIMENSIONS', `${safeLabel(key)} is ${info.width}x${info.height} (over ${(maxPixels / 1e6).toFixed(1)} MP Worker limit); use the R2 Workflow Worker.`);
  return info;
}

async function read(env, key, what = 'key') {
  if (!env?.JXL_BUCKET) throw refuse('JXL_SETUP', 'JXL_BUCKET: bind R2; run npx jpegxl add agents');
  admitKey(key, what);
  const object = await env.JXL_BUCKET.get(key);
  if (!object) throw refuse('JXL_INPUT', `${what}: missing ${safeLabel(key)}`);
  if (object.size > MAX_BYTES) {
    object.body?.cancel();
    throw refuse('JXL_LIMIT', `${safeLabel(key)}: over ${MAX_BYTES / 1e6} MB; run npx jpegxl add r2`);
  }
  return new Uint8Array(await object.arrayBuffer());
}
async function write(env, key, bytes, overwrite, meta, contentType = 'image/jxl') {
  admitKey(key, 'out');
  // A conditional put: the key is claimed only if nothing is there (or, with overwrite, whatever is there).
  const put = await env.JXL_BUCKET.put(key, bytes, {
    customMetadata: meta,
    httpMetadata: {contentType},
    ...!overwrite && {onlyIf: new Headers({'if-none-match': '*'})},
  });
  if (!put) throw refuse('JXL_OPTIONS', `${safeLabel(key)}: exists; set overwrite: true`);
}
const summary = (key, out, from, to, extra) => ({key: out, from: key, fromBytes: from, bytes: to, saved: Math.round((1 - to / from) * 1000) / 10 + '%', ...extra});

// The tools: z is zod. run(env, args) returns a small JSON-able object.
export function defineTools(z) {
  const key = z.string().min(1).max(MAX_KEY_BYTES).describe('Object key in the bucket.');
  const out = z.string().min(1).max(MAX_KEY_BYTES).optional().describe('Key to write; default: the same name ending .jxl (.restored.jpg for restore).');
  const overwrite = z.boolean().optional().describe('Replace an existing object at out.');
  const recompressEffort = z.number().int().min(1).max(7).optional().describe('1 fastest, 7 smallest; default 3. Higher efforts need more time.');
  const convertEffort = z.number().int().min(1).max(3).optional().describe('1 fastest, 3 smallest; default 3.');
  return [
    {name: 'jxl_recompress', description: 'Make a JPEG into a JPEG XL file that restores the same JPEG exactly. Smaller by about 18%.',
      input: z.object({key, out, overwrite, effort: recompressEffort}).strict(),
      async run(env, {key, out, overwrite, effort = 3}) {
        const bytes = await read(env, key);
        if (!isJpeg(bytes)) throw refuse('JXL_INPUT', `${safeLabel(key)}: not a JPEG; use jxl_convert`);
        out = admitDistinctOut(key, out ?? besideKey(key, '.jxl'));
        await admitImageDimensions(bytes, key);
        const result = await recompress(bytes, {effort, maxPixels: MAX_PIXELS});
        await write(env, out, result.bytes, overwrite, {jxl: 'exact', from: key});
        return summary(key, out, bytes.length, result.bytes.length, {restores: 'the same JPEG, exactly'});
      }},
    {name: 'jxl_convert', description: 'Make a picture (PNG, or a JPEG at a look) into a JPEG XL file. Without quality it is pixel exact; with quality 1-99 it is lossy at that look.',
      input: z.object({key, out, overwrite, effort: convertEffort, quality: z.number().min(1).max(99).optional().describe('Look, 1-99; omit for pixel exact.')}).strict(),
      async run(env, {key, out, overwrite, effort = 3, quality}) {
        ensureDecoders();
        const bytes = await read(env, key);
        if (!isJpeg(bytes) && !isPng(bytes)) throw refuse('JXL_INPUT', `${safeLabel(key)} is not a JPEG or PNG.`);
        out = admitDistinctOut(key, out ?? besideKey(key, '.jxl'));
        await admitImageDimensions(bytes, key);
        const type = isJpeg(bytes) ? 'image/jpeg' : 'image/png';
        const result = await encode(new Blob([bytes], {type}), {effort, maxPixels: MAX_PIXELS, fidelity: quality === undefined ? 'exact' : {quality}});
        await write(env, out, result.bytes, overwrite, {jxl: quality === undefined ? 'pixels' : 'look', from: key});
        return summary(key, out, bytes.length, result.bytes.length, {kept: quality === undefined ? 'every pixel' : `a look of ${quality}`});
      }},
    {name: 'jxl_restore', description: 'Give a JPEG back exactly from the JPEG XL file jxl_recompress made.',
      input: z.object({key, out, overwrite}).strict(),
      async run(env, {key, out, overwrite}) {
        const bytes = await read(env, key);
        if (!isJxl(bytes)) throw refuse('JXL_INPUT', `${safeLabel(key)}: JPEG XL required`);
        out = admitDistinctOut(key, out ?? besideKey(key, '.restored.jpg'));
        await admitImageDimensions(bytes, key, MAX_JPEG_PIXELS);
        const result = await restore(bytes, {maxPixels: MAX_JPEG_PIXELS});
        await write(env, out, result.bytes, overwrite, {restored: key}, 'image/jpeg');
        return summary(key, out, bytes.length, result.bytes.length, {restored: 'the original JPEG'});
      }},
    {name: 'jxl_verify', description: 'Check that a JPEG XL file is a faithful copy of its original: restores the JPEG exactly, every pixel exact, or the look measured.',
      input: z.object({original: z.string().min(1).max(MAX_KEY_BYTES).describe('Key of the original JPEG or PNG.'), jxl: z.string().min(1).max(MAX_KEY_BYTES).describe('Key of the JPEG XL file.')}).strict(),
      async run(env, {original, jxl}) {
        ensureDecoders();
        const source = await read(env, original, 'original'), file = await read(env, jxl, 'jxl');
        if (!isJpeg(source) && !isPng(source)) throw refuse('JXL_INPUT', `${safeLabel(original)} is not a JPEG or PNG.`);
        if (!isJxl(file)) throw refuse('JXL_INPUT', `${safeLabel(jxl)}: JPEG XL required`);
        const sourceLimit = isJpeg(source) ? MAX_JPEG_PIXELS : MAX_PIXELS;
        await admitImageDimensions(source, original, sourceLimit);
        const h = header(file, {maxPixels: sourceLimit, maxBoxes: MAX_BOXES, maxInputBytes: MAX_BYTES});
        const [width, height] = h.orientation > 4 ? [h.height, h.width] : [h.width, h.height];
        const record = {bytes: file, width, height, format: 'jxl', source: null, meetsTarget: true, measurements: []};
        const sourceType = isJpeg(source) ? 'image/jpeg' : 'image/png';
        let receipt, refusal;
        // A picture over MAX_PIXELS is checked by its bytes only: its pixels do not fit the isolate.
        const pixelClaims = width * height <= MAX_PIXELS ? [{fidelity: 'exact', kept: 'pixels'}, {fidelity: {quality: 1}, kept: 'lossy'}] : [];
        for (const claim of [...isJpeg(source) ? [{fidelity: 'exact', kept: 'jpeg-bytes'}] : [], ...pixelClaims]) {
          try { receipt = await verify(claim.kept === 'jpeg-bytes' ? source : new Blob([source], {type: sourceType}), {...record, ...claim}, {maxPixels: sourceLimit}); break; }
          catch (error) {
            refusal = error;
            if (!['JXL_TARGET', 'JXL_RECONSTRUCTION'].includes(error?.code)) throw error;
          }
        }
        if (!receipt) return {verified: false, code: refusal?.code ?? 'JXL_TARGET', reason: String(refusal?.message ?? refusal)};
        const kept = receipt.kind === 'jpeg-restore' ? 'jpeg-bytes' : receipt.kind === 'pixels' ? 'pixels' : 'lossy';
        return {verified: true, kept, ...kept === 'lossy' && {metric: receipt.metric, score: Math.round(receipt.score * 100) / 100}};
      }},
    {name: 'jxl_inspect', description: 'Read a picture\'s size, color and kind from its header: JPEG, PNG or JPEG XL. Reads no pixels.',
      input: z.object({key}).strict(),
      async run(env, {key}) {
        const bytes = await read(env, key);
        const info = await inspect(bytes, {maxBoxes: MAX_BOXES, maxInputBytes: MAX_BYTES});
        return {key, bytes: bytes.length, ...Object.fromEntries(Object.entries(info).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v)))};
      }},
  ];
}

// The result a tool hands back: JSON text, or a coded refusal.
export async function runTool(tool, env, args) {
  try {
    const parsed = tool.input ? tool.input.parse(args ?? {}) : args;
    return {content: [{type: 'text', text: JSON.stringify(await tool.run(env, parsed))}]};
  } catch (error) {
    if (error?.name === 'ZodError') {
      const issue = error.issues?.[0];
      return {isError: true, content: [{type: 'text', text: `JXL_OPTIONS: Invalid argument${issue?.path?.length ? ' ' + issue.path.join('.') : ''}; ${issue?.message ?? 'check tool arguments'}.`}]};
    }
    const code = String(error?.code).startsWith('JXL_') ? error.code : 'JXL_INTERNAL';
    return {isError: true, content: [{type: 'text', text: `${code}: ${code === 'JXL_INTERNAL' ? 'jxl-tools:dispatch' : error.message}`}]};
  }
}
