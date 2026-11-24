import {fail, dimensions} from './primitives.mjs';
import {isPlainRecord} from './records.mjs';
import {DESCRIPTION, described} from './describe.mjs';
import {own, measure, record as ownRecord, DEFAULT_INPUT_BYTES} from './ownership.mjs';
import {gpuWait, gpuMap} from '../gpu-kit.mjs';

const FORMATS = {rgba8unorm: [4, 0], 'rgba8unorm-srgb': [4, 0], bgra8unorm: [4, 1], 'bgra8unorm-srgb': [4, 1], rgba16float: [8, 0], rgba32float: [16, 0]};
const CHANNEL_FORMATS = {depth16unorm: [2, 'depth-only', {bitDepth: 16}], depth32float: [4, 'depth-only', {}], r16uint: [2, 'all', {bitDepth: 16}],
  r16float: [2, 'all', {sampleFormat: 'float16'}], r32float: [4, 'all', {}]};
let fieldsSet = null;
const textureFields = () => fieldsSet ??= new Set(['texture', 'device', 'layer', ...DESCRIPTION]);
export const isTexture = input => isPlainRecord(input) && input.texture !== undefined && input.device !== undefined && input.data === undefined;

function copyOut(device, texture, layer, bytes, aspect, refused) {
  const {width, height} = texture, row = Math.ceil(width * bytes / 256) * 256, packed = width * bytes;
  const limit = device?.limits?.maxBufferSize, stripe = aspect !== 'depth-only' && limit >= row ? Math.min(height, Math.floor(limit / row)) : height;
  const buffers = [], destroy = () => { for (const buffer of buffers) buffer.destroy(); };
  let pushed = false;
  try {
    device.pushErrorScope('validation');
    pushed = true;
    const encoder = device.createCommandEncoder();
    for (let y = 0; y < height; y += stripe) {
      const rows = Math.min(stripe, height - y), buffer = device.createBuffer({size: row * rows, usage: 1 | 8});
      buffers.push(buffer);
      encoder.copyTextureToBuffer({texture, origin: {x: 0, y, z: layer}, aspect}, {buffer, bytesPerRow: row, rowsPerImage: rows}, {width, height: rows, depthOrArrayLayers: 1});
    }
    device.queue.submit([encoder.finish()]);
  } catch (cause) {
    if (pushed) Promise.resolve().then(() => device.popErrorScope()).catch(() => {});
    destroy();
    throw refused(cause);
  }
  return gpuWait(device, device.popErrorScope()).then(invalid => { if (invalid) throw invalid; return Promise.all(buffers.map(buffer => gpuMap(device, buffer))); }).then(() => {
    const out = new Uint8Array(packed * height);
    buffers.forEach((buffer, i) => {
      const mapped = new Uint8Array(buffer.getMappedRange()), top = i * stripe, rows = Math.min(stripe, height - top);
      for (let y = 0; y < rows; y++) out.set(mapped.subarray(y * row, y * row + packed), (top + y) * packed);
      buffer.unmap();
    });
    return out;
  }).catch(cause => { throw refused(cause); }).finally(destroy);
}

