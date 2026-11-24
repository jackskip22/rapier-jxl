// SPDX-License-Identifier: MIT
import {shownEntry} from './entry-name.mjs';
import {isVideo, videoFrame} from './video.mjs';
import {SNAPSHOTS, withCost, HANDED, dimensions as ownDimensions, measure} from './ownership.mjs';
import {readWebGL, readWebGLNow} from './webgl-read.mjs';
import {isPlainRecord} from './records.mjs';
import {DESCRIPTION, refuseDescription, isDecoded} from './describe.mjs';
import {encodeFidelity, encodeEffort, captureFidelity, progressiveSetting} from './fidelity.mjs';
import {fail, object, dimensions, pixelLimit, webgpuSetting, lostBlank, proveRead, LOST, plainView, typedName, plainCopy, callers, snapshotOptions, abortable, isBlob, gpuDrawn, unknownOption, rejectOptionSymbols} from './primitives.mjs';
import {arrayBufferBytes} from './bytes.mjs';
import {open2d, glGpuSpace, copy2d, read2d} from './canvas-2d.mjs';
import {JPEG_SOURCE, JPEG_SOURCE_WIRE} from './jpeg-choice-policy.mjs';
import {replyPreview, clearPreviewReply} from './preview-relay.mjs';
import {outputSides} from './preparation-sides.mjs';

const isFn = v => typeof v === 'function', isObj = v => !!v && typeof v === 'object', isInt = Number.isSafeInteger, noop = () => {};
const isTextureInput = v => isPlainRecord(v) && v.texture !== undefined && v.device !== undefined && v.data === undefined;
const isRowSource = v => isPlainRecord(v) && isFn(v.rows) && v.data === undefined;
const sized = (w, h) => isInt(w) && isInt(h) && w > 0 && h > 0;
const isSpace = s => s === 'srgb' || s === 'display-p3';
const STILL_FIELDS = /* @__PURE__ */ new Set(['data', 'width', 'height', ...DESCRIPTION]);
const ANIM_FIELDS = /* @__PURE__ */ new Set(['width', 'height', 'frames', 'loops', ...DESCRIPTION]);
const ROW_FIELDS = /* @__PURE__ */ new Set(['width', 'height', 'rows', ...DESCRIPTION]);
const ENCODE_KEYS = /* @__PURE__ */ new Set(['fidelity', 'effort', 'progressive', 'firstRegion', 'readAs', 'jpeg', 'webgpu', 'maxPixels', 'signal', 'onProgress', 'onPreview']);
const CAP_KEYS = /* @__PURE__ */ new Set(['fidelity', 'effort', 'readAs', 'maxPixels', 'signal', 'onProgress', 'onPreview']);

export let bitmapClones;
export const bitmapCloneCheck = /* @__PURE__ */ (() => !isFn(globalThis.createImageBitmap) || !isFn(globalThis.ImageData) || !isFn(globalThis.MessageChannel)
  ? (bitmapClones = true, Promise.resolve(true))
  : createImageBitmap(new ImageData(1, 1)).then(bm => {
      const ch = new MessageChannel();
      try { ch.port1.postMessage(bm); bitmapClones = true; }
      catch { bitmapClones = false; }
      finally { for (const x of [bm, ch.port1, ch.port2]) { try { x.close(); } catch {} } }
      return bitmapClones;
    }, () => (bitmapClones = false)).catch(() => (bitmapClones = false)))();

export const doorPreviews = /* @__PURE__ */ Object.freeze({
  ops: new Set(['encode', 'capture', 'fit', 'variants']),
  clear: clearPreviewReply,
  handle(j, data, onCancel, ack) {
    if (!j.v || j.d) return;
    replyPreview(j, data.preview, data.previewSequence, val => {
      if (j.d) return;
      const fn = j.v;
      try { return j.z = Promise.resolve(fn?.(val)).catch(onCancel); }
      catch (r) { onCancel(r); }
    }, ack);
  },
});

export const variantsResult = check => (v, op) => op === 'variants' ? Array.isArray(v) && v.length > 0 && v.every(check) : check(v);
export const jpegSourceKeys = /* @__PURE__ */ Object.freeze({inKey: JPEG_SOURCE, wireKey: JPEG_SOURCE_WIRE});

