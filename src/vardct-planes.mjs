// SPDX-License-Identifier: MIT
import {ceilLog2} from './bits.mjs';
export const varDCTField = (value, shift) => value * shift - 1;
export function varDCTDCSpec(image, layout, channel, x, y, width, height) {
  const component = layout.comps[channel];
  const empty = component.row0 !== undefined && layout.grey && channel !== 1;
  const dc = empty ? null : component.dc;
  const source = empty || !dc && layout.grey && channel !== 1 ? null : dc ?? component.coeffs;
  return {w: width, h: height, x, y, stride: component.stride, source, step: dc ? 1 : 64,
    scale: layout.dcScale[channel], lift: layout.dcLift[channel]};
}

export function copyVarDCTDCSegment(spec, data, row, from = 0, to = spec.w, stop) {
  const {source, stride, x, y, step, scale, lift, w} = spec;
  if (!source) { data.fill(lift, row * w + from, row * w + to); if (stop) { stop.column = to; stop.wide = false; } return data; }
  if (step === 1 && source instanceof Int16Array && scale === 1 && lift === 0) {
    data.set(source.subarray((y + row) * stride + x + from, (y + row) * stride + x + to), row * w + from);
    if (stop) { stop.column = to; stop.wide = false; }
    return data;
  }
  for (let column = from; column < to; column++) {
    const value = source[((y + row) * stride + x + column) * step] * scale + lift;
    if ((value < -32768 || value > 32767) && data instanceof Int16Array) {
      if (stop) { stop.column = column; stop.wide = true; return data; }
      data = Int32Array.from(data);
    }
    data[row * w + column] = value;
  }
  if (stop) { stop.column = to; stop.wide = false; }
  return data;
}
export function copyVarDCTDCRows(spec, data, from = 0, to = spec.h) {
  for (let row = from; row < to; row++) data = copyVarDCTDCSegment(spec, data, row);
  return data;
}

export function copyVarDCTSharpness(own, stride, x0, y0, width, out, from = 0, to = out.length / width) {
  for (let y = from; y < to; y++) for (let x = 0; x < width; x++) out[y * width + x] = own[(y0 + y) * stride + x0 + x];
}
export function copyVarDCTStrategies(blocks, out, from = 0, to = blocks.length) {
  for (let i = from; i < to; i++) out[i] = blocks[i].id;
}
export function copyVarDCTStrategyFields(fields, stride, shift, blocks, out, from = 0, to = blocks.length) {
  let wide = false;
  for (let i = from; i < to; i++) {
    const block = blocks[i], value = varDCTField(fields[block.by * stride + block.bx], shift);
    out[blocks.length + i] = value;
    if (value < -32768 || value > 32767) wide = true;
  }
  return wide;
}
export function copyVarDCTFieldRows(fields, stride, shift, x0, y0, width, height, out, from = 0, to = height) {
  let wide = false;
  for (let y = from; y < to; y++) for (let x = 0; x < width; x++) {
    const value = varDCTField(fields[(y0 + y) * stride + x0 + x], shift);
    out[width * height + y * width + x] = value;
    if (value < -32768 || value > 32767) wide = true;
  }
  return wide;
}
export function copyVarDCTCorrelation(cfl, x0, y0, width, height, colors, from = 0, to = height) {
  for (let y = from; y < to; y++) for (let x = 0; x < width; x++) {
    const at = ((y0 >> 3) + y) * cfl.width + (x0 >> 3) + x;
    colors[0][y * width + x] = cfl.x[at]; colors[1][y * width + x] = cfl.b[at];
  }
}
export function copyVarDCTAlphaRows(alpha, rows, sourceWidth, x0, y0, width, out, mask, from = 0, to = out.length / width, rowsOffset = 0) {
  for (let y = from; y < to; y++) for (let x = 0; x < width; x++) {
    const value = alpha ? alpha[((y0 + y) * sourceWidth + x0 + x) * 4 + 3] :
      rows ? rows[((y - rowsOffset) * sourceWidth + x0 + x) * 4 + 3] : 255;
    out[y * width + x] = mask ? value >> 7 : value;
  }
}


