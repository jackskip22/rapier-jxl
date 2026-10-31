// SPDX-License-Identifier: MIT
import {readEntropy} from './decode-entropy.mjs';
import {requireDecode, unpackSigned} from './decode-bits.mjs';
import {blendRows} from './decode-compose.mjs';
import {decodeKernels} from './decode-kernels.mjs';
import {exactCos, exactExp, exactLog, EXACT_PI} from './exact-math.mjs';

const f32 = Math.fround;
const boundedPoint = (x, y, r) => requireDecode(Math.abs(x) < 8388608 && Math.abs(y) < 8388608,
  'JPEG XL spline coordinate exceeds its range.', r);

export function featureBudget({maxFeatureBytes = 268435456, maxFeatureWork = 268435456} = {}, sharedWork = {spent: 0}) {
  requireDecode(Number.isSafeInteger(maxFeatureBytes) && maxFeatureBytes >= 0 && Number.isSafeInteger(maxFeatureWork) && maxFeatureWork >= 0,
    'Invalid JPEG XL feature resource budget.');
  let bytes = 0;
  const check = (value, maximum, label) => {
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum) { const error = new Error('JPEG XL features exceed the '+label+' limit.'); error.code = 'JXL_LIMIT'; throw error; }
  };
  return {memory(n) { check(n,maxFeatureBytes,'memory'); bytes += n; check(bytes,maxFeatureBytes,'memory'); },
    work(n) { check(n,maxFeatureWork,'work'); check(sharedWork.spent,maxFeatureWork,'work');
      check(n,maxFeatureWork-sharedWork.spent,'work'); sharedWork.spent += n; }};
}

export function readPatches(r, imageHeader, frameHeader, options = {}, budget = featureBudget(options)) {
  const width = Math.ceil((frameHeader.encodedWidth ?? frameHeader.width) / 8) * 8;
  const height = Math.ceil((frameHeader.encodedHeight ?? frameHeader.height) / 8) * 8;
  const extraCount = imageHeader.extraChannels.length, limit = 1024 + Math.floor(width * height / 4);
  const code = readEntropy(r, 10), count = code.read(0), groups = [];
  requireDecode(count <= limit, 'Too many JPEG XL reference patches.', r);
  budget.memory(count*160); budget.work(1+count*6);
  let placements = 0, blendInfos = 0, area = 0;
  for (let g = 0; g < count; g++) {
    const reference = code.read(1), sx = code.read(3), sy = code.read(3), w = code.read(2) + 1, h = code.read(2) + 1;
    const n = code.read(7) + 1;
    placements += n; blendInfos += n * (extraCount + 1); area += n * w * h;
    requireDecode(reference < 4 && w <= width && h <= height && placements <= 4 * limit && blendInfos <= 16 * limit,
      'Invalid JPEG XL patch dimensions or count.', r);
    requireDecode(area <= Math.max(1048576, 1024 * width * height), 'JPEG XL patch coverage exceeds its area limit.', r);
    budget.memory(n*(96+72*(extraCount+1))); budget.work(n*(2+3*(extraCount+1)));
    const positions = [];
    let x = 0, y = 0;
    for (let p = 0; p < n; p++) {
      x = p ? x + unpackSigned(code.read(6)) : code.read(4);
      y = p ? y + unpackSigned(code.read(6)) : code.read(4);
      requireDecode(x >= 0 && y >= 0 && x <= width - w && y <= height - h, 'JPEG XL patch is outside the destination.', r);
      const blending = [];
      for (let c = 0; c <= extraCount; c++) {
        const mode = code.read(5);
        requireDecode(mode < 8, 'Invalid JPEG XL patch blend mode.', r);
        const alpha = mode >= 4 && extraCount > 1 ? code.read(8) : 0;
        requireDecode(mode < 4 || !extraCount || alpha < extraCount, 'Invalid JPEG XL patch alpha channel.', r);
        const clamp = mode >= 3 ? !!code.read(9) : false;
        blending.push({mode, alpha, clamp});
      }
      positions.push({x, y, blending});
    }
    groups.push({reference, sx, sy, w, h, positions});
  }
  code.finish();
  return {groups};
}


