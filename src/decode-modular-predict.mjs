// SPDX-License-Identifier: MIT
import {RECIPROCAL, DEFAULT_WEIGHTED, weightedDivision} from './decode-modular-weights.mjs';
export {RECIPROCAL, DEFAULT_WEIGHTED, weightedDivision};

class WeightedState {
  constructor(width, parameters) {
    this.width = width;
    this.parameters = parameters;
    this.stride = width + 2;
    this.error = new Int32Array(this.stride * 2);
    this.suberror = Array.from({length: 4}, () => new Uint32Array(this.stride * 2));
    this.predictions = new Float64Array(4);
    this.weights = new Uint32Array(4);
    this.prediction = this.maximumError = 0;
  }
  prepare(s) {
    const {x, y, n, nw, ne, w, nn} = s, p = this.parameters;
    const current = y & 1 ? 0 : this.stride, previous = y & 1 ? this.stride : 0;
    const north = previous + x, northEast = x + 1 < this.width ? north + 1 : north;
    const northWest = x ? north - 1 : north;
    const eN = this.error[north], eW = x ? this.error[current + x - 1] : 0;
    const eNW = this.error[northWest], eNE = this.error[northEast];
    const a = this.predictions, weight = this.weights;
    a[0] = (w + ne - n) * 8;
    a[1] = n * 8 - Math.floor((eN + eW + eNE) * p[0] / 32);
    a[2] = w * 8 - Math.floor((eN + eW + eNW) * p[1] / 32);
    a[3] = n * 8 - Math.floor((eNW * p[2] + eN * p[3] + eNE * p[4] + (nn - n) * 8 * p[5] + (nw - w) * 8 * p[6]) / 32);
    let total = 0;
    for (let k = 0; k < 4; k++) {
      const errors = this.suberror[k], sum = (errors[north] + errors[northEast] + errors[northWest]) >>> 0;
      if (sum < 63) weight[k] = 4 + p[k + 7] * RECIPROCAL[sum + 1];
      else if (sum <= 0x7ffffffe) { const shift = 26 - Math.clz32(sum + 1); weight[k] = 4 + ((p[k + 7] * RECIPROCAL[(sum >>> shift) + 1]) >>> shift); }
      else {
        let scale = 1, size = sum + 1;
        while (size >= 64) { size = Math.floor(size / 2); scale *= 2; }
        weight[k] = 4 + Math.floor(p[k + 7] * RECIPROCAL[Math.floor(sum / scale) + 1] / scale);
      }
      total += weight[k];
    }
    const shift = 27 - Math.clz32(total);
    total = 0;
    for (let k = 0; k < 4; k++) { weight[k] >>>= shift; total += weight[k]; }
    let sum = (total >> 1) - 1;
    for (let k = 0; k < 4; k++) sum += a[k] * weight[k];
    let prediction = weightedDivision(sum, RECIPROCAL[total]);
    if (((eN ^ eW) | (eN ^ eNW)) <= 0) prediction = Math.max(Math.min(n, w, ne) * 8, Math.min(Math.max(n, w, ne) * 8, prediction));
    let maximum = eW;
    if (Math.abs(eN) > Math.abs(maximum)) maximum = eN;
    if (Math.abs(eNW) > Math.abs(maximum)) maximum = eNW;
    if (Math.abs(eNE) > Math.abs(maximum)) maximum = eNE;
    this.prediction = prediction;
    this.maximumError = maximum;
    this.current = current + x;
    this.previousEast = previous + x + 1;
  }
  record(value) {
    const v = value * 8;
    this.error[this.current] = this.prediction - v;
    for (let k = 0; k < 4; k++) {
      const error = Math.floor((Math.abs(this.predictions[k] - v) + 3) / 8), values = this.suberror[k];
      values[this.current] = error;
      values[this.previousEast] += error;
    }
  }
}

export class ModularPrediction {
  constructor(channel, {weighted = false, parameters = DEFAULT_WEIGHTED, previous = [], channelIndex = 0, streamIndex = 0} = {}) {
    this.data = channel.data;
    this.width = channel.width;
    this.height = channel.height;
    this.previous = previous;
    this.channelIndex = channelIndex;
    this.streamIndex = streamIndex;
    this.weighted = weighted ? new WeightedState(channel.width, parameters) : null;
    this.x = this.y = this.index = this.previousGradient = 0;
    this.properties = new Int32Array(16);
  }
  prepare() {
    const {x, y, index: i, width: width, data: d} = this;
    const w = x ? d[i - 1] : y ? d[i - width] : 0;
    const n = y ? d[i - width] : w;
    const nw = x && y ? d[i - width - 1] : w;
    const ne = y && x + 1 < width ? d[i - width + 1] : n;
    this.w = w; this.n = n; this.nw = nw; this.ne = ne;
    this.nn = y > 1 ? d[i - width * 2] : n;
    this.ww = x > 1 ? d[i - 2] : w;
    this.nee = y && x + 2 < width ? d[i - width + 2] : ne;
    this.weighted?.prepare(this);
    const p = this.properties;
    p[0] = this.channelIndex; p[1] = this.streamIndex; p[2] = y; p[3] = x;
    p[4] = Math.abs(n); p[5] = Math.abs(w); p[6] = n; p[7] = w;
    p[8] = w - this.previousGradient; p[9] = w + n - nw; p[10] = w - nw;
    p[11] = nw - n; p[12] = n - ne; p[13] = n - this.nn; p[14] = w - this.ww;
    p[15] = this.weighted?.maximumError ?? 0;
  }
  property(id) {
    if (id < 16) return this.properties[id];
    const offset = id - 16, channel = this.previous[Math.floor(offset / 4)];
    if (!channel) return 0;
    const kind = offset & 3, data = channel.data, value = data[this.index];
    if (kind === 0) return Math.abs(value) | 0;
    if (kind === 1) return value;
    const {x, y, index: i, width: w} = this;
    const left = x ? data[i - 1] : y ? data[i - w] : 0, top = y ? data[i - w] : left;
    const corner = x && y ? data[i - w - 1] : left;
    const prediction = Math.max(Math.min(left, top), Math.min(Math.max(left, top), left + top - corner));
    const difference = (value - prediction) | 0;
    return kind === 2 ? Math.abs(value - prediction) | 0 : difference;
  }
  predict(id) {
    const {w, n, nw, ne, nn, ww, nee} = this;
    switch (id) {
      case 0: return 0;
      case 1: return w;
      case 2: return n;
      case 3: return Math.trunc((w + n) / 2);
      case 4: return Math.abs(n - nw) < Math.abs(w - nw) ? w : n;
      case 5: return Math.max(Math.min(w, n), Math.min(Math.max(w, n), w + n - nw));
      case 6: return Math.floor((this.weighted.prediction + 3) / 8) | 0;
      case 7: return ne;
      case 8: return nw;
      case 9: return ww;
      case 10: return Math.trunc((w + nw) / 2);
      case 11: return Math.trunc((n + nw) / 2);
      case 12: return Math.trunc((n + ne) / 2);
      case 13: return Math.trunc((6 * n - 2 * nn + 7 * w + ww + nee + 3 * ne + 8) / 16);
      default: throw Object.assign(new Error('Invalid Modular predictor.'), {code: 'JXL_DECODE'});
    }
  }
  record(value) {
    this.data[this.index++] = value;
    this.weighted?.record(value);
    this.previousGradient = this.properties[9];
    if (++this.x === this.width) { this.x = 0; this.y++; this.previousGradient = 0; }
  }
}
