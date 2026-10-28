// Rapier's JPEG XL encoder: the Squeeze transform. MIT (images/jxl/LICENSE).

const average = (a, b) => (a + b + (a > b ? 1 : 0)) >> 1;

export function smoothTendency(B, a, n) {
  const sign = B >= a && a >= n ? 1 : B <= a && a <= n ? -1 : 0;
  if (!sign) return 0;
  B *= sign; a *= sign; n *= sign;
  let diff = ((4 * B - 3 * n - a + 6) / 12) | 0;
  if (diff - (diff & 1) > 2 * (B - a)) diff = 2 * (B - a) + 1;
  if (diff + (diff & 1) > 2 * (a - n)) diff = 2 * (a - n);
  return sign * diff;
}

function squeeze(ch, horizontal) {
  const {w, h, data: p} = ch, n = horizontal ? w : h, low = (n + 1) >> 1, high = n - low;
  const ow = horizontal ? low : w, oh = horizontal ? h : low, rw = horizontal ? high : w, rh = horizontal ? h : high;
  const out = new Int16Array(ow * oh), res = new Int16Array(rw * rh), step = horizontal ? 1 : w;
  for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
    const pos = horizontal ? x : y, at = horizontal ? y * w + 2 * x : 2 * y * w + x;
    if (pos === high) { out[y * ow + x] = p[at]; continue; }
    const A = p[at], B = p[at + step], avg = average(A, B);
    const next = pos + 1 < high ? average(p[at + 2 * step], p[at + 3 * step]) : n & 1 ? p[at + 2 * step] : avg;
    out[y * ow + x] = avg;
    res[y * rw + x] = A - B - smoothTendency(pos ? p[at - step] : avg, avg, next);
  }
  const channel = (data, w, h) => ({w, h, hshift: ch.hshift + +horizontal, vshift: ch.vshift + !horizontal, data});
  return [channel(out, ow, oh), channel(res, rw, rh)];
}

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

export function forwardSqueeze(channels, params = defaultSqueezeParams(channels)) {
  const list = channels.map(ch => ({...ch, level: 0, residual: false}));
  for (const p of params) {
    const endC = p.beginC + p.numC - 1, offset = p.inPlace ? endC + 1 : list.length;
    for (let c = p.beginC; c <= endC; c++) {
      const [low, res] = squeeze(list[c], p.horizontal);
      const level = list[c].level + 1;
      list[c] = {...low, level, residual: list[c].residual, component: list[c].component};
      list.splice(offset + (c - p.beginC), 0, {...res, level, residual: true, component: list[c].component});
    }
  }
  return list;
}
