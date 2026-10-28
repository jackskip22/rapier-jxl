// SPDX-License-Identifier: MIT
import {readEntropy} from './decode-entropy.mjs';
import {requireDecode, unpackSigned} from './decode-bits.mjs';
import {blendSample} from './decode-compose.mjs';
import {exactCos, exactExp, exactLog, EXACT_PI} from './exact-math.mjs';

const f32 = Math.fround;
const clamp01 = x => Math.max(0, Math.min(1, x));
const boundedPoint = (x, y, r) => requireDecode(Math.abs(x) < 8388608 && Math.abs(y) < 8388608,
  'JPEG XL spline coordinate exceeds its range.', r);

function featureBudget({maxFeatureBytes = 268435456, maxFeatureWork = 268435456} = {}) {
  requireDecode(Number.isSafeInteger(maxFeatureBytes) && maxFeatureBytes >= 0 && Number.isSafeInteger(maxFeatureWork) && maxFeatureWork >= 0,
    'Invalid JPEG XL feature resource budget.');
  let bytes = 0, work = 0;
  const check = (value, maximum, label) => {
    if (value > maximum) { const error = new Error('JPEG XL features exceed the '+label+' limit.'); error.code = 'JXL_LIMIT'; throw error; }
  };
  return {memory(n) { bytes += n; check(bytes,maxFeatureBytes,'memory'); }, work(n) { work += n; check(work,maxFeatureWork,'work'); }};
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


export function applyPatches(frame, patches, references, imageHeader, options = {}) {
  const budget = featureBudget(options);
  if (!patches) return frame;
  const metadata = imageHeader.extraChannels, colorCount = frame.planes.length;
  const channels = [...frame.planes, ...frame.extraChannels.map(c => c.data)], values = new Float32Array(channels.length);
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
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const to = (position.y + y) * frame.width + position.x + x, from = (group.sy + y) * reference.width + group.sx + x;
        for (let c = 0; c < channels.length; c++) {
          const blend = position.blending[c < colorCount ? 0 : c - colorCount + 1];
          if (blend.mode < 4 || c < colorCount && !hasAlpha) {
            const mode = blend.mode < 4 ? blend.mode : blend.mode < 6 ? 1 : 2;
            values[c] = mode === 0 ? channels[c][to] : mode === 1 ? source[c][from] : mode === 2 ?
              channels[c][to] + source[c][from] : channels[c][to] * (blend.clamp ? clamp01(source[c][from]) : source[c][from]);
          } else {
            const a = colorCount + blend.alpha;
            values[c] = blendSample(channels[c][to], source[c][from], channels[a][to], source[a][from], blend,
              metadata[blend.alpha].associated, c === a);
          }
        }
        const colorBlend = position.blending[0];
        if (hasAlpha && (colorBlend.mode === 4 || colorBlend.mode === 5)) {
          const a = colorCount + colorBlend.alpha;
          values[a] = blendSample(channels[a][to], source[a][from], channels[a][to], source[a][from], colorBlend, false, true);
        }
        for (let c = 0; c < channels.length; c++) channels[c][to] = values[c];
      }
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

export function readFeatures(r, imageHeader, frameHeader, options = {}) {
  const flags = frameHeader.flags, budget = featureBudget(options);
  const patches = flags & 2n ? readPatches(r, imageHeader, frameHeader, options, budget) : null;
  const splines = flags & 16n ? readSplines(r, imageHeader, frameHeader, options, budget) : null;
  if (flags & 1n) { budget.memory(32); budget.work(8); }
  const noise = flags & 1n ? Float32Array.from({length: 8}, () => r.read(10) / 1024) : null;
  return {patches, splines, noise};
}

const MASK64 = 18446744073709551615n;
function mixSeed(z) {
  z = ((z ^ z >> 30n) * 13787848793156543929n) & MASK64;
  z = ((z ^ z >> 27n) * 10723151780598845931n) & MASK64;
  return z ^ z >> 31n;
}

class NoiseRandom {
  constructor(visible, nonvisible, x, y) {
    this.a = new Uint32Array(16); this.b = new Uint32Array(16); this.batch = new Uint32Array(16);
    let a = mixSeed(((BigInt(visible >>> 0) << 32n) + BigInt(nonvisible >>> 0) + 11400714819323198485n) & MASK64);
    let b = mixSeed(((BigInt(x >>> 0) << 32n) + BigInt(y >>> 0) + 11400714819323198485n) & MASK64);
    for (let lane = 0; lane < 16; lane += 2) {
      this.a[lane] = Number(a & 4294967295n); this.a[lane+1] = Number(a >> 32n);
      this.b[lane] = Number(b & 4294967295n); this.b[lane+1] = Number(b >> 32n);
      a = mixSeed(a); b = mixSeed(b);
    }
  }
  next() {
    const {a, b, batch} = this;
    for (let i = 0; i < 16; i += 2) {
      const al = a[i], ah = a[i+1], bl = b[i], bh = b[i+1], sum = al + bl;
      batch[i] = sum; batch[i+1] = ah + bh + Number(sum >= 4294967296);
      const lo = (al ^ al << 23) >>> 0, hi = (ah ^ ah << 23 ^ al >>> 9) >>> 0;
      a[i] = bl; a[i+1] = bh;
      b[i] = lo ^ bl ^ lo >>> 18 ^ hi << 14 ^ bl >>> 5 ^ bh << 27;
      b[i+1] = hi ^ bh ^ hi >>> 18 ^ bh >>> 5;
    }
    return batch;
  }
}

function mirror(index, length) {
  while (index < 0 || index >= length) index = index < 0 ? -index - 1 : 2 * length - index - 1;
  return index;
}

function convolveNoise(data, width, height) {
  const rows = Array.from({length: 5}, () => new Float32Array(width + 4)), rowNumbers = new Int32Array(5).fill(-1);
  const xIndices = Uint32Array.from({length: width + 4}, (_, x) => mirror(x - 2, width));
  const selected = new Array(5), needed = new Int32Array(5), k = f32(.16), centerWeight = f32(-3.84);
  for (let y = 0; y < height; y++) {
    for (let i = 0; i < 5; i++) needed[i] = mirror(y + i - 2, height);
    for (let i = 0; i < 5; i++) {
      let slot = rowNumbers.indexOf(needed[i]);
      if (slot < 0) {
        slot = rowNumbers.findIndex(n => !needed.includes(n));
        const base = needed[i] * width, row = rows[slot];
        for (let x = 0; x < width + 4; x++) row[x] = data[base + xIndices[x]];
        rowNumbers[slot] = needed[i];
      }
      selected[i] = rows[slot];
    }
    const [a,b,c,d,e] = selected, base = y * width;
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let j = x; j < x + 5; j++) {
        sum = f32(sum + a[j]); sum = f32(sum + b[j]); sum = f32(sum + d[j]); sum = f32(sum + e[j]);
      }
      sum = f32(sum + c[x]); sum = f32(sum + c[x+1]); sum = f32(sum + c[x+3]); sum = f32(sum + c[x+4]);
      data[base+x] = f32(sum * k + f32(c[x+2] * centerWeight));
    }
  }
}