function checkReadAs(v) {
  if (v !== undefined && !isSpace(v)) throw fail('JXL_OPTIONS', "readAs: srgb|display-p3");
}

const optLimit = opt => opt.maxPixels !== undefined ? pixelLimit(opt.maxPixels) : undefined;

function admitDoorObject(value) {
  const opt = object(value);
  rejectOptionSymbols(opt);
  if ('features' in opt) throw fail('JXL_OPTIONS', 'unknown option: features');
  return opt;
}

export function admitEncodeDoor(value, ten = false) {
  const opt = admitDoorObject(value);
  refuseDescription(opt);
  for (const k of Object.keys(opt)) if (!ENCODE_KEYS.has(k)) throw unknownOption(k, opt);
  const {effort: requestedEffort = ten ? 10 : 7} = opt;
  const fid = encodeFidelity(opt.fidelity), effort = encodeEffort(requestedEffort, fid, ten);
  checkReadAs(opt.readAs);
  if (opt.jpeg !== undefined && opt.jpeg !== 'pixels') throw fail('JXL_OPTIONS', "jpeg: pixels or omit");
  progressiveSetting(opt.progressive, fid);
  webgpuSetting(opt.webgpu);
  return {effort, target: fid.target !== undefined, maxPixels: optLimit(opt)};
}

export function admitUploadDoor(value) {
  const opt = object(value);
  const {effort = 3} = opt;
  if ('webgpu' in opt) throw fail('JXL_OPTIONS', 'unknown option: webgpu');
  if (effort === 10) throw fail('JXL_OPTIONS', "effort 10: import {encode} from 'jpegxl/max'");
  const res = admitEncodeDoor({...opt, effort});
  if (res.effort > 3) throw fail('JXL_UNSUPPORTED', "effort 4-9: use jpegxl");
  if (res.target) throw fail('JXL_OPTIONS', "measured fidelity: use jpegxl");
  if (opt.firstRegion !== undefined) throw fail('JXL_UNSUPPORTED', "firstRegion: use jpegxl");
  return res;
}

export function admitFitDoor(value, checkEnc = admitEncodeDoor) {
  const opt = object(value);
  rejectOptionSymbols(opt);
  const {maxBytes, fidelity = {quality: 90}, ...encode} = opt;
  if (!isInt(maxBytes) || maxBytes < 1) throw fail('JXL_OPTIONS', "maxBytes: positive safe integer");
  let maxQ = 100;
  if (fidelity !== 'exact') {
    const keys = isObj(fidelity) && !Array.isArray(fidelity) && Object.keys(fidelity);
    const q = fidelity?.quality, r = typeof q === 'number' ? {min: 1, max: q} : q;
    if (!keys || keys.length !== 1 || keys[0] !== 'quality' || !isObj(r) || Array.isArray(r) ||
        Object.keys(r).length !== 2 || !Object.hasOwn(r, 'min') || !Object.hasOwn(r, 'max'))
      throw fail('JXL_OPTIONS', "fidelity: exact|{quality:max}|{quality:{min,max}}");
    if (!Number.isFinite(r.min) || !Number.isFinite(r.max) || r.min < 1 || r.max > 100 || r.min > r.max)
      throw fail('JXL_OPTIONS', "quality: 1<=min<=max<=100");
    maxQ = r.max;
  }
  return checkEnc({...encode, fidelity: {quality: maxQ}}).maxPixels;
}

export function admitVariantsDoor(value, currentMax, checkEnc = admitEncodeDoor) {
  const opt = object(value);
  rejectOptionSymbols(opt);
  const {outputs, ...shared} = opt;
  const limit = checkEnc(shared).maxPixels, bound = limit !== undefined ? Math.min(currentMax, limit) : currentMax;
  if (!Array.isArray(outputs) || !outputs.length) throw fail('JXL_OPTIONS', "outputs: nonempty array");
  for (const out of outputs) {
    const outObj = object(out, 'An output');
    rejectOptionSymbols(outObj, 'output option');
    const {width, height, upscale, firstRegion, ...settings} = outObj;
    outputSides(width, height, bound);
    if (upscale !== undefined && typeof upscale !== 'boolean') throw fail('JXL_OPTIONS', 'upscale: boolean');
    for (const k of Object.keys(settings)) if (k !== 'fidelity' && k !== 'effort' && k !== 'progressive' && k !== 'jpeg' && k !== 'maxBytes')
      throw unknownOption(k, settings);
    const merged = {...shared, ...settings, ...(firstRegion !== undefined && {firstRegion})};
    if (settings.maxBytes !== undefined) admitFitDoor(merged, checkEnc);
    else checkEnc(merged);
  }
  return limit;
}