export const readTexture = ((typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) || (typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true)) ? null : function readTexture(input, maxPixels, acquire) {
  const fields = textureFields();
  for (const [key] of ownRecord(input)) if (!fields.has(key))
    throw fail('JXL_INPUT', `unknown texture field: ${key}`);
  const {texture, device, layer = 0} = input;
  const layout = typeof texture?.format === 'string' && Object.hasOwn(FORMATS, texture.format) ? FORMATS[texture.format] : null;
  if (!layout) throw fail('JXL_INPUT', "texture format: rgba8unorm, bgra8unorm, -srgb, rgba16float, rgba32float");
  if (texture.dimension !== '2d' || texture.sampleCount > 1) throw fail('JXL_INPUT', "texture: 2D single-sample");
  if (!(texture.usage & 1)) throw fail('JXL_INPUT', "texture: COPY_SRC required");
  const layers = texture.depthOrArrayLayers ?? 1;
  if (!Number.isSafeInteger(layer) || layer < 0 || layer >= layers) throw fail('JXL_INPUT', `texture layer: integer 0-${layers - 1}`);
  const {width, height} = texture, [bytes, swap] = layout;
  dimensions(width, height, maxPixels);
  const description = described(input);
  if (bytes > 4) description.transferFunction ??= 'linear';
  else if (texture.format.endsWith('-srgb') && description.transferFunction !== undefined && description.transferFunction !== 'srgb')
    throw fail('JXL_INPUT', "texture -srgb: declare sRGB");
  const refused = cause => Object.assign(fail('JXL_INPUT', "texture read: live device, COPY_SRC"), {cause});
  const channels = Array.isArray(description.extraChannels) ? description.extraChannels.map(channel => {
    if (!isPlainRecord(channel) || channel.texture === undefined) return null;
    if (channel.data !== undefined) throw fail('JXL_INPUT', "extra channel: pass data or texture, not both");
    const fmtName = channel.texture?.format;
    const format = typeof fmtName === 'string' && Object.hasOwn(CHANNEL_FORMATS, fmtName) ? CHANNEL_FORMATS[fmtName] : null;
    const shift = channel.dimShift ?? 0, scale = 2 ** shift;
    if (!format) throw fail('JXL_INPUT', "channel format: depth16unorm, depth32float, r16uint, r16float, r32float");
    const t = channel.texture;
    if (t.dimension !== '2d' || t.sampleCount > 1 || !(t.usage & 1)) throw fail('JXL_INPUT', "channel texture: 2D single-sample COPY_SRC");
    if (t.width !== Math.ceil(width / scale) || t.height !== Math.ceil(height / scale) || layer >= (t.depthOrArrayLayers ?? 1))
      throw fail('JXL_INPUT', "channel texture: match size, dimShift, layer");
    return format;
  }) : [];
  const extras = description.extraChannels;
  if (channels.some(Boolean)) description.extraChannels = extras.map((channel, i) => {
    if (!channels[i]) return channel;
    const {texture: _texture, ...rest} = channel;
    return rest;
  });
  const fixed = own(description, maxPixels, Math.max(DEFAULT_INPUT_BYTES, maxPixels * 16));
  const costOf = (t, size) => (Math.ceil(t.width * size / 256) * 256 + t.width * size) * t.height;
  const cost = measure(fixed, maxPixels) + 16 + costOf(texture, bytes) + channels.reduce((sum, format, i) =>
    sum + (format ? costOf(extras[i].texture, format[0]) : 0), 0);
  const take = () => {
    const read = [copyOut(device, texture, layer, bytes, 'all', refused)];
    try { for (let i = 0; i < channels.length; i++) read.push(channels[i] && copyOut(device, extras[i].texture, layer, channels[i][0], channels[i][1], refused)); }
    catch (cause) { read.push(Promise.reject(cause)); }
    return Promise.allSettled(read).then(results => {
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      const [out, ...samples] = results.map(result => result.value);
      if (swap) for (let i = 0; i < out.length; i += 4) { const b = out[i]; out[i] = out[i + 2]; out[i + 2] = b; }
      const data = bytes === 4 ? out : bytes === 8 ? new Uint16Array(out.buffer) : new Float32Array(out.buffer);
      if (channels.some(Boolean)) fixed.extraChannels = fixed.extraChannels.map((channel, i) => {
        if (!channels[i]) return channel;
        const [size, , given] = channels[i];
        return {...channel, ...given, data: size === 4 ? new Float32Array(samples[i].buffer) : new Uint16Array(samples[i].buffer)};
      });
      return {...fixed, ...(bytes === 8 && {sampleFormat: 'float16'}), data, width, height};
    });
  };
  return acquire ? acquire(take, cost, width * height) : take();
};