function noiseStrength(lut, value) {
  const scaled = Math.max(0, f32(value * 3));
  if (scaled >= 7) return lut[7];
  const index = Math.floor(scaled), fraction = f32(scaled - index);
  return clamp01(f32(f32(lut[index+1] - lut[index]) * fraction + lut[index]));
}

export function applyNoise(frame, noise, {visibleFrame = 0, nonvisibleFrame = 0, correlation = [0,1], groupSize = 256, ...limits} = {}) {
  const budget = featureBudget(limits);
  if (!noise || !noise.some(v => v > .001)) return frame;
  requireDecode(frame.planes.length === 3 && [128,256,512,1024].includes(groupSize), 'Invalid JPEG XL noise geometry.');
  const {width, height} = frame;
  budget.memory(12*width*height+24*width+400); budget.work(3*width*height);
  const random = Array.from({length: 3}, () => new Float32Array(width * height));
  for (let y0 = 0; y0 < height; y0 += groupSize) for (let x0 = 0; x0 < width; x0 += groupSize) {
    const rng = new NoiseRandom(visibleFrame, nonvisibleFrame, x0, y0), w = Math.min(groupSize, width-x0), h = Math.min(groupSize, height-y0);
    for (const plane of random) for (let y = 0; y < h; y++) for (let x = 0; x < w; x += 16) {
      const bits = rng.next(), start = (y0 + y) * width + x0 + x;
      for (let j = 0; j < Math.min(16,w-x); j++) plane[start+j] = 1 + (bits[j] >>> 9) / 8388608;
    }
  }
  for (const plane of random) convolveNoise(plane, width, height);
  const [x,y,b] = frame.planes, [rx,ry,rb] = random, norm = f32(.22), [corrX,corrB] = correlation;
  for (let i = 0; i < x.length; i++) {
    const sx = noiseStrength(noise, f32(y[i]+x[i])), sy = noiseStrength(noise, f32(y[i]-x[i]));
    const common = f32(.9921875 * f32(rb[i] * norm));
    const nx = f32(sx * f32(.0078125 * f32(rx[i]*norm) + common));
    const ny = f32(sy * f32(.0078125 * f32(ry[i]*norm) + common)), sum = f32(nx+ny);
    x[i] = f32(f32(corrX * sum + f32(nx-ny)) + x[i]);
    y[i] = f32(y[i]+sum); b[i] = f32(corrB * sum + b[i]);
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

let erfValues, erfDerivatives;
function splineErf(value) {
  const x = Math.abs(value);
  if (x >= 6) return Math.sign(value);
  if (!erfValues) {
    erfValues = new Float64Array(1537); erfDerivatives = new Float64Array(1537);
    const factor = 2 / Math.sqrt(EXACT_PI), step = 1/256;
    erfDerivatives[0] = factor;
    for (let i = 1; i <= 1536; i++) {
      const at = i*step, mid = at-step/2;
      erfDerivatives[i] = factor * exactExp(-at*at);
      erfValues[i] = erfValues[i-1] + step/6 * (erfDerivatives[i-1] + 4*factor*exactExp(-mid*mid) + erfDerivatives[i]);
    }
  }
  const scaled = x*256, index = Math.floor(scaled), t = scaled-index, tt = t*t, ttt = tt*t;
  const result = (2*ttt-3*tt+1)*erfValues[index] + (-2*ttt+3*tt)*erfValues[index+1] +
    ((ttt-2*tt+t)*erfDerivatives[index] + (ttt-tt)*erfDerivatives[index+1])/256;
  return value < 0 ? -result : result;
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

export function applySplines(frame, splines, {correlation = [0,1], ...limits} = {}) {
  const budget = featureBudget(limits);
  if (!splines) return frame;
  requireDecode(frame.planes.length === 3, 'JPEG XL splines require three color planes.');
  const qa = splines.quantizationAdjustment, inverse = qa >= 0 ? f32(1/f32(1+f32(qa*.125))) : f32(1-f32(qa*.125));
  const areaLimit = Math.min(4398046511104,1024*frame.width*frame.height+4294967296);
  let estimatedArea = 0, scratchReserved = false;
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
      const reciprocalSigma = f32(1/sigma), amplitude = f32(f32(.25*sigma)*weight), offset = f32(Math.SQRT1_2*.5);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const dx = f32(x-point[0]), dy = f32(y-point[1]), distance = f32(Math.sqrt(f32(dx*dx+f32(dy*dy))));
        const upper = f32(f32(distance*.5+offset)*reciprocalSigma), lower = f32(f32(distance*.5-offset)*reciprocalSigma);
        const integral = f32(f32(splineErf(upper))-f32(splineErf(lower))), value = f32(amplitude*f32(integral*integral));
        const at = y*frame.width+x;
        for (let c = 0; c < 3; c++) frame.planes[c][at] = f32(color[c]*value+frame.planes[c][at]);
      }
    }
  }
  return frame;
}
