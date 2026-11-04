import {fail, dimensions} from './primitives.mjs';
import {isPlainRecord} from './records.mjs';
import {DESCRIPTION, described} from './describe.mjs';
import {own, measure, DEFAULT_INPUT_BYTES} from './ownership.mjs';

const FORMATS = {rgba8unorm: [4, 0], 'rgba8unorm-srgb': [4, 0], bgra8unorm: [4, 1], 'bgra8unorm-srgb': [4, 1], rgba16float: [8, 0], rgba32float: [16, 0]};
const CHANNEL_FORMATS = {depth16unorm: [2, 'depth-only', {bitDepth: 16}], depth32float: [4, 'depth-only', {}], r16uint: [2, 'all', {bitDepth: 16}],
  r16float: [2, 'all', {sampleFormat: 'float16'}], r32float: [4, 'all', {}]};
const FIELDS = new Set(['texture', 'device', 'layer', ...DESCRIPTION]);
export const isTexture = input => isPlainRecord(input) && input.texture !== undefined && input.device !== undefined && input.data === undefined;

function copyOut(device, texture, layer, bytes, aspect, refused) {
  const {width, height} = texture, row = Math.ceil(width * bytes / 256) * 256, size = row * height;
  let buffer, pushed = false;
  try {
    device.pushErrorScope('validation');
    pushed = true;
    buffer = device.createBuffer({size, usage: 1 | 8});
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({texture, origin: {x: 0, y: 0, z: layer}, aspect}, {buffer, bytesPerRow: row, rowsPerImage: height}, {width, height, depthOrArrayLayers: 1});
    device.queue.submit([encoder.finish()]);
  } catch (cause) {
    if (pushed) device.popErrorScope().catch(() => {});
    buffer?.destroy();
    throw refused(cause);
  }
  return device.popErrorScope().then(invalid => { if (invalid) throw invalid; return buffer.mapAsync(1); }).then(() => {
    const mapped = new Uint8Array(buffer.getMappedRange()), out = new Uint8Array(width * height * bytes);
    for (let y = 0; y < height; y++) out.set(mapped.subarray(y * row, y * row + width * bytes), y * width * bytes);
    buffer.unmap();
    return out;
  }).catch(cause => { throw refused(cause); }).finally(() => buffer.destroy());
}

export function readTexture(input, maxPixels, acquire) {
  for (const key of Object.keys(input)) if (!FIELDS.has(key))
    throw fail('JXL_INPUT', `Unknown texture field: ${key}.`);
  const {texture, device, layer = 0} = input, layout = FORMATS[texture?.format];
  if (!layout) throw fail('JXL_INPUT', 'A texture is rgba8unorm, bgra8unorm (or -srgb), rgba16float or rgba32float.');
  if (texture.dimension !== '2d' || texture.sampleCount > 1) throw fail('JXL_INPUT', 'A texture input is a 2D texture with one sample.');
  if (!(texture.usage & 1)) throw fail('JXL_INPUT', 'The texture needs COPY_SRC usage to be read.');
  const layers = texture.depthOrArrayLayers ?? 1;
  if (!Number.isSafeInteger(layer) || layer < 0 || layer >= layers) throw fail('JXL_INPUT', `layer is a whole number below ${layers}.`);
  const {width, height} = texture, [bytes, swap] = layout;
  dimensions(width, height, maxPixels);
  const description = described(input);
  if (bytes > 4) description.transferFunction ??= 'linear';
  else if (texture.format.endsWith('-srgb') && description.transferFunction !== undefined && description.transferFunction !== 'srgb')
    throw fail('JXL_INPUT', 'An -srgb texture format holds sRGB-encoded samples.');
  const refused = cause => Object.assign(fail('JXL_INPUT', 'The texture could not be read: ' + (cause?.message || cause)), {cause});
  const channels = Array.isArray(description.extraChannels) ? description.extraChannels.map(channel => {
    if (!isPlainRecord(channel) || channel.texture === undefined) return null;
    if (channel.data !== undefined) throw fail('JXL_INPUT', 'An extra channel takes data or a texture, not both.');
    const format = CHANNEL_FORMATS[channel.texture?.format], shift = channel.dimShift ?? 0, scale = 2 ** shift;
    if (!format) throw fail('JXL_INPUT', 'A channel texture is depth16unorm, depth32float, r16uint, r16float or r32float.');
    const t = channel.texture;
    if (t.dimension !== '2d' || t.sampleCount > 1 || !(t.usage & 1)) throw fail('JXL_INPUT', 'A channel texture is 2D, one sample, COPY_SRC.');
    if (t.width !== Math.ceil(width / scale) || t.height !== Math.ceil(height / scale) || layer >= (t.depthOrArrayLayers ?? 1))
      throw fail('JXL_INPUT', 'A channel texture matches the picture\'s size (or 2^dimShift less) and layer.');
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
}
