// Rapier's JPEG XL encoder: the Squeeze transform. MIT (LICENSE).
// The forward of the specification's Squeeze (libjxl's enc_squeeze): each step halves a channel into averages and
// residuals minus a smooth tendency; the decoder's default parameter list is regenerated here step for step,
// so the bitstream names no parameters (`num_squeezes` 0) and the channel order is the decoder's.

const average = (a, b) => (a + b + (a > b ? 1 : 0)) >> 1;

export function smoothTendency(B, a, n) {
  let diff = 0;
  if (B >= a && a >= n) {
    diff = ((4 * B - 3 * n - a + 6) / 12) | 0;
    if (diff - (diff & 1) > 2 * (B - a)) diff = 2 * (B - a) + 1;
    if (diff + (diff & 1) > 2 * (a - n)) diff = 2 * (a - n);
  } else if (B <= a && a <= n) {
    diff = ((4 * B - 3 * n - a - 6) / 12) | 0;
    if (diff + (diff & 1) < 2 * (B - a)) diff = 2 * (B - a) - 1;
    if (diff - (diff & 1) < 2 * (a - n)) diff = 2 * (a - n);
  }
  return diff;
}

// A channel: {w, h, hshift, vshift, data: Int32Array}.
function squeezeH(ch) {
  const w = ch.w, h = ch.h, ow = (w + 1) >> 1, rw = w - ow;
  const out = new Int16Array(ow * h), res = new Int16Array(rw * h), p = ch.data;
  for (let y = 0; y < h; y++) {
    const row = y * w, orow = y * ow, rrow = y * rw;
    for (let x = 0; x < rw; x++) {
      const A = p[row + 2 * x], B = p[row + 2 * x + 1], avg = average(A, B);
      out[orow + x] = avg;
      let next = avg;
      if (x + 1 < rw) next = average(p[row + 2 * x + 2], p[row + 2 * x + 3]);
      else if (w & 1) next = p[row + 2 * x + 2];
      const left = x > 0 ? p[row + 2 * x - 1] : avg;
      res[rrow + x] = A - B - smoothTendency(left, avg, next);
    }
    if (w & 1) out[orow + ow - 1] = p[row + w - 1];
  }
  return [{w: ow, h, hshift: ch.hshift + 1, vshift: ch.vshift, data: out}, {w: rw, h, hshift: ch.hshift + 1, vshift: ch.vshift, data: res}];
}

function squeezeV(ch) {
  const w = ch.w, h = ch.h, oh = (h + 1) >> 1, rh = h - oh;
  const out = new Int16Array(w * oh), res = new Int16Array(w * rh), p = ch.data;
  for (let y = 0; y < rh; y++) {
    const row = 2 * y * w;
    for (let x = 0; x < w; x++) {
      const A = p[row + x], B = p[row + w + x], avg = average(A, B);
      out[y * w + x] = avg;
      let next = avg;
      if (y + 1 < rh) next = average(p[row + 2 * w + x], p[row + 3 * w + x]);
      else if (h & 1) next = p[row + 2 * w + x];
      const top = y > 0 ? p[row - w + x] : avg;
      res[y * w + x] = A - B - smoothTendency(top, avg, next);
    }
  }
  if (h & 1) { const y = oh - 1; for (let x = 0; x < w; x++) out[y * w + x] = p[2 * y * w + x]; }
  return [{w, h: oh, hshift: ch.hshift, vshift: ch.vshift + 1, data: out}, {w, h: rh, hshift: ch.hshift, vshift: ch.vshift + 1, data: res}];
}

// The decoder's default parameters for an image whose channels all start at full size.
export function defaultSqueezeParams(channels) {
  const params = [], n = channels.length;
  let w = channels[0].w, h = channels[0].h;
  if (n > 2 && channels[1].w === w && channels[1].h === h) {
    params.push({horizontal: true, inPlace: false, beginC: 1, numC: 2});
    params.push({horizontal: false, inPlace: false, beginC: 1, numC: 2});
  }
  const wide = w > h;
  if (!wide && h > 8) { params.push({horizontal: false, inPlace: true, beginC: 0, numC: n}); h = (h + 1) >> 1; }
  while (w > 8 || h > 8) {
    if (w > 8) { params.push({horizontal: true, inPlace: true, beginC: 0, numC: n}); w = (w + 1) >> 1; }
    if (h > 8) { params.push({horizontal: false, inPlace: true, beginC: 0, numC: n}); h = (h + 1) >> 1; }
  }
  return params;
}

// Applies the parameters in order, returning the new channel list (the decoder's order) and, per channel, the
// squeeze `level` (steps taken) and whether it holds residuals.
export function forwardSqueeze(channels, params = defaultSqueezeParams(channels)) {
  const list = channels.map(ch => ({...ch, level: 0, residual: false}));
  for (const p of params) {
    const endC = p.beginC + p.numC - 1, offset = p.inPlace ? endC + 1 : list.length;
    for (let c = p.beginC; c <= endC; c++) {
      const [low, res] = (p.horizontal ? squeezeH : squeezeV)(list[c]);
      const level = list[c].level + 1;
      list[c] = {...low, level, residual: list[c].residual, component: list[c].component};
      list.splice(offset + (c - p.beginC), 0, {...res, level, residual: true, component: list[c].component});
    }
  }
  return list;
}
