// SPDX-License-Identifier: MIT
import {requireDecode} from './decode-bits.mjs';

export function canvasArea(h, region, oriented) {
  const o = oriented ? h.orientation - 1 : 0, W = h.width, H = h.height, swap = o >= 4, w = swap ? H : W, ht = swap ? W : H;
  if (region.x + region.width > w || region.y + region.height > ht) throw Object.assign(new Error(`region lies inside the picture (${w} x ${ht}).`), {code: 'JXL_OPTIONS'});
  let [x, y, cw, ch] = swap ? [region.y, region.x, region.height, region.width] : [region.x, region.y, region.width, region.height];
  if (0b11000110 >> o & 1) x = W - x - cw;
  if (0b01101100 >> o & 1) y = H - y - ch;
  return {x, y, width: cw, height: ch};
}

export const plainFrame = (f, lfFrame = false) => f.type === 0 && !f.modular && !(f.ycbcr && f.jpegUpsampling.some(Boolean)) && f.upsampling === 1 &&
  !f.lfLevel && (lfFrame || !f.useLFFrame) && !(f.flags & 19n) && f.encodedWidth === f.width && f.encodedHeight === f.height;

export const misses = (f, area) => f.x0 >= area.x + area.width || f.y0 >= area.y + area.height || f.x0 + f.width <= area.x || f.y0 + f.height <= area.y;

export function emptyFrame(h, f) {
  const colors = !h.xyb && f.modular ? f.encodedColorChannels : 3;
  return {width: 0, height: 0, widths: Array(colors).fill(0), heights: Array(colors).fill(0), planes: Array.from({length: colors}, () => new Float32Array(0)),
    extraChannels: h.extraChannels.map(e => ({...e, width: 0, height: 0, data: new Float32Array(0)})), x0: f.x0, y0: f.y0, features: {}, filtersApplied: true};
}

export function cropFrame(frame, region) {
  if (!frame) return frame;
  const {x, y, width, height} = region, cut = (data, stride, channels) => {
    if (!data || !data.length) return data;
    const out = new data.constructor(width * height * channels);
    for (let row = 0; row < height; row++) out.set(data.subarray(((y + row) * stride + x) * channels, ((y + row) * stride + x + width) * channels), row * width * channels);
    return out;
  };
  return {...frame, width, height, data: cut(frame.data, frame.width, 4), planes: frame.planes.map(p => cut(p, frame.width, 1)),
    extraChannels: frame.extraChannels.map(e => {
      requireDecode(e.width === frame.width && e.height === frame.height, 'JPEG XL extra channel does not cover the picture.');
      return {...e, width, height, data: cut(e.data, frame.width, 1)};
    })};
}