export function admitCaptureDoor(value, levels) {
  const opt = admitDoorObject(value);
  if (opt.firstRegion !== undefined) throw fail('JXL_UNSUPPORTED', "firstRegion: use encode or omit");
  refuseDescription(opt);
  for (const k of Object.keys(opt)) if (!CAP_KEYS.has(k) && k !== 'exactRects' && k !== 'photoRects') throw unknownOption(k, opt);
  checkReadAs(opt.readAs);
  const lim = optLimit(opt);
  if (opt.effort !== undefined && (!Number.isInteger(opt.effort) || opt.effort < 1 || opt.effort > 9))
    throw fail('JXL_OPTIONS', opt.effort === 10 ? "effort 10: import {encode} from 'jpegxl/max'" : "effort: integer 1-9");
  if (levels && opt.effort > levels.top)
    throw fail('JXL_UNSUPPORTED', `${shownEntry(levels.module)} effort: 1-${levels.top}, or use ${levels.next}`);
  captureFidelity(opt.fidelity);
  for (const name of ['exactRects', 'photoRects']) if (opt[name] !== undefined)
    throw fail('JXL_UNSUPPORTED', `${name}: use jpegxl/capture-complete`);
  return lim;
}

export function admitPhotoCaptureDoor(opt, spec) {
  if (isObj(opt) && 'features' in opt) throw fail('JXL_OPTIONS', 'unknown option: features');
  const {signal: _s, onProgress: _p, onPreview: _v, firstRegion, ...rest} = opt ?? {};
  spec.captureAdmission(firstRegion === undefined ? rest : {...rest, features: {firstRegion}}, {module: spec.module, ...spec.captureLevels});
  return optLimit(rest);
}

export function checkFrames(input, plans) {
  const val = (rec, name) => (plans.get(rec)?.fields ?? []).find(([k]) => k === name)?.[1].value;
  const fp = plans.get(val(input, 'frames')), w = val(input, 'width'), h = val(input, 'height');
  if (fp?.kind !== 'record' || !fp.array || !sized(w, h)) return;
  for (const [, desc] of fp.fields) {
    const f = desc.value;
    let d = val(f, 'data');
    const p = plans.get(d);
    if (p?.kind === 'view' || p?.kind === 'handed') {
      try { d = new p.Type(p.buffer, p.byteOffset, p.byteLength / (p.Type.BYTES_PER_ELEMENT ?? 1)); }
      catch { throw fail('JXL_INPUT', "ArrayBuffer: detached or too small"); }
    }
    if (ArrayBuffer.isView(d) && !(d instanceof DataView) && d.length !== w * h * 4)
      throw fail('JXL_INPUT', "pixels: width*height*4 straight RGBA");
    const dur = val(f, 'duration');
    if (isObj(f) && (typeof dur !== 'number' || !Number.isFinite(dur) || dur < 0 || dur > 0xFFFFFFFF))
      throw fail('JXL_INPUT', "duration: nonnegative finite milliseconds");
  }
}

const READ_FAIL = "canvas: redraw or RGBA";
const canvasReadFail = cause => { throw Object.assign(fail('JXL_INPUT', READ_FAIL), {cause}); };

