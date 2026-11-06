// SPDX-License-Identifier: MIT
import {kernelHooks} from './kernel-hooks.mjs';

const PACKED_BYTES = 2 << 20, FRAMES = 32, FAMILIES = 128, RESULTS = 512;
const STOP = {}, closedError = () => new Error('Photo score memo is destroyed.');
const color = value => value === 'srgb' ? 0 : value === 'display-p3' ? 1 : NaN;
const numberList = (values, put) => { put(values?.length ?? -1); if (values) for (const value of values) put(value); };
function rectangles(rects, put, quality = false) {
  put(rects?.length ?? -1);
  if (rects) for (const r of rects) {
    put(r.x); put(r.y); put(r.width); put(r.height); if (quality) put(r.quality);
  }
}
function pieces(rects, put, masked) {
  put(rects.length);
  for (const r of rects) {
    put(r.x); put(r.y); put(r.w); put(r.h);
    if (masked) numberList(r.mask, put);
  }
}
function parameters(p, put) {
  for (const value of [p.sourceWidth, p.sourceHeight, p.width, p.height, p.x, p.y, p.quality, color(p.colorSpace), +p.mask, +p.alpha]) put(value);
  rectangles(p.areas, put, true); rectangles(p.crops, put);
}
function matches(key, walk, end = key?.length) {
  if (!key) return false;
  let at = 0;
  try { walk(value => { if (at >= end || !Object.is(key[at++], value)) throw STOP; }); }
  catch (error) { if (error !== STOP) throw error; return false; }
  return at === end;
}
function lengthOf(walk, remaining) {
  let length = 0;
  try { walk(value => { if (!Number.isFinite(value) || ++length * 8 > remaining) throw STOP; }); }
  catch (error) { if (error !== STOP) throw error; return null; }
  return length;
}
function packed(walk, length) {
  const result = new Float64Array(length); let at = 0;
  walk(value => { result[at++] = value; }); return result;
}
const sameFields = (saved, fields) => saved.length === fields.length && saved.every((value, i) => value === fields[i]);
const copyScore = saved => ({ssimulacra2: saved[0], nativeScores: {package: saved[1], native: saved[2], minimum: saved[3]}});

function fixedDct8(image, width, height) {
  if (!image || image.width !== width || image.height !== height || image.ycbcr !== false || image.cflBase !== 1
      || image.orientation !== 1 || image.quantScale !== 256 || image.alpha || image.epf !== undefined || image.epfIterations !== undefined
      || image.gaborish !== undefined || image.lazyStrategy || !image.strategyData || image.components?.length !== 3) return false;
  const stride = Math.ceil(width / 8), rows = Math.ceil(height / 8), n = stride * rows;
  if (!(image.quantFields instanceof Uint16Array) || image.quantFields.length !== n
      || image.components.some(c => c.h !== 1 || c.v !== 1 || c.stride !== stride || c.rows !== rows || c.quant?.length !== 64 || c.dc?.length !== n)) return false;
  const blocks = image.strategyData.blocks, tables = image.strategyData.tables;
  if (blocks.length !== n || !Array.isArray(tables) || tables.length !== 17 || !tables[0]) return false;
  for (let i = 1; i < tables.length; i++) if (tables[i]) return false;
  const table = tables[0], order = blocks[0]?.order;
  if (table.w !== 8 || table.h !== 8 || table.parameters || table.planes?.length !== 3
      || table.planes.some(p => p.length !== 64) || order?.length !== 64) return false;
  let at = 0;
  for (let gy = 0; gy < rows; gy += 32) for (let gx = 0; gx < stride; gx += 32)
    for (let by = gy; by < Math.min(rows, gy + 32); by++) for (let bx = gx; bx < Math.min(stride, gx + 32); bx++) {
      const b = blocks[at++];
      if (b.id !== 0 || b.bx !== bx || b.by !== by || b.bw !== 1 || b.bh !== 1 || b.area !== 1 || b.size !== 64
          || b.order.length !== 64 || b.order.some((value, i) => value !== order[i])) return false;
    }
  return true;
}
function imageFamily(image, deadzone, top, put) {
  for (const value of [top, image.width, image.height, image.quantScale, image.quantFieldBase, image.cflBase,
    image.orientation, color(image.colorSpace), +(image.perceptual === true)]) put(value);
  numberList(deadzone, put);
  for (const c of image.components) { numberList(c.quant, put); numberList(c.dc, put); }
  put(image.cfl.width); numberList(image.cfl.x, put); numberList(image.cfl.b, put);
  numberList(image.strategyData.blocks[0].order, put);
  for (const plane of image.strategyData.tables[0].planes) numberList(plane, put);
  put(image.quantTable?.length ?? -1);
  if (image.quantTable) for (const row of image.quantTable) numberList(row, put);
}

