// SPDX-License-Identifier: MIT
import {fault} from './admit.mjs';

const PLANAR_SQUEEZE_POWERS = [1]; for (let i = 1; i <= 32; i++) PLANAR_SQUEEZE_POWERS.push(PLANAR_SQUEEZE_POWERS[i - 1] * 2);
const squeezeInteger = (value, minimum, maximum, name) => {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw fault('JXL_INPUT', name + ' is an integer from ' + minimum + ' through ' + maximum + '.');
  return value;
};
function squeezeShape(channel) { return {width: channel.width, height: channel.height, hshift: channel.hshift ?? channel.shift, vshift: channel.vshift ?? channel.shift}; }
function advanceSqueezeShape(list, step) {
  const offset = step.inPlace ? step.beginC + step.numC : list.length;
  for (let c = step.beginC; c < step.beginC + step.numC; c++) {
    const before = list[c], horizontal = step.horizontal, key = horizontal ? 'width' : 'height', shift = horizontal ? 'hshift' : 'vshift';
    if (!before.width || !before.height) throw fault('JXL_INPUT', 'A Squeeze step selects an empty channel.');
    if (before.hshift > 30 || before.vshift > 30) throw fault('JXL_INPUT', 'A Squeeze input shift exceeds 30.');
    const low = {...before, [key]: Math.ceil(before[key] / 2), [shift]: before[shift] < 0 ? before[shift] : before[shift] + 1};
    const residual = {...low, [key]: before[key] - low[key]};
    list[c] = low; list.splice(offset + c - step.beginC, 0, residual);
  }
}
export function admitPlanarSqueeze(value, channels, groupSize, memoryLimit = 268435456, metaCount = 0) {
  squeezeInteger(memoryLimit, 1, 2147483648, 'maxTransformBytes');
  if (value === undefined || value === false) return null;
  if (value !== 'default' && !Array.isArray(value)) throw fault('JXL_INPUT', 'squeeze is false, default, or an array of explicit steps.');
  const planned = channels.map(squeezeShape), steps = [];
  const add = step => {
    if (steps.length >= 4096 || planned.length + step.numC > 65536) throw fault('JXL_INPUT', 'Squeeze exceeds the admitted transform or channel count.');
    squeezeInteger(step.beginC, 0, 9287, 'Squeeze beginChannel');
    squeezeInteger(step.numC, 1, 19, 'Squeeze channelCount');
    if (step.beginC + step.numC > planned.length) throw fault('JXL_INPUT', 'Squeeze selects an absent channel.');
    if (step.beginC < metaCount) {
      if (step.beginC + step.numC > metaCount || !step.inPlace) throw fault('JXL_INPUT', 'Meta-channel Squeeze stays within the meta range and inserts residuals in place.');
      metaCount += step.numC;
    }
    advanceSqueezeShape(planned, step); steps.push(step);
  };
  if (value === 'default') {
    const begin = metaCount, n = channels.length - begin;
    if (n > 2 && planned[begin + 1].width === planned[begin].width && planned[begin + 1].height === planned[begin].height) {
      add({horizontal: true, inPlace: false, beginC: begin + 1, numC: 2});
      add({horizontal: false, inPlace: false, beginC: begin + 1, numC: 2});
    }
    const shrink = horizontal => {
      if (n <= 19) add({horizontal, inPlace: true, beginC: begin, numC: n});
      else for (let at = 0; at < n; at += 19) add({horizontal, inPlace: false, beginC: begin + at, numC: Math.min(19, n - at)});
    };
    if (planned[begin].height >= planned[begin].width && planned[begin].height > 8) shrink(false);
    while (planned[begin].width > 8 || planned[begin].height > 8) {
      if (planned[begin].width > 8) shrink(true);
      if (planned[begin].height > 8) shrink(false);
    }
  } else for (const input of value) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw fault('JXL_INPUT', 'Each Squeeze step is an object.');
    for (const key of Object.keys(input)) if (!['axis', 'inPlace', 'beginChannel', 'channelCount'].includes(key)) throw fault('JXL_INPUT', 'Unknown Squeeze step field: ' + key + '.');
    const fields = new Map(Object.entries(input)), axis = fields.get('axis'), inPlace = fields.get('inPlace') ?? true;
    if (axis !== 'x' && axis !== 'y' || typeof inPlace !== 'boolean') throw fault('JXL_INPUT', 'A Squeeze step has axis x or y and boolean inPlace.');
    add({horizontal: axis === 'x', inPlace, beginC: fields.get('beginChannel') ?? 0, numC: fields.get('channelCount') ?? channels.length});
  }
  let firstGrouped = metaCount;
  while (firstGrouped < planned.length && planned[firstGrouped].width <= groupSize && planned[firstGrouped].height <= groupSize) firstGrouped++;
  for (const channel of planned.slice(firstGrouped)) {
    const extent = channel.hshift >= 3 && channel.vshift >= 3 ? groupSize * 8 : groupSize;
    if (channel.width && channel.height && (PLANAR_SQUEEZE_POWERS[channel.hshift] > extent || PLANAR_SQUEEZE_POWERS[channel.vshift] > extent))
      throw fault('JXL_INPUT', 'A grouped Squeeze plane has a shift larger than its group extent.');
  }
  const transformedBytes = channels.reduce((sum, channel) => sum + channel.data.length * 4, 0);
  if (steps.length && transformedBytes * 2 > memoryLimit) throw fault('JXL_MEMORY', 'Squeeze exceeds maxTransformBytes; increase the explicit memory allowance or use fewer source samples.');
  const transforms = [];
  for (let at = 0; at < steps.length; at += 296) transforms.push({type: 'squeeze', params: steps.slice(at, at + 296)});
  if (transforms.length > 512) throw fault('JXL_INPUT', 'JPEG XL permits at most 512 Modular transforms per group.');
  return {steps, transforms, count: planned.length, memoryLimit, metaCount};
}