function readOrTakeSurface(input, req, maxPixels, halfOk, maxBytes, checkShape, allowClone, banded) {
  const canvas = isFn(input?.getContext), frame = isFn(globalThis.VideoFrame) && input instanceof VideoFrame;
  const bitmap = frame || isFn(globalThis.ImageBitmap) && input instanceof ImageBitmap;
  if (!canvas && !bitmap) return null;
  const {width, height} = frame ? {width: input.displayWidth, height: input.displayHeight} : input;
  const over = !!banded && !bitmap && width * height > 40000000 && width * height * 4 > maxBytes;
  dimensions(width, height, maxPixels);
  const admit = b => {
    checkShape?.({width, height, byteLength: b});
    if (b > maxBytes) throw fail('JXL_MEMORY', "maxPendingBytes: raise or smaller image");
  };
  if (!over) admit(width * height * 4);
  let ctx = canvas ? open2d(input, "canvas: OffscreenCanvas or RGBA") : null;
  const attributes = ctx?.getContextAttributes?.(), half = halfOk && attributes?.colorType === 'float16';
  if (!over && half) admit(width * height * 8);
  checkReadAs(req);
  if (allowClone) {
    bitmapCloneCheck;
    if ((over ? !!ctx : bitmapClones === true && isFn(globalThis.createImageBitmap) && !half && (!ctx || attributes?.alpha === false))) {
      const lostAtStart = !!ctx?.isContextLost?.();
      if (lostAtStart && !over && lostBlank(ctx, ctx.getImageData(0, 0, width, height).data)) throw fail('JXL_INPUT', LOST);
      proveRead(ctx);
      const own = bitmap ? 'srgb' : ctx ? ctx.getContextAttributes?.().colorSpace ?? 'srgb' : glGpuSpace(input, "canvas: context lost, redraw", "canvas: 2D|WebGL|WebGPU context");
      if (isSpace(own)) {
        if (over) return {banded: banded(input, width, height, own, req, ctx, lostAtStart)};
        const cost = width * height * 4, px = !bitmap && !ctx && (req === undefined || req === own) ? readWebGL(input)?.then(read => (gpuDrawn(read.data), read)) : null;
        if (px) return {handed: {t: px, c: cost}};
        if (frame) return {handed: {t: Promise.resolve(withCost(input.clone(), cost)), c: cost, r: req ?? own}};
        try { return {handed: {t: createImageBitmap(input).then(m => withCost(m, cost), canvasReadFail), c: cost, r: req ?? own}}; }
        catch (cause) { canvasReadFail(cause); }
      }
    }
  }
  let copied;
  const copy = (from, sp) => copy2d(from, width, height, sp, c => { copied = c; });
  try {
    const target = bitmap ? copy(input, req ?? 'srgb').canvas : input;
    ctx ??= open2d(target, "canvas: OffscreenCanvas or RGBA");
    if (!ctx) {
      const own = glGpuSpace(target, "canvas: context lost, redraw", "canvas: 2D|WebGL|WebGPU context");
      const direct = req === undefined || req === own ? readWebGLNow(target) : null;
      if (direct) { gpuDrawn(direct.data); withCost(direct.data, direct.data.byteLength); return {pixels: direct}; }
      const read = read2d(copy(target, req ?? own).drawn, width, height, req, half, READ_FAIL);
      gpuDrawn(read.data);
      return {pixels: read};
    }
    return {pixels: read2d(ctx, width, height, req, half, READ_FAIL)};
  } finally { if (copied) copied.width = copied.height = 0; }
}

export function bandedCanvas(input, width, height, own, readAs, ctx, lostAtStart) {
  let colorSpace;
  try { colorSpace = ctx.getImageData(0, 0, 1, 1, {colorSpace: readAs ?? own}).colorSpace ?? 'srgb'; }
  catch (cause) { canvasReadFail(cause); }
  let read = false;
  return {width, height, colorSpace, rows: (y, count) => {
    const band = new OffscreenCanvas(width, count);
    try {
      const drawn = band.getContext('2d', {willReadFrequently: true, colorSpace: own});
      if (!drawn) throw fail('JXL_PLATFORM', 'no 2D canvas: pass RGBA pixels');
      drawn.drawImage(input, 0, y, width, count, 0, 0, width, count);
      let data;
      try { data = drawn.getImageData(0, 0, width, count, {colorSpace}).data; } catch (cause) { canvasReadFail(cause); }
      if (lostBlank(drawn, data)) throw fail('JXL_INPUT', LOST);
      for (let i = 3; i < data.length; i += 4) if (data[i] !== 255 && data[i] !== 0) { data = ctx.getImageData(0, y, width, count, {colorSpace}).data; break; }
      if (lostBlank(ctx, data)) { if (!lostAtStart || !read && y + count >= height) throw fail('JXL_INPUT', LOST); }
      else read = true;
      return {data};
    } finally { band.width = band.height = 0; }
  }};
}