export function photoScoreMemo(owned) {
  let pixels = owned && !(typeof Blob === 'function' && owned instanceof Blob) && typeof owned.rows !== 'function'
    && (owned.data instanceof Uint8Array || owned.data instanceof Uint8ClampedArray) && owned.data.buffer instanceof ArrayBuffer
    && owned.data.length === owned.width * owned.height * 4 ? owned.data : null;
  const sourceWidth = owned?.width, sourceHeight = owned?.height;
  owned = null;
  let readers = new WeakMap(), bytes = 0, families = 0, results = 0, closed = false;
  const frames = [];
  const check = () => { if (closed) throw closedError(); };
  return {
    patched(source, width, height, {dx, dy, quality, colorSpace, areas, crops, masks, placedBoxes, exactPieces}, callbacks) {
      check();
      if (!pixels || !(source instanceof Uint8Array || source instanceof Uint8ClampedArray) || source.buffer !== pixels.buffer || source.byteOffset !== pixels.byteOffset || source.byteLength !== pixels.byteLength
          || width !== sourceWidth || height !== sourceHeight) return;
      const p = {sourceWidth: width, sourceHeight: height, width: width + dx, height: height + dy, x: dx || dy ? -dx : 0, y: dx || dy ? -dy : 0,
        quality, colorSpace, areas, crops, mask: false, alpha: false};
      const head = put => parameters(p, put), walk = put => { head(put); pieces(masks, put, true); pieces(placedBoxes, put, false); pieces(exactPieces, put, true); };
      let entry = frames.find(frame => matches(frame.key, walk));
      if (!entry) {
        if (frames.length >= FRAMES) return;
        const length = lengthOf(walk, PACKED_BYTES - bytes); if (length === null) return;
        entry = {key: packed(walk, length), bands: []}; frames.push(entry); bytes += length * 8;
      }
      const headLength = lengthOf(head, PACKED_BYTES);
      readers.set(callbacks.rows, {entry, headLength, referenceRows: callbacks.referenceRows, exactRows: callbacks.exactRows, project: callbacks.project});
    },
    frame(rows, width, height, options) {
      check();
      const binding = readers.get(rows), placement = options.placement ?? {}, crop = placement.crop;
      if (!binding || binding.referenceRows !== options.referenceRows || binding.exactRows !== options.exactRows || binding.project !== options.project
          || crop && (crop.width !== width || crop.height !== height)) return null;
      const p = {sourceWidth: placement.imageWidth ?? width, sourceHeight: placement.imageHeight ?? height, width, height,
        x: crop?.x ?? 0, y: crop?.y ?? 0, quality: options.quality, colorSpace: options.colorSpace, areas: options.areas,
        crops: options.photoCrops, mask: placement.mask === true, alpha: placement.alphaChannel === true};
      if (!matches(binding.entry.key, put => parameters(p, put), binding.headLength)) return null;
      const entry = binding.entry;
      return {
        band(top, w, h) {
          check();
          if (w !== width || top < 0 || top % 256 || h !== Math.min(256, height - top)) return null;
          let made = new WeakMap();
          return {
            register(image, deadzone) {
              check();
              if (deadzone?.length === 6) made.set(image, {deadzone: Float64Array.from(deadzone), kernel: kernelHooks.varblock});
            },
            score(image, want, measure) {
              check();
              const built = made.get(image);
              if (!built || want?.ssimulacra2 !== true || want?.butteraugli !== false || !fixedDct8(image, w, h)) return measure(image, want);
              const walk = put => imageFamily(image, built.deadzone, top, put);
              let family = entry.bands.find(item => item.kernel === built.kernel && matches(item.key, walk));
              const known = family?.probes.find(item => sameFields(item.fields, image.quantFields));
              if (known) return copyScore(known.score);
              const value = measure(image, want), native = value.nativeScores;
              if (!native || Object.keys(value).some(key => key !== 'ssimulacra2' && key !== 'nativeScores')
                  || Object.keys(native).some(key => !['package', 'native', 'minimum'].includes(key))
                  || ![value.ssimulacra2, native.package, native.native, native.minimum].every(Number.isFinite)
                  || !Object.is(value.ssimulacra2, native.minimum) || results >= RESULTS) return value;
              const fieldBytes = image.quantFields.byteLength;
              if (!family) {
                if (families >= FAMILIES) return value;
                const length = lengthOf(walk, PACKED_BYTES - bytes - fieldBytes); if (length === null) return value;
                family = {key: packed(walk, length), kernel: built.kernel, probes: []};
                entry.bands.push(family); families++; bytes += length * 8;
              } else if (bytes + fieldBytes > PACKED_BYTES) return value;
              family.probes.push({fields: image.quantFields.slice(), score: [value.ssimulacra2, native.package, native.native, native.minimum]});
              bytes += fieldBytes; results++; return value;
            },
            release() { made = new WeakMap(); },
          };
        },
      };
    },
    destroy() {
      closed = true; pixels = null; readers = new WeakMap();
      for (const frame of frames) { frame.key = null; for (const band of frame.bands) { band.key = null; band.probes.length = 0; } frame.bands.length = 0; }
      frames.length = 0; bytes = 0; families = 0; results = 0;
    },
  };
}
