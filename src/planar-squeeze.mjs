// SPDX-License-Identifier: MIT
import {fault} from './admit.mjs';
import {capturePlanarSqueezeStep} from './capture-kernels.mjs';

const PLANAR_SQUEEZE_POWERS = [1]; for (let i = 1; i <= 32; i++) PLANAR_SQUEEZE_POWERS.push(PLANAR_SQUEEZE_POWERS[i - 1] * 2);
const squeezeInteger = (value, minimum, maximum, name) => {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw fault('JXL_INPUT', name + ': integer ' + minimum + '-' + maximum);
  return value;
};
function squeezeShape(channel) { return {width: channel.width, height: channel.height, hshift: channel.hshift ?? channel.shift, vshift: channel.vshift ?? channel.shift}; }
function advanceSqueezeShape(list, step) {
  const offset = step.inPlace ? step.beginC + step.numC : list.length;
  for (let c = step.beginC; c < step.beginC + step.numC; c++) {
    const before = list[c], horizontal = step.horizontal, key = horizontal ? 'width' : 'height', shift = horizontal ? 'hshift' : 'vshift';
    if (!before.width || !before.height) throw fault('JXL_INPUT', 'squeeze step: nonempty channel');
    if (before.hshift > 30 || before.vshift > 30) throw fault('JXL_INPUT', 'squeeze shift: <=30');
    const low = {...before, [key]: Math.ceil(before[key] / 2), [shift]: before[shift] < 0 ? before[shift] : before[shift] + 1};
    const residual = {...low, [key]: before[key] - low[key]};
    list[c] = low; list.splice(offset + c - step.beginC, 0, residual);
  }
}
export function admitPlanarSqueeze(value, channels, groupSize, memoryLimit = Number.MAX_SAFE_INTEGER, metaCount = 0) {
  squeezeInteger(memoryLimit, 1, Number.MAX_SAFE_INTEGER, 'maxTransformBytes');
  if (value === undefined || value === false) return null;
  if (value !== 'default' && !Array.isArray(value)) throw fault('JXL_INPUT', 'squeeze: false|default|steps array');
  if (Array.isArray(value) && value.length > 4096) throw fault('JXL_INPUT', 'squeeze: transforms/channels limit exceeded');
  const planned = channels.map(squeezeShape), steps = [];
  const add = step => {
    if (steps.length >= 4096 || planned.length + step.numC > 65536) throw fault('JXL_INPUT', 'squeeze: transforms/channels limit exceeded');
    squeezeInteger(step.beginC, 0, 9287, 'Squeeze beginChannel');
    squeezeInteger(step.numC, 1, 19, 'Squeeze channelCount');
    if (step.beginC + step.numC > planned.length) throw fault('JXL_INPUT', 'squeeze: missing channel');
    if (step.beginC < metaCount) {
      if (step.beginC + step.numC > metaCount || !step.inPlace) throw fault('JXL_INPUT', 'meta squeeze: inPlace, meta range');
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
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw fault('JXL_INPUT', 'squeeze step: object');
    for (const key of Object.keys(input)) if (!['axis', 'inPlace', 'beginChannel', 'channelCount'].includes(key)) throw fault('JXL_INPUT', 'unknown Squeeze field: ' + key);
    const fields = new Map(Object.entries(input)), axis = fields.get('axis'), inPlace = fields.get('inPlace') ?? true;
    if (axis !== 'x' && axis !== 'y' || typeof inPlace !== 'boolean') throw fault('JXL_INPUT', 'squeeze step: axis x|y, inPlace boolean');
    add({horizontal: axis === 'x', inPlace, beginC: fields.get('beginChannel') ?? 0, numC: fields.get('channelCount') ?? channels.length});
  }
  let firstGrouped = metaCount;
  while (firstGrouped < planned.length && planned[firstGrouped].width <= groupSize && planned[firstGrouped].height <= groupSize) firstGrouped++;
  for (const channel of planned.slice(firstGrouped)) {
    const extent = channel.hshift >= 3 && channel.vshift >= 3 ? groupSize * 8 : groupSize;
    if (channel.width && channel.height && (PLANAR_SQUEEZE_POWERS[channel.hshift] > extent || PLANAR_SQUEEZE_POWERS[channel.vshift] > extent))
      throw fault('JXL_INPUT', 'squeeze shift: group limit exceeded');
  }
  const transformedBytes = channels.reduce((sum, channel) => sum + channel.data.length * 4, 0);
  if (steps.length && transformedBytes * 2 > memoryLimit) throw fault('JXL_MEMORY', 'squeeze: maxTransformBytes; increase or fewer samples');
  const transforms = [];
  for (let at = 0; at < steps.length; at += 296) transforms.push({type: 'squeeze', params: steps.slice(at, at + 296)});
  if (transforms.length > 512) throw fault('JXL_INPUT', 'Modular transforms: <=512/group');
  return {steps, transforms, count: planned.length, memoryLimit, metaCount};
}

function squeezePlanarChannel(channel, horizontal) {
  const {width, height, data} = channel, count = horizontal ? width : height, low = Math.ceil(count / 2), high = count - low;
  const lowWidth = horizontal ? low : width, lowHeight = horizontal ? height : low;
  const residualWidth = horizontal ? high : width, residualHeight = horizontal ? height : high;
  const {averages, residuals, wide} = capturePlanarSqueezeStep(data, width, height, horizontal);
  const hs = channel.hshift ?? channel.shift, vs = channel.vshift ?? channel.shift;
  const shape = {...channel, hshift: hs < 0 ? hs : hs + Number(horizontal), vshift: vs < 0 ? vs : vs + Number(!horizontal)};
  return [{...shape, width: lowWidth, height: lowHeight, data: averages}, {...shape, width: residualWidth, height: residualHeight, data: residuals}, wide];
}
export function* applyPlanarSqueeze(channels, plan) {
  const result = channels.map(channel => ({...channel, ...squeezeShape(channel)}));
  let wide = false;
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i], offset = step.inPlace ? step.beginC + step.numC : result.length;
    for (let c = step.beginC; c < step.beginC + step.numC; c++) {
      const [low, residual, stepWide] = squeezePlanarChannel(result[c], step.horizontal);
      if (stepWide) wide = true;
      result[c] = low; result.splice(offset + c - step.beginC, 0, residual);
    }
    yield (i + 1) / plan.steps.length;
  }
  return {channels: result, wide};
}