export function applyPatches(frame, patches, references, imageHeader, options = {}, budget = featureBudget(options)) {
  if (!patches) return frame;
  const metadata = imageHeader.extraChannels, colorCount = frame.planes.length;
  const channels = [...frame.planes, ...frame.extraChannels.map(c => c.data)];
  budget.memory(channels.length*4);
  const hasAlpha = metadata.some(c => c.type === 0);
  for (const group of patches.groups) {
    const reference = references instanceof Map ? references.get(group.reference) : references[group.reference];
    requireDecode(reference && reference.saveBeforeColorTransform !== false, 'JPEG XL patch requires a saved pre-color reference.');
    requireDecode(group.sx <= reference.width - group.w && group.sy <= reference.height - group.h,
      'JPEG XL patch is outside its reference.');
    requireDecode(reference.planes.length === colorCount && reference.extraChannels.length === metadata.length &&
      frame.extraChannels.every(c => c.width === frame.width && c.height === frame.height) &&
      reference.extraChannels.every(c => c.width === reference.width && c.height === reference.height),
    'JPEG XL patch channel dimensions do not agree.');
    const source = [...reference.planes, ...reference.extraChannels.map(c => c.data)];
    for (const position of group.positions) {
      requireDecode(position.x >= 0 && position.y >= 0 && position.x + group.w <= Math.ceil(frame.width / 8) * 8 &&
        position.y + group.h <= Math.ceil(frame.height / 8) * 8,
        'JPEG XL patch is outside the destination.');
      const height = Math.min(group.h, frame.height - position.y), width = Math.min(group.w, frame.width - position.x);
      budget.work(Math.max(0,height)*Math.max(0,width)*channels.length);
      const blended = new Map();
      const add = (c, mode, clamp, a = -1, associated = false) => blended.set(c, {mode, clamp, associated, isAlpha: c === a,
        fill(role, y, run) {
          const k = role & 1 ? source[role < 2 ? c : a] : channels[role < 2 ? c : a], at = role & 1 ? (group.sy + y) * reference.width + group.sx : (position.y + y) * frame.width + position.x;
          if (role < 2 || a >= 0) run.set(k.subarray(at, at + width));
        },
        write(y, run) { channels[c].set(run, (position.y + y) * frame.width + position.x); }});
      for (let c = 0; c < channels.length; c++) {
        const blend = position.blending[c < colorCount ? 0 : c - colorCount + 1];
        if (blend.mode < 4 || c < colorCount && !hasAlpha) add(c, blend.mode < 4 ? blend.mode : blend.mode < 6 ? 1 : 2, blend.clamp);
        else add(c, blend.mode, blend.clamp, colorCount + blend.alpha, metadata[blend.alpha].associated);
      }
      const colorBlend = position.blending[0];
      if (hasAlpha && (colorBlend.mode === 4 || colorBlend.mode === 5)) {
        const a = colorCount + colorBlend.alpha; add(a, colorBlend.mode, colorBlend.clamp, a);
      }
      blendRows([...blended.values()].filter(c => c.mode !== 0), height, width);
    }
  }
  return frame;
}