export function varDCTLFGeometry(layout, group) {
  const gx = group % layout.dcGroupsX, gy = Math.floor(group / layout.dcGroupsX), x0 = gx * 256, y0 = gy * 256;
  const rw = Math.min(256, layout.xsizeBlocks - x0), rh = Math.min(256, layout.ysizeBlocks - y0);
  return {gx, gy, x0, y0, rw, rh, cw: (rw + 7) >> 3, ch: (rh + 7) >> 3, bits: ceilLog2(rw * rh)};
}
export function varDCTLFMetadataShape(image, layout, geometry, blockCount, plainMetadata) {
  return {count: blockCount ?? geometry.rw * geometry.rh,
    uniformBlocks: plainMetadata && blockCount == null && !image.quantFields,
    uniformSharpness: plainMetadata && !image.sharpness, sharpVal: layout.epf ? 7 : 0};
}

export function varDCTLFInputs(image, layout, group, blockCount, plainMetadata) {
  const geometry = varDCTLFGeometry(layout, group), shape = varDCTLFMetadataShape(image, layout, geometry, blockCount, plainMetadata);
  const {x0, y0, rw, rh, cw, ch, bits} = geometry, {count, uniformBlocks, uniformSharpness, sharpVal} = shape;
  const cfl = (image.xyb || layout.directRGB) && image.cfl || null;
  return {geometry, count, bits, field: layout.field, predictor: layout.field > 1 ? 5 : 0,
    planes: image.useDCFrame ? null : [1, 0, 2].map(c => varDCTDCSpec(image, layout, c,
      x0 >> layout.hshifts[c], y0 >> layout.vshifts[c], rw >> layout.hshifts[c], rh >> layout.vshifts[c])),
    metadata: [
      {kind: 'correlation', channel: 0, w: cw, h: ch, cfl, x0, y0},
      {kind: 'correlation', channel: 1, w: cw, h: ch, cfl, x0, y0},
      uniformBlocks ? {w: count, h: 2, rowValues: [0, layout.field - 1]} :
        {kind: 'blocks', w: count, h: 2, strategyData: image.strategyData ?? null, fields: image.quantFields ?? null, field: layout.field,
          shift: layout.shift, stride: layout.xsizeBlocks, x0, y0, rw, rh},
      uniformSharpness ? {w: rw, h: rh, rowValues: new Int16Array(rh).fill(sharpVal)} :
        {kind: 'sharpness', w: rw, h: rh, source: layout.epf ? image.sharpness ?? null : null,
          value: sharpVal, stride: layout.xsizeBlocks, x0, y0},
    ]};
}

export function varDCTLFBlockIndices(data, geometry, row, from, to, out, offset = 0) {
  const start = (geometry.y0 + row) * data.stride + geometry.x0;
  for (let x = from; x < to; x++) {
    const index = data.at[start + x];
    if (index >= 0) { if (out) out[offset] = index; offset++; }
  }
  return offset;
}

export function copyVarDCTLFBlocks(data, fields, shift, field, indices, out, count, offset, from = 0, to = indices.length) {
  let wide = false;
  for (let i = from; i < to; i++) {
    const at = indices[i] * 4, bx = data.catalog[at + 1], by = data.catalog[at + 2];
    const value = fields ? varDCTField(fields[by * data.stride + bx], shift) : field - 1;
    out[offset + i - from] = data.catalog[at]; out[count + offset + i - from] = value;
    if (value < -32768 || value > 32767) wide = true;
  }
  return wide;
}

export function copyVarDCTQuantRows(quant, data, from = 0, to = 8) {
  let wide = false;
  for (let y = from; y < to; y++) for (let x = 0; x < 8; x++) {
    const value = quant[8 * y + x]; data[8 * x + y] = value;
    if (value < -32768 || value > 32767) wide = true;
  }
  return wide;
}