function openRowBridge(input, maxPixels) {
  for (const k of Object.keys(input)) if (!ROW_FIELDS.has(k)) throw fail('JXL_INPUT', `unknown field: ${k}`);
  dimensions(input.width, input.height, maxPixels);
  if (input.orientation !== undefined || input.extraChannels !== undefined)
    throw fail('JXL_UNSUPPORTED', 'row source: no orientation/extra channels');
  const desc = {};
  for (const k of DESCRIPTION) if (input[k] !== undefined) desc[k] = input[k];
  const {port1, port2} = new MessageChannel();
  let closed = false, reject;
  const refused = new Promise((_, no) => { reject = no; });
  refused.catch(noop);
  const close = () => { closed = true; port1.close(); };
  port1.onmessage = async ({data: {y, count}}) => {
    if (closed) return;
    try {
      let band;
      try { band = await abortable(input.rows(y, count), undefined, v => { if (isFn(globalThis.VideoFrame) && v instanceof VideoFrame) v.close(); }); }
      catch (e) { throw callers(e); }
      let out;
      if (isPlainRecord(band)) {
        const snap = snapshotOptions(band, 'The row band', ['data']);
        if (Object.keys(snap).some(k => k !== 'data')) throw fail('JXL_INPUT', "band: {data}, source owns size/color");
        const {data} = snap;
        if (!ArrayBuffer.isView(data) || data instanceof DataView || data.length !== input.width * count * 4)
          throw fail('JXL_INPUT', `band: ${input.width}x${count}x4 samples`);
        if (arrayBufferBytes(data.buffer) === null)
          throw fail('JXL_INPUT', data.buffer?.detached ? "band buffer: detached or too small" : "shared buffer: copy to ArrayBuffer");
        try { out = plainCopy(data); } catch { throw fail('JXL_INPUT', "band buffer: detached or too small"); }
      } else {
        const sp = desc.colorSpace ?? 'srgb';
        if (!isSpace(sp) || desc.icc || desc.sampleFormat || desc.bitDepth || desc.transferFunction)
          throw fail('JXL_INPUT', 'band: 8-bit sRGB|display-p3');
        const read = readOrTakeSurface(band, sp, input.width * count, false, Number.MAX_SAFE_INTEGER, null, false, null)?.pixels;
        if (!read || read.width !== input.width || read.height !== count)
          throw fail('JXL_INPUT', `band: {data} or ${input.width}x${count} canvas/bitmap/video`);
        out = read.data;
      }
      if (!closed) port1.postMessage({data: out}, [out.buffer]);
    } catch (e) {
      if (closed) return;
      reject(e);
      let code = 'JXL_INPUT', message = "Row source failed; check its callback.";
      try { if (typeof e?.code === 'string') code = e.code; } catch {}
      try { const m = e?.message ?? e; if (m === null || typeof m !== 'object' && !isFn(m)) message = String(m); } catch {}
      port1.postMessage({error: {code, message}});
    }
  };
  return {
    record: {width: input.width, height: input.height, ...desc, rowsPort: port2},
    wait: job => Promise.race([Promise.resolve(job).finally(close), refused]),
  };
}

function checkPlainBase(input, readAs) {
  if (readAs !== undefined) throw fail('JXL_OPTIONS', "readAs: set image.colorSpace");
  if (Object.values(Object.getOwnPropertyDescriptors(input)).some(d => !('value' in d)))
    throw fail('JXL_INPUT', "queue: plain data values");
}

function checkPlainFields(input, known) {
  for (const k of Object.keys(input)) if (!known.has(k))
    throw fail('JXL_INPUT', `unknown field: ${k}; {data,width,height}, ${DESCRIPTION.join(", ")}`);
}

export function admitCapturePlain(input, readAs) {
  checkPlainBase(input, readAs);
  if (isDecoded(input)) {
    if (input.format !== 'uint8') throw fail('JXL_INPUT', "format: RGBA8");
    return input;
  }
  checkPlainFields(input, STILL_FIELDS);
  const data = ArrayBuffer.isView(input.data) && !(input.data instanceof DataView) ? plainView(input.data) : input.data;
  if (sized(input.width, input.height) && ArrayBuffer.isView(data) && !(data instanceof DataView) &&
      (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || data.length !== input.width * input.height * 4))
    throw fail('JXL_INPUT', "pixels: width*height*4 straight RGBA8");
  return data !== input.data ? {...input, data} : input;
}