export function readSplines(r, imageHeader, frameHeader, options = {}, budget = featureBudget(options)) {
  const pixels = (frameHeader.encodedWidth ?? frameHeader.width) * (frameHeader.encodedHeight ?? frameHeader.height);
  const limit = Math.min(1048576, Math.floor(pixels / 2)), code = readEntropy(r, 6), count = code.read(2) + 1;
  requireDecode(count <= limit, 'Too many JPEG XL splines.', r);
  budget.memory(count*960); budget.work(2+count*131);
  const starts = new Int32Array(count * 2);
  let x = 0, y = 0;
  for (let i = 0; i < count; i++) {
    x = i ? x + unpackSigned(code.read(1)) : code.read(1);
    y = i ? y + unpackSigned(code.read(1)) : code.read(1);
    boundedPoint(x, y, r); starts[2*i] = x; starts[2*i+1] = y;
  }
  const quantizationAdjustment = unpackSigned(code.read(0)), splines = [];
  let total = count;
  for (let i = 0; i < count; i++) {
    const extra = code.read(3); total += extra;
    requireDecode(total <= limit, 'Too many JPEG XL spline control points.', r);
    budget.memory(extra*8); budget.work(extra*2);
    const points = new Int32Array((extra + 1) * 2); x = starts[2*i]; y = starts[2*i+1]; points[0] = x; points[1] = y;
    let dx = 0, dy = 0, distance = 0;
    for (let p = 1; p <= extra; p++) {
      dx += unpackSigned(code.read(4)); dy += unpackSigned(code.read(4));
      boundedPoint(dx, dy, r); requireDecode(dx || dy, 'Coincident JPEG XL spline control points.', r);
      x += dx; y += dy; boundedPoint(x, y, r); distance += Math.abs(dx) + Math.abs(dy);
      points[2*p] = x; points[2*p+1] = y;
    }
    const coefficients = Array.from({length: 4}, () => {
      const result = new Int32Array(32);
      for (let k = 0; k < 32; k++) {
        const v = unpackSigned(code.read(5));
        requireDecode(v !== -2147483648, 'Invalid JPEG XL spline coefficient.', r); result[k] = v;
      }
      return result;
    });
    splines.push({points, coefficients, distance});
  }
  code.finish();
  return {quantizationAdjustment, splines};
}

export function readFeatures(r, imageHeader, frameHeader, options = {}, sharedWork) {
  const flags = frameHeader.flags, budget = featureBudget(options,sharedWork);
  const patches = flags & 2n ? readPatches(r, imageHeader, frameHeader, options, budget) : null;
  const splines = flags & 16n ? readSplines(r, imageHeader, frameHeader, options, budget) : null;
  if (flags & 1n) { budget.memory(32); budget.work(8); }
  const noise = flags & 1n ? Float32Array.from({length: 8}, () => r.read(10) / 1024) : null;
  const features = {patches, splines, noise};
  Object.defineProperty(features, 'budget', {value: budget});
  return features;
}

export function applyNoise(frame, noise, {visibleFrame = 0, nonvisibleFrame = 0, correlation = [0,1], groupSize = 256, ...limits} = {}, budget = featureBudget(limits)) {
  if (!noise || !noise.some(v => v > .001)) return frame;
  requireDecode(frame.planes.length === 3 && [128,256,512,1024].includes(groupSize), 'Invalid JPEG XL noise geometry.');
  const {width, height} = frame, n = width * height;
  budget.memory(12*width*height+24*width+400); budget.work(3*width*height);
  const kernels = decodeKernels(), chunk = Math.min(n, 1048576);
  const [random0, random1, random2, ring, slots, state, lut, args, ...frameAt] = kernels.reserve([n * 4, n * 4, n * 4, (width + 4) * 20, 20, 128, 32, 16, chunk * 4, chunk * 4, chunk * 4]);
  const random = [random0, random1, random2];
  kernels.i32.set(random, args / 4);
  new Float32Array(kernels.buffer, lut, 8).set(noise);
  for (let y0 = 0; y0 < height; y0 += groupSize) for (let x0 = 0; x0 < width; x0 += groupSize)
    kernels.noiseRandom(args, width, x0, y0, Math.min(groupSize, width - x0), Math.min(groupSize, height - y0), visibleFrame, nonvisibleFrame, state);
  for (const plane of random) kernels.noiseConvolve(plane, width, height, ring, slots);
  const [corrX, corrB] = correlation;
  for (let i = 0; i < n; i += chunk) {
    const m = Math.min(chunk, n - i), views = frameAt.map(at => new Float32Array(kernels.buffer, at, m));
    frame.planes.forEach((p, c) => views[c].set(p.subarray(i, i + m)));
    kernels.noiseApply(m, ...frameAt, ...random.map(at => at + i * 4), lut, corrX, corrB);
    frame.planes.forEach((p, c) => p.set(views[c], i));
  }
  return frame;
}

function interpolate(a, b, t) {
  return [f32(a[0] + f32(t * f32(b[0]-a[0]))), f32(a[1] + f32(t * f32(b[1]-a[1])))];
}

