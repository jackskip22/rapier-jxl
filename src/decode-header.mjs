// SPDX-License-Identifier: MIT
import {JxlBits, requireDecode, unpackSigned} from './decode-bits.mjs';
import {readEntropy, readPermutation} from './decode-entropy.mjs';
import {DEFAULT_OPSIN} from './decode-tables.mjs';

const SIZE = [[9,1],[13,1],[18,1],[30,1]];
const FRAME_SIZE = [[8,0],[11,256],[14,2304],[30,18688]];
const SCALE = [[0,1],[0,2],[0,4],[0,8]];
const RATIOS = [[0,1],[1,1],[12,10],[4,3],[3,2],[16,9],[5,4],[2,1]];
const DEFAULT_DEPTH = {bits:8, exponentBits:0, float:false};
const array = (n, fn) => Array.from({length:n}, fn);
const bool = r => !!r.read(1);
export function power2(n) { let v = 1; while (n > 0) { v *= 2; n--; } while (n < 0) { v /= 2; n++; } return v; }
export function readExtensions(r) {
  let flags = r.u64BigInt(); const sizes = [];
  while (flags) { if (flags & 1n) sizes.push(r.u64()); flags >>= 1n; }
  for (const size of sizes) r.skip(size);
}
function name(r) {
  const n = r.u32([[0,0],[4,0],[5,16],[10,48]]), data = new Uint8Array(n);
  for (let i = 0; i < n; i++) data[i] = r.read(8);
  try { return new TextDecoder('utf-8', {fatal:true}).decode(data); }
  catch { requireDecode(false, 'Invalid UTF-8 JPEG XL name.', r); }
}
function size(r, preview = false) {
  const small = bool(r);
  const choices = preview ? (small ? [[0,16],[0,32],[5,1],[9,33]] : [[6,1],[8,65],[10,321],[12,1345]]) : SIZE;
  const read = () => preview ? r.u32(choices) * (small ? 8 : 1) : small ? 8 * (1 + r.read(5)) : r.u32(choices);
  const height = read(), ratio = r.read(3);
  const width = ratio ? Math.floor(height * RATIOS[ratio][0] / RATIOS[ratio][1]) : read();
  return {width, height};
}
function depth(r) {
  const float = bool(r), bits = r.u32(float ? [[0,32],[0,16],[0,24],[6,1]] : [[0,8],[0,10],[0,12],[6,1]]);
  const exponentBits = float ? r.read(4) + 1 : 0;
  requireDecode(bits <= (float ? 32 : 31) && (!float || exponentBits <= 8 && bits > exponentBits + 1), 'Invalid JPEG XL sample depth.', r);
  return {float, bits, exponentBits};
}
function extraChannel(r) {
  if (bool(r)) return {type:0, bitDepth:{...DEFAULT_DEPTH}, dimShift:0, name:'', associated:false};
  const type = r.enum();
  requireDecode(type <= 6 || type === 15 || type === 16, 'Invalid JPEG XL extra channel type.', r);
  const bitDepth = depth(r), dimShift = r.u32([[0,0],[0,3],[0,4],[3,1]]), label = name(r);
  const channel = {type, bitDepth, dimShift, name:label, associated:false};
  if (type === 0) channel.associated = bool(r);
  if (type === 2) channel.spotColor = array(4, () => r.f16());
  if (type === 5) channel.cfaChannel = r.u32([[0,1],[2,0],[4,3],[8,19]]);
  return channel;
}
function xy(r) { return array(2, () => unpackSigned(r.u32([[19,0],[19,524288],[20,1048576],[21,2097152]])) / 1000000); }
function color(r) {
  const c = {space:'rgb', spaceId:0, wantICC:false, whitePoint:'d65', whitePointId:1, primaries:'srgb', primariesId:1, transferFunction:'srgb', transferId:13, renderingIntent:1};
  if (bool(r)) return c;
  c.wantICC = bool(r); c.spaceId = r.enum();
  requireDecode(c.spaceId <= 3, 'Invalid JPEG XL color space.', r);
  c.space = ['rgb','gray','xyb','unknown'][c.spaceId];
  if (c.wantICC) return c;
  if (c.spaceId !== 2) {
    c.whitePointId = r.enum();
    requireDecode([1,2,10,11].includes(c.whitePointId), 'Invalid JPEG XL white point.', r);
    c.whitePoint = c.whitePointId === 2 ? xy(r) : ({1:'d65',10:'e',11:'dci'})[c.whitePointId];
  }
  if (c.spaceId !== 1 && c.spaceId !== 2) {
    c.primariesId = r.enum();
    requireDecode([1,2,9,11].includes(c.primariesId), 'Invalid JPEG XL primaries.', r);
    c.primaries = c.primariesId === 2 ? array(3, () => xy(r)) : ({1:'srgb',9:'rec2020',11:'display-p3'})[c.primariesId];
  }
  if (c.spaceId === 2) { c.transferFunction = 'gamma'; c.gamma = 1 / 3; c.transferId = null; }
  else if (bool(r)) {
    c.transferId = null; c.transferFunction = 'gamma'; c.gamma = r.read(24) / 10000000;
    requireDecode(c.gamma > 0, 'Invalid JPEG XL gamma.', r);
  } else {
    c.transferId = r.enum();
    c.transferFunction = ({1:'bt709',2:'unknown',8:'linear',13:'srgb',16:'pq',17:'dci',18:'hlg'})[c.transferId];
    requireDecode(c.transferFunction !== undefined, 'Invalid JPEG XL transfer function.', r);
  }
  c.renderingIntent = r.enum(); requireDecode(c.renderingIntent <= 3, 'Invalid JPEG XL rendering intent.', r);
  return c;
}
function tone(r, extra) {
  const out = {intensityTarget:255, minNits:0, relativeToMaxDisplay:false, linearBelow:0};
  if (extra && !bool(r)) {
    out.intensityTarget = r.f16(); out.minNits = r.f16(); out.relativeToMaxDisplay = bool(r); out.linearBelow = r.f16();
    requireDecode(out.intensityTarget > 0 && out.minNits >= 0 && out.minNits <= out.intensityTarget && out.linearBelow >= 0 && (!out.relativeToMaxDisplay || out.linearBelow <= 1), 'Invalid JPEG XL tone mapping.', r);
  }
  return out;
}
export function readDecodeImageHeader(r, limits = {}) {
  r.expect(16, 0x0aff);
  const h = {...size(r), orientation:1, intrinsicSize:null, preview:null, animation:null};
  const side = limits.maxDimension ?? 65536;
  requireDecode(h.width > 0 && h.height > 0 && h.width * h.height <= (limits.maxPixels ?? 64000000), 'JPEG XL image exceeds the pixel limit.', r);
  requireDecode(h.width <= side && h.height <= side, 'JPEG XL image exceeds the dimension limit.', r);
  const defaults = bool(r), extra = !defaults && bool(r);
  if (extra) {
    h.orientation = r.read(3) + 1;
    if (bool(r)) h.intrinsicSize = size(r);
    if (bool(r)) h.preview = size(r, true);
    if (bool(r)) h.animation = {numerator:r.u32([[0,100],[0,1000],[10,1],[30,1]]), denominator:r.u32([[0,1],[0,1001],[8,1],[10,1]]), loops:r.u32([[0,0],[3,0],[16,0],[32,0]]), timecodes:bool(r)};
  }
  h.bitDepth = defaults ? {...DEFAULT_DEPTH} : depth(r);
  h.modular16 = defaults || bool(r);
  const count = defaults ? 0 : r.u32([[0,0],[0,1],[4,2],[12,1]]);
  requireDecode(count <= 256, 'Too many JPEG XL extra channels.', r);
  h.extraChannels = array(count, () => extraChannel(r));
  h.xyb = defaults || bool(r);
  h.colorEncoding = defaults ? {space:'rgb',spaceId:0,wantICC:false,whitePoint:'d65',whitePointId:1,primaries:'srgb',primariesId:1,transferFunction:'srgb',transferId:13,renderingIntent:1} : color(r);
  h.colorChannels = h.colorEncoding.spaceId === 1 ? 1 : 3;
  h.toneMapping = tone(r, extra);
  if (!defaults) readExtensions(r);
  h.opsinInverseMatrix = {inverseMatrix:[...DEFAULT_OPSIN.inverseMatrix],opsinBiases:[...DEFAULT_OPSIN.opsinBiases],quantBias:DEFAULT_OPSIN.quantizationBiases.slice(0,3),quantBiasNumerator:DEFAULT_OPSIN.quantizationBiases[3]};
  h.upsamplingWeights = {};
  if (!bool(r)) {
    if (h.xyb && !bool(r)) {
      h.opsinInverseMatrix = {inverseMatrix:array(9, () => r.f16()),opsinBiases:array(3, () => r.f16()),quantBias:array(3, () => r.f16()),quantBiasNumerator:r.f16()};
    }
    const mask = r.read(3);
    for (const [bit, factor, n] of [[1,2,15],[2,4,55],[4,8,210]]) if (mask & bit) h.upsamplingWeights[factor] = array(n, () => r.f16());
  }
  h.iccBitOffset = r.bit;
  return h;
}
const fullCanvas = (f,h) => f.x0 <= 0 && f.y0 <= 0 && f.x0 + f.width >= h.width && f.y0 + f.height >= h.height;
function blending(r, h, f, colorMode) {
  const mode = r.u32([[0,0],[0,1],[0,2],[2,3]]), hasAlpha = h.extraChannels.length > 0 && (mode === 2 || mode === 3);
  requireDecode(mode <= 4, 'Invalid JPEG XL blend mode.', r);
  const alpha = hasAlpha ? r.u32([[0,0],[0,1],[0,2],[3,3]]) : 0;
  requireDecode(!hasAlpha || alpha < h.extraChannels.length, 'Invalid JPEG XL blend alpha channel.', r);
  const clamp = (hasAlpha || mode === 4) && bool(r);
  const source = (colorMode ?? mode) !== 0 || !fullCanvas(f,h) ? r.read(2) : 0;
  return {mode, alpha, clamp, source};
}
function filters(r, modular, defaults) {
  const f = {gaborish:array(3, () => [0.115169525,0.061248592]),epf:{iters:2,sharpLut:array(8, (_,i) => i/7),channelScale:[40,5,3.5],quantMul:.46,pass0SigmaScale:.9,pass2SigmaScale:6.5,borderSadMul:2/3,sigmaForModular:1}};
  if (defaults || bool(r)) return f;
  if (!bool(r)) f.gaborish = null;
  else if (bool(r)) {
    f.gaborish = array(3, () => [r.f16(),r.f16()]);
    requireDecode(f.gaborish.every(w => Math.abs(1 + 4 * (w[0] + w[1])) > 1e-8), 'Invalid JPEG XL Gaborish weights.', r);
  }
  const e = f.epf; e.iters = r.read(2);
  if (e.iters) {
    if (!modular && bool(r)) e.sharpLut = array(8, () => r.f16());
    if (bool(r)) { e.channelScale = array(3, () => r.f16()); r.read(32); }
    if (bool(r)) {
      if (!modular) e.quantMul = r.f16();
      e.pass0SigmaScale = r.f16(); e.pass2SigmaScale = r.f16(); e.borderSadMul = r.f16();
    }
    if (modular) e.sigmaForModular = r.f16();
  }
  readExtensions(r); return f;
}
export function readDecodeFrameHeader(r, h, limits = {}) {
  r.align(); const start = r.bit / 8, defaults = bool(r);
  const f = {start,type:0,encoding:0,flags:0n,ycbcr:false,jpegUpsampling:[0,0,0],upsampling:1,extraUpsampling:array(h.extraChannels.length,()=>1),groupSizeShift:1,xQmScale:h.xyb?3:2,bQmScale:2,passes:{count:1,shift:[0],downsample:[],lastPass:[]},lfLevel:0,x0:0,y0:0,width:h.width,height:h.height,duration:0,timecode:0,isLast:true,saveAsReference:0,saveBeforeColorTransform:false,name:''};
  if (!defaults) { f.type = r.read(2); f.encoding = r.read(1); f.flags = r.u64BigInt(); }
  f.modular = !!f.encoding; f.useLFFrame = !!(f.flags & 32n); f.skipAdaptiveLFSmoothing = !!(f.flags & 128n);
  if (!defaults && !h.xyb) f.ycbcr = bool(r);
  if (f.ycbcr && !f.useLFFrame) f.jpegUpsampling = array(3, () => r.read(2));
  if (!defaults && !f.useLFFrame) { f.upsampling = r.u32(SCALE); f.extraUpsampling = array(h.extraChannels.length, () => r.u32(SCALE)); }
  if (f.modular) { f.groupSizeShift = r.read(2); f.xQmScale = 2; }
  if (!defaults && h.xyb && !f.modular) { f.xQmScale = r.read(3); f.bQmScale = r.read(3); }
  if (!defaults && f.type !== 2) {
    const p = f.passes; p.count = r.u32([[0,1],[0,2],[0,3],[3,4]]);
    if (p.count > 1) {
      const n = r.u32([[0,0],[0,1],[0,2],[1,3]]);
      requireDecode(n <= p.count, 'Invalid JPEG XL progressive pass count.', r);
      p.shift = [...array(p.count-1, () => r.read(2)),0];
      p.downsample = array(n, () => r.u32(SCALE)); p.lastPass = array(n, () => r.u32([[0,0],[0,1],[0,2],[3,0]]));
      requireDecode(p.lastPass.every((v,i) => v < p.count && (!i || v > p.lastPass[i-1] && p.downsample[i] < p.downsample[i-1])), 'Invalid JPEG XL progressive pass order.', r);
    }
  }
  if (f.type === 1) f.lfLevel = 1 + r.read(2);
  f.haveCrop = !defaults && f.type !== 1 && bool(r);
  if (f.haveCrop) {
    if (f.type !== 2) { f.x0 = unpackSigned(r.u32(FRAME_SIZE)); f.y0 = unpackSigned(r.u32(FRAME_SIZE)); }
    f.width = r.u32(FRAME_SIZE); f.height = r.u32(FRAME_SIZE);
  }
  requireDecode(f.width > 0 && f.height > 0 && f.width * f.height <= (limits.maxPixels ?? 64000000), 'JPEG XL frame exceeds the pixel limit.', r);
  requireDecode(f.width <= (limits.maxDimension ?? 65536) && f.height <= (limits.maxDimension ?? 65536), 'JPEG XL frame exceeds the dimension limit.', r);
  const normal = f.type === 0 || f.type === 3;
  f.blending = [{mode:0,alpha:0,clamp:false,source:0}, ...array(h.extraChannels.length, () => ({mode:0,alpha:0,clamp:false,source:0}))];
  if (!defaults && normal) {
    f.blending[0] = blending(r,h,f);
    for (let i=0;i<h.extraChannels.length;i++) f.blending[i+1] = blending(r,h,f,f.blending[0].mode);
    if (h.animation) { f.duration = r.u32([[0,0],[0,1],[8,0],[32,0]]); if (h.animation.timecodes) f.timecode = r.read(32); }
    f.isLast = bool(r);
  } else f.isLast = f.type === 0;
  if (!defaults && f.type !== 1 && !f.isLast) f.saveAsReference = r.read(2);
  f.resetsCanvas = f.blending[0].mode === 0 && fullCanvas(f,h);
  f.saveBeforeColorTransform = !normal;
  if (!defaults && (f.type === 2 || f.resetsCanvas && !f.isLast && (f.duration === 0 || f.saveAsReference !== 0) && f.type !== 1)) f.saveBeforeColorTransform = bool(r);
  if (!defaults) f.name = name(r);
  f.filter = filters(r,f.modular,defaults); if (!defaults) readExtensions(r);
  f.groupDim = 128 << f.groupSizeShift;
  f.encodedWidth = Math.ceil(f.width / (f.upsampling * power2(3*f.lfLevel)));
  f.encodedHeight = Math.ceil(f.height / (f.upsampling * power2(3*f.lfLevel)));
  f.groupsX = Math.ceil(f.encodedWidth / f.groupDim); f.groupsY = Math.ceil(f.encodedHeight / f.groupDim); f.numGroups = f.groupsX*f.groupsY;
  f.lfGroupsX = Math.ceil(f.encodedWidth / (8*f.groupDim)); f.lfGroupsY = Math.ceil(f.encodedHeight / (8*f.groupDim)); f.numLFGroups = f.lfGroupsX*f.lfGroupsY;
  f.encodedColorChannels = f.modular && !f.ycbcr && !h.xyb ? h.colorChannels : 3;
  for (let i=0;i<h.extraChannels.length;i++) requireDecode(f.extraUpsampling[i]*power2(h.extraChannels[i].dimShift) >= f.upsampling, 'Extra channel is smaller than its sampling grid.', r);
  return f;
}
export function readDecodeTOC(r, f) {
  const count = f.numGroups === 1 && f.passes.count === 1 ? 1 : 2 + f.numLFGroups + f.numGroups*f.passes.count;
  requireDecode(count <= 1000000, 'JPEG XL table of contents is too large.', r);
  let order = null;
  if (bool(r)) { const code = readEntropy(r,8); order = readPermutation(code,count); code.finish(); }
  r.align(); const sizes = array(count, () => r.u32([[10,0],[14,1024],[22,17408],[30,4211712]])); r.align();
  let offset = r.bit / 8; const physical = [];
  for (const length of sizes) {
    requireDecode(length <= r.bytes.length-offset, 'Truncated JPEG XL frame section.', r);
    physical.push({offset,length}); offset += length;
  }
  const sections = order ? Array.from(order, i => physical[i]) : physical;
  f.end = offset; f.sections = sections; r.bit = offset*8;
  return sections.map(s => new JxlBits(r.bytes.subarray(s.offset,s.offset+s.length)));
}