export function admitEncodePlain(input, readAs) {
  checkPlainBase(input, readAs);
  if (isDecoded(input)) return input;
  const anim = Array.isArray(input.frames);
  checkPlainFields(input, anim ? ANIM_FIELDS : STILL_FIELDS);
  const hasF16 = isFn(globalThis.Float16Array);
  if (anim) {
    if (input.frames.some(f => typedName.call(f?.data) === 'Float16Array')) {
      if (input.sampleFormat !== undefined && input.sampleFormat !== 'float16') throw fail('JXL_INPUT', "sampleFormat: float16");
      if (!input.frames.every(f => typedName.call(f?.data) === 'Float16Array')) throw fail('JXL_INPUT', "frames: same sample array type");
      return {...input, frames: input.frames.map(f => ({...f, data: new Uint16Array(f.data.buffer, f.data.byteOffset, f.data.length)})), sampleFormat: 'float16'};
    }
    return input;
  }
  const given = plainView(input.data), halves = hasF16 && given instanceof Float16Array;
  if (halves && input.sampleFormat !== undefined && input.sampleFormat !== 'float16') throw fail('JXL_INPUT', "sampleFormat: float16");
  const data = halves ? new Uint16Array(given.buffer, given.byteOffset, given.length) : given;
  if (sized(input.width, input.height) && ArrayBuffer.isView(data) && !(data instanceof DataView)) {
    const n = input.width * input.height;
    const packedOk = (data instanceof Float32Array || (halves || input.sampleFormat === 'float16') && data instanceof Uint16Array) && data.length === n * 3;
    if (data.length !== n * 4 && !packedOk)
      throw fail('JXL_INPUT', "pixels: width*height*4 straight RGBA");
  }
  return halves || data !== input.data ? {...input, data, ...(halves && {sampleFormat: 'float16'})} : input;
}

function fix(opt) {
  if (!isObj(opt)) return opt;
  const {signal, onProgress, onPreview, ...data} = opt;
  return {...structuredClone(data), ...(signal !== undefined && {signal}), ...(onProgress !== undefined && {onProgress}), ...(onPreview !== undefined && {onPreview})};
}

function admitSurface(q, shape, opt) {
  let bytes = 0;
  if (shape) {
    const {width, height, byteLength = width * height * 4, colorSpace = 'display-p3'} = shape;
    ownDimensions({width, height}, q.maxPixels);
    if (!isInt(byteLength) || byteLength < 1) throw fail('JXL_INPUT', "image bytes: nonempty RGBA");
    bytes = byteLength + 8 + measure({width, height, colorSpace}, q.maxPixels);
  }
  q.admit(opt, bytes);
}

function submitAcquired(q, op, acquire, cost, opt, area = cost / 4) {
  return q.submit(op, withCost({}, cost), opt, (j, done, reserve) => {
    let yes, no;
    j.q = new Promise((y, n) => { yes = y; no = n; })
      .then(v => { j.k = v; }, r => { j.e = r ?? fail('JXL_INPUT', READ_FAIL); })
      .then(() => { j.q = null; if (j.d) { try { j.k?.close?.(); } catch {} j.k = null; } done(); });
    try { yes(isFn(acquire) ? acquire(j.c, reserve) : acquire); } catch (r) { no(r); }
  }, op === 'encode' ? area : 0);
}