function planarTendency(previous, average, next) {
  const sign = previous >= average && average >= next ? 1 : previous <= average && average <= next ? -1 : 0;
  if (!sign) return 0;
  previous *= sign; average *= sign; next *= sign;
  let value = Math.trunc((4 * previous - 3 * next - average + 6) / 12);
  if (value - (value & 1) > 2 * (previous - average)) value = 2 * (previous - average) + 1;
  if (value + (value & 1) > 2 * (average - next)) value = 2 * (average - next);
  return sign * value;
}
function planarTendency32(previous, average, next) {
  const descending = previous >= average && average >= next, ascending = previous <= average && average <= next;
  if (!descending && !ascending) return 0;
  let value = Math.trunc(((Math.imul(4, previous) - Math.imul(3, next) - average + (descending ? 6 : -6)) | 0) / 12);
  const first = (2 * (previous - average)) | 0, second = (2 * (average - next)) | 0;
  if (descending) {
    if (value - (value & 1) > first) value = (first + 1) | 0;
    if (value + (value & 1) > second) value = second;
  } else {
    if (value + (value & 1) < first) value = (first - 1) | 0;
    if (value - (value & 1) < second) value = second;
  }
  return value;
}
const planarAverage = (a, b) => Math.floor((a + b + (a > b ? 1 : 0)) / 2);
function squeezePlanarChannel(channel, horizontal) {
  const {width, height, data} = channel, count = horizontal ? width : height, low = Math.ceil(count / 2), high = count - low;
  const lowWidth = horizontal ? low : width, lowHeight = horizontal ? height : low;
  const residualWidth = horizontal ? high : width, residualHeight = horizontal ? height : high;
  const averages = new Int32Array(lowWidth * lowHeight), residuals = new Int32Array(residualWidth * residualHeight), stride = horizontal ? 1 : width;
  for (let y = 0; y < lowHeight; y++) for (let x = 0; x < lowWidth; x++) {
    const axis = horizontal ? x : y, at = horizontal ? y * width + x * 2 : y * width * 2 + x;
    const a = data[at] | 0;
    if (axis === high) { averages[y * lowWidth + x] = a; continue; }
    const b = data[at + stride] | 0, average = planarAverage(a, b), difference = a - b;
    const next = axis + 1 < high ? planarAverage(data[at + stride * 2] | 0, data[at + stride * 3] | 0) : count & 1 ? data[at + stride * 2] | 0 : average;
    const previous = axis ? data[at - stride] | 0 : average, tendency = planarTendency(previous, average, next), residual = difference - tendency;
    if (tendency !== planarTendency32(previous, average, next))
      throw fault('JXL_INPUT', 'This Squeeze tendency exceeds the interoperable signed 32-bit arithmetic range; encode these sample words without Squeeze.');
    if (difference < -2147483648 || difference > 2147483647 || residual < -2147483648 || residual > 2147483647)
      throw fault('JXL_INPUT', 'This Squeeze step exceeds the interoperable signed 32-bit difference range; encode these sample words without Squeeze.');
    averages[y * lowWidth + x] = average; residuals[y * residualWidth + x] = residual;
  }
  const hs = channel.hshift ?? channel.shift, vs = channel.vshift ?? channel.shift;
  const shape = {...channel, hshift: hs < 0 ? hs : hs + Number(horizontal), vshift: vs < 0 ? vs : vs + Number(!horizontal)};
  return [{...shape, width: lowWidth, height: lowHeight, data: averages}, {...shape, width: residualWidth, height: residualHeight, data: residuals}];
}
export function* applyPlanarSqueeze(channels, plan) {
  const result = channels.map(channel => ({...channel, ...squeezeShape(channel)}));
  let wide = false;
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i], offset = step.inPlace ? step.beginC + step.numC : result.length;
    for (let c = step.beginC; c < step.beginC + step.numC; c++) {
      const [low, residual] = squeezePlanarChannel(result[c], step.horizontal);
      for (const channel of [low, residual]) for (const value of channel.data) if (value < -32768 || value > 32767) wide = true;
      result[c] = low; result.splice(offset + c - step.beginC, 0, residual);
    }
    yield (i + 1) / plan.steps.length;
  }
  return {channels: result, wide};
}