function* curvePoints(points) {
  const count = points.length / 2, at = i => [points[2*i],points[2*i+1]];
  if (count === 1) { yield at(0); return; }
  for (let segment = 0; segment < count - 1; segment++) {
    const p1 = at(segment), p2 = at(segment+1);
    const p0 = segment ? at(segment-1) : [f32(2*p1[0]-p2[0]),f32(2*p1[1]-p2[1])];
    const p3 = segment + 2 < count ? at(segment+2) : [f32(2*p2[0]-p1[0]),f32(2*p2[1]-p1[1])];
    const p = [p0,p1,p2,p3], distance = [], time = [0];
    for (let k = 0; k < 3; k++) {
      const dx = f32(p[k+1][0]-p[k][0]), dy = f32(p[k+1][1]-p[k][1]);
      distance[k] = f32(Math.sqrt(f32(Math.sqrt(dx*dx+dy*dy))));
      time[k+1] = f32(time[k]+distance[k]);
    }
    yield p1;
    for (let step = 1; step < 16; step++) {
      const t = f32(distance[0] + f32(step/16 * distance[1]));
      const a = p.slice(0,3).map((v,k) => interpolate(v,p[k+1],f32(f32(t-time[k])/distance[k])));
      const b0 = interpolate(a[0],a[1],f32(t/f32(distance[0]+distance[1])));
      const b1 = interpolate(a[1],a[2],f32(f32(t-time[1])/f32(distance[1]+distance[2])));
      yield interpolate(b0,b1,f32(f32(t-time[1])/distance[1]));
    }
  }
  yield at(count-1);
}

function* arcPoints(points) {
  const curve = curvePoints(points), first = curve.next();
  let current = first.value, next = curve.next();
  yield {point: current, weight: 1};
  for (;;) {
    let previous = current, used = 0;
    for (;;) {
      if (next.done) { yield {point: previous, weight: used}; return; }
      const point = next.value, dx = f32(point[0]-previous[0]), dy = f32(point[1]-previous[1]);
      const distance = f32(Math.sqrt(f32(f32(dx*dx)+f32(dy*dy))));
      if (f32(used+distance) >= 1) {
        const nextPoint = interpolate(previous, point, f32(f32(1-used)/distance));
        requireDecode(nextPoint[0] !== current[0] || nextPoint[1] !== current[1], 'JPEG XL spline does not advance at its coordinate precision.');
        current = nextPoint; yield {point: current, weight: 1}; break;
      }
      used = f32(used+distance); previous = point; next = curve.next();
    }
  }
}

let erfTable;
function splineErfTable() {
  if (!erfTable) {
    const values = new Float64Array(1537), derivatives = new Float64Array(1537), factor = 2 / Math.sqrt(EXACT_PI), step = 1/256;
    derivatives[0] = factor;
    for (let i = 1; i <= 1536; i++) {
      const at = i*step, mid = at-step/2;
      derivatives[i] = factor * exactExp(-at*at);
      values[i] = values[i-1] + step/6 * (derivatives[i-1] + 4*factor*exactExp(-mid*mid) + derivatives[i]);
    }
    erfTable = new Float64Array(3074); erfTable.set(values); erfTable.set(derivatives, 1537);
  }
  return erfTable;
}

function splineDct(coefficients, position) {
  let result = 0;
  for (const [frequency, value] of coefficients) result += value * exactCos(frequency * EXACT_PI / 32 * (position+.5));
  return f32(result * Math.SQRT2);
}

function splineCoefficients(spline, inverse, correlation) {
  const weights = [.0042,.075,.07,.3333], values = spline.coefficients.map((coefficients,c) => Float32Array.from(coefficients,
    (value,k) => f32(f32(f32(value * (k ? 1 : f32(Math.SQRT1_2))) * f32(weights[c])) * inverse)));
  for (let i = 0; i < 32; i++) {
    values[0][i] = f32(values[0][i] + f32(correlation[0]*values[1][i]));
    values[2][i] = f32(values[2][i] + f32(correlation[1]*values[1][i]));
  }
  return values.map(v => Array.from(v, (value, k) => [k,value]).filter(v => v[1]));
}