export function surfaceCall(door, name, rules) {
  if (door.inPlace) return door.call(name);
  const cap = name === 'capture', prep = name === 'fit' || name === 'variants', jk = rules.jpeg;
  const plainFn = cap ? rules.capPlain : rules.plain;
  const run = (input, given) => {
    try {
      const q = door.queue();
      let opt = given, transfer = false, jpegSrc;
      if (isObj(given)) {
        let desc, proto;
        try { desc = Object.getOwnPropertyDescriptors(given); proto = Object.getPrototypeOf(given); }
        catch { admitSurface(q, null, given); throw fail('JXL_OPTIONS', "options: plain data record"); }
        const tk = desc.transfer, js = jk && desc[jk.inKey];
        if (js) {
          if (!('value' in js) || cap || !ArrayBuffer.isView(input?.data))
            throw fail('JXL_OPTIONS', "jpeg: original alongside pixels");
          jpegSrc = js.value;
        }
        if (tk || js) {
          if (tk && (!('value' in tk) || tk.value !== true)) throw fail('JXL_OPTIONS', "transfer: true or omit");
          transfer = !!tk; opt = Object.create(proto);
          for (const k of Reflect.ownKeys(desc)) if (k !== 'transfer' && (!jk || k !== jk.inKey)) Object.defineProperty(opt, k, desc[k]);
        }
      }
      admitSurface(q, null, opt);
      const lim = rules.admit(name, opt, q.maxPixels);
      const maxPixels = lim !== undefined ? Math.min(q.maxPixels, lim) : q.maxPixels;
      const fixed = prep ? {...fix(opt), maxPixels} : fix(opt);
      const taking = rules.video?.(input, fixed, maxPixels);
      if (taking) {
        const job = submitAcquired(q, name, taking.take, taking.cost, taking.options, 0), settled = taking.settle ? taking.settle(job) : job;
        return taking.finish ? settled.then(taking.finish) : settled;
      }
      if (isVideo(input)) { const f = videoFrame(input); try { return run(f, fixed); } finally { f.close(); } }
      if (isTextureInput(input)) {
        if (!isFn(rules.texture)) throw fail('JXL_UNSUPPORTED', `texture: use ${rules.texture}`);
        if (fixed?.readAs !== undefined) throw fail('JXL_OPTIONS', "readAs: set texture.colorSpace");
        return rules.texture(input, maxPixels, (take, cost, area) => submitAcquired(q, name, take, cost, fixed, area));
      }
      if (isRowSource(input)) {
        if (prep) throw fail('JXL_UNSUPPORTED', 'row source: encode directly');
        if (opt?.readAs !== undefined) throw fail('JXL_OPTIONS', "readAs: set source.colorSpace");
        const br = openRowBridge(input, maxPixels);
        return br.wait(q.submit(name, withCost(br.record, 64), fixed));
      }
      const half = prep || name === 'encode' && !rules.upload;
      const checkShape = s => admitSurface(q, s, opt);
      let px;
      if (isFn(globalThis.ImageData) && input instanceof ImageData) {
        if (opt?.readAs !== undefined) throw fail('JXL_OPTIONS', "readAs: set image.colorSpace");
        const {data, width, height, colorSpace = 'srgb'} = input;
        dimensions(width, height, maxPixels);
        checkShape({width, height, byteLength: data.byteLength, colorSpace});
        px = !cap && isFn(globalThis.Float16Array) && data instanceof Float16Array
          ? {data: new Uint16Array(data.buffer, data.byteOffset, data.length), width, height, colorSpace, sampleFormat: 'float16'}
          : {data, width, height, colorSpace};
      } else if (isPlainRecord(input)) {
        px = plainFn(input, opt?.readAs);
      } else {
        const surf = readOrTakeSurface(input, opt?.readAs, maxPixels, half, q.maxPendingBytes, checkShape, true, cap && rules.banded);
        if (surf?.banded) { const {readAs: _r, ...rest} = fixed ?? {}; return run(surf.banded, rest); }
        if (surf?.handed) {
          const h = surf.handed, job = submitAcquired(q, name, h.t, h.c, h.r === undefined ? fixed : {...fixed, readAs: h.r});
          job.then(noop, noop).then(() => h.t).then(t => { try { t?.close?.(); } catch {} }, noop);
          return job;
        }
        px = surf?.pixels ?? input;
      }
      if (prep && ArrayBuffer.isView(px?.data)) dimensions(px.width, px.height, maxPixels);
      const blob = isBlob(px);
      const fwd = prep || cap && rules.richCapture ? fixed : opt;
      const {readAs: _r, ...forward} = fwd ?? {};
      const moving = !transfer ? [] : ArrayBuffer.isView(px?.data) ? [px.data]
        : !cap && Array.isArray(px?.frames) ? px.frames.map(f => f?.data).filter(d => ArrayBuffer.isView(d)) : [];
      for (const d of moving) HANDED.add(d);
      const queued = blob || fwd === undefined ? fwd : forward;
      const area = name === 'encode' && SNAPSHOTS.has(px) ? SNAPSHOTS.get(px) / 4 : 0;
      try { return q.submit(name, px, jpegSrc === undefined ? queued : {...queued, [jk.wireKey]: jpegSrc}, null, area); }
      finally { for (const d of moving) HANDED.delete(d); }
    } catch (e) { return Promise.reject(e); }
  };
  return run;
}