function splineArea(spline, inverse, correlation, areaLimit) {
  requireDecode(spline.distance <= areaLimit, 'JPEG XL spline distance exceeds its area budget.');
  const color = spline.coefficients.slice(0,3).map(c => c.reduce((sum,v) => sum + Math.ceil(f32(inverse*Math.abs(v))),0));
  color[0] += Math.ceil(Math.abs(correlation[0]))*color[1]; color[2] += Math.ceil(Math.abs(correlation[1]))*color[1];
  const largest = 1+Math.max(...color);
  let log = 1, power = 2;
  while (power < largest) { power *= 2; log++; }
  const limit = Math.ceil(Math.sqrt(f32(f32(areaLimit/log)/Math.max(1,spline.distance))));
  let area = 0;
  for (const value of spline.coefficients[3]) {
    const w = Math.min(limit,Math.max(1,Math.ceil(f32(inverse*Math.abs(value)))));
    area += w*w*log;
  }
  return area*spline.distance;
}

export function applySplines(frame, splines, {correlation = [0,1], ...limits} = {}, budget = featureBudget(limits)) {
  if (!splines) return frame;
  requireDecode(frame.planes.length === 3, 'JPEG XL splines require three color planes.');
  const qa = splines.quantizationAdjustment, inverse = qa >= 0 ? f32(1/f32(1+f32(qa*.125))) : f32(1-f32(qa*.125));
  const areaLimit = Math.min(4398046511104,1024*frame.width*frame.height+4294967296);
  let estimatedArea = 0, scratchReserved = false, kernel = null;
  const kernelPlanes = () => {
    if (kernel) return kernel;
    const kernels = decodeKernels(), n = frame.width * frame.height, at = kernels.reserve([n * 4, n * 4, n * 4, 16, 3074 * 8]);
    frame.planes.forEach((p, c) => new Float32Array(kernels.buffer, at[c], n).set(p));
    kernels.i32.set(at.slice(0, 3), at[3] / 4);
    new Float64Array(kernels.buffer, at[4], 3074).set(splineErfTable());
    return kernel = {kernels, planes: at[3], tables: at[4], at, n};
  };
  for (const spline of splines.splines) {
    estimatedArea += splineArea(spline,inverse,correlation,areaLimit);
    requireDecode(estimatedArea <= areaLimit, 'JPEG XL splines exceed their area budget.');
    let samples = 0, lastWeight = 0;
    for (const sample of arcPoints(spline.points)) { samples++; lastWeight = sample.weight; budget.work(1); }
    const length = f32(samples-2+lastWeight);
    if (!(length > 0)) continue;
    if (!scratchReserved) { budget.memory(28672); scratchReserved = true; }
    const coefficients = splineCoefficients(spline,inverse,correlation), reciprocal = f32(1/length);
    let index = 0;
    for (const {point,weight} of arcPoints(spline.points)) {
      const position = f32(31*Math.min(1,f32(index++*reciprocal)));
      if (!weight) continue;
      const color = coefficients.slice(0,3).map(c => splineDct(c,position)), sigma = splineDct(coefficients[3],position);
      if (!Number.isFinite(sigma) || !sigma || !Number.isFinite(f32(1/sigma))) continue;
      const largest = Math.max(.01,...color.map(v => Math.abs(f32(v*weight))));
      const radius = f32(Math.sqrt(-2*sigma*sigma*(-3*exactLog(10)-exactLog(largest))));
      const x0 = Math.max(0,Math.floor(point[0]-radius+.5)), y0 = Math.max(0,Math.floor(point[1]-radius+.5));
      const x1 = Math.min(frame.width,Math.floor(point[0]+radius+.5)+1), y1 = Math.min(frame.height,Math.floor(point[1]+radius+.5)+1);
      if (x1 <= x0 || y1 <= y0) continue;
      budget.work((x1-x0)*(y1-y0));
      const reciprocalSigma = f32(1/sigma), amplitude = f32(f32(.25*sigma)*weight), offset = f32(Math.SQRT1_2*.5), K = kernelPlanes();
      K.kernels.splineDot(K.planes, frame.width, x0, y0, x1, y1, point[0], point[1], reciprocalSigma, amplitude, color[0], color[1], color[2], offset, K.tables);
    }
  }
  if (kernel) frame.planes.forEach((p, c) => p.set(new Float32Array(kernel.kernels.buffer, kernel.at[c], kernel.n)));
  return frame;
}
