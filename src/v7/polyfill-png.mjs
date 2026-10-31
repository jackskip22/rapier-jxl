// SPDX-License-Identifier: MIT
const signature = new Uint8Array([137,80,78,71,13,10,26,10]);
const error = message => Object.assign(new Error(message), {code: 'JXL_DISPLAY'});
const check = signal => signal?.throwIfAborted();
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const text = value => Uint8Array.from(value, c => c.charCodeAt(0));
const crcTable = Uint32Array.from({length: 256}, (_, i) => {
  for (let j = 0; j < 8; j++) i = i & 1 ? 0xedb88320 ^ i >>> 1 : i >>> 1;
  return i >>> 0;
});
function chunk(type, data = new Uint8Array()) {
  if (data.length > 0x7fffffff) throw error('PNG chunk exceeds its size limit.');
  const out = new Uint8Array(data.length + 12), view = new DataView(out.buffer);
  view.setUint32(0, data.length); out.set(text(type), 4); out.set(data, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < out.length - 4; i++) crc = crcTable[(crc ^ out[i]) & 255] ^ crc >>> 8;
  view.setUint32(out.length - 4, (crc ^ 0xffffffff) >>> 0);
  return out;
}
const equal = (a, b) => a === b || a?.length === b?.length && a?.every((v, i) => v === b[i]);
function color(frame) {
  const encoding = frame.rgbaColorEncoding, profile = frame.rgbaICC;
  if (!encoding || frame.alphaPremultiplied) throw error('PNG needs declared color and straight alpha.');
  if (profile?.length) {
    if (!(profile instanceof Uint8Array) || profile.length < 128) throw error('PNG needs a complete ICC profile.');
    const space = String.fromCharCode(...profile.subarray(16, 20));
    if (space !== 'RGB ' && space !== 'GRAY') throw error('PNG supports only RGB or gray ICC pixels.');
    return {type: space === 'GRAY' ? 4 : 6, profile, intent: null};
  }
  if (encoding.wantICC || encoding.iccSpace || encoding.transferFunction !== 'srgb' ||
      !['rgb', 'gray'].includes(encoding.space) || (encoding.whitePoint ?? 'd65') !== 'd65' ||
      encoding.space === 'rgb' && (encoding.primaries ?? 'srgb') !== 'srgb')
    throw error('This output color encoding needs a supported ICC profile or an explicit display conversion.');
  const intent = encoding.renderingIntent ?? 1;
  if (!integer(intent, 0, 3)) throw error('Invalid sRGB rendering intent.');
  return {type: 6, profile: null, intent};
}
function delay(frame, animation) {
  if (!integer(frame.duration, 0, 0xffffffff) || !integer(animation.numerator, 1, 0xffffffff) ||
      !integer(animation.denominator, 1, 0xffffffff)) throw error('Invalid animation tick values.');
  let n = BigInt(frame.duration) * BigInt(animation.denominator), d = BigInt(animation.numerator);
  let a = n, b = d;
  while (b) [a, b] = [b, a % b];
  n /= a; d /= a;
  if (n > 65535n || d > 65535n) throw error('The animation delay cannot be represented exactly in PNG.');
  return [Number(n), Number(d)];
}
async function deflate(source, signal, maximum) {
  check(signal);
  if (typeof CompressionStream !== 'function') throw error('PNG display needs CompressionStream.');
  const reader = source.pipeThrough(new CompressionStream('deflate')).getReader();
  const abort = () => { reader.cancel(signal.reason).catch(() => {}); };
  signal?.addEventListener('abort', abort, {once: true});
  const parts = []; let size = 0;
  try {
    for (;;) {
      check(signal);
      const {value, done} = await reader.read();
      check(signal);
      if (done) break;
      size += value.length;
      if (size > maximum) throw error('PNG display exceeds maxBytes.');
      parts.push(value);
    }
    const bytes = new Uint8Array(size); let at = 0;
    for (const part of parts) { bytes.set(part, at); at += part.length; }
    return bytes;
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
}
function rows(frame, type, signal) {
  let y = 0;
  const sixteen = frame.format === 'uint16', channels = type === 4 ? [0, 3] : [0, 1, 2, 3];
  return new ReadableStream({pull(controller) {
    check(signal);
    if (y === frame.height) { controller.close(); return; }
    const row = new Uint8Array(1 + frame.width * channels.length * (sixteen ? 2 : 1));
    let at = 1;
    for (let x = 0; x < frame.width; x++) {
      const p = (y * frame.width + x) * 4;
      if (type === 4 && (frame.data[p] !== frame.data[p + 1] || frame.data[p] !== frame.data[p + 2]))
        throw error('Gray ICC pixels have unequal RGB channels.');
      for (const channel of channels) {
        const sample = frame.data[p + channel];
        if (sixteen) row[at++] = sample >>> 8;
        row[at++] = sample & 255;
      }
    }
    y++; controller.enqueue(row);
  }});
}

export async function decodedPNG(image, {signal, maxBytes = 268435456} = {}) {
  check(signal);
  if (!integer(maxBytes, 1, 0x7fffffff)) throw error('maxBytes must be a positive PNG byte budget.');
  const frames = image?.frames?.length ? image.frames : [image], first = frames[0];
  if (!first || !integer(first.width, 1, 0x7fffffff) || !integer(first.height, 1, 0x7fffffff) ||
      first.width * first.height > Math.floor(maxBytes / 4)) throw error('PNG dimensions exceed the display budget.');
  if (image.orientationApplied !== true && image.orientation && image.orientation !== 1)
    throw error('Apply image orientation before PNG display.');
  const {type, profile, intent} = color(first), animated = frames.length > 1 || !!image.animation;
  const animation = image.animation;
  if (animated && (!animation || !integer(animation.loops, 0, 0xffffffff) || frames.length > 0x7fffffff))
    throw error('PNG animation needs an exact loop count and timebase.');
  const delays = [];
  for (const frame of frames) {
    const c = color(frame);
    if (frame.width !== first.width || frame.height !== first.height || frame.format !== first.format ||
        c.type !== type || c.intent !== intent || !equal(c.profile, profile)) throw error('PNG frames must share dimensions, depth and color.');
    if (!(frame.format === 'uint8' && (frame.data instanceof Uint8Array || frame.data instanceof Uint8ClampedArray) ||
          frame.format === 'uint16' && frame.data instanceof Uint16Array) || frame.data.length !== frame.width * frame.height * 4)
      throw error('PNG display supports integer RGBA8 or RGBA16 only.');
    if (animated) delays.push(delay(frame, animation));
  }
  const parts = [signature]; let size = signature.length;
  const add = (name, data) => { const part = chunk(name, data); size += part.length; if (size > maxBytes) throw error('PNG display exceeds maxBytes.'); parts.push(part); };
  const header = new Uint8Array(13), h = new DataView(header.buffer);
  h.setUint32(0, first.width); h.setUint32(4, first.height); header[8] = first.format === 'uint16' ? 16 : 8; header[9] = type;
  add('IHDR', header);
  if (profile) {
    if (profile.length > maxBytes) throw error('ICC profile exceeds the display budget.');
    const compressed = await deflate(new Blob([profile]).stream(), signal, maxBytes - size);
    const payload = new Uint8Array(compressed.length + 5); payload.set([74,88,76,0,0]); payload.set(compressed, 5); add('iCCP', payload);
  } else add('sRGB', new Uint8Array([intent]));
  if (animated) {
    const data = new Uint8Array(8), view = new DataView(data.buffer);
    view.setUint32(0, frames.length); view.setUint32(4, animation.loops); add('acTL', data);
  }
  let sequence = 0;
  for (let index = 0; index < frames.length; index++) {
    check(signal);
    if (animated) {
      const data = new Uint8Array(26), view = new DataView(data.buffer);
      view.setUint32(0, sequence++); view.setUint32(4, first.width); view.setUint32(8, first.height);
      view.setUint16(20, delays[index][0]); view.setUint16(22, delays[index][1]);
      add('fcTL', data);
    }
    const compressed = await deflate(rows(frames[index], type, signal), signal, maxBytes - size);
    if (!index) add('IDAT', compressed);
    else { const data = new Uint8Array(compressed.length + 4); new DataView(data.buffer).setUint32(0, sequence++); data.set(compressed, 4); add('fdAT', data); }
  }
  add('IEND'); check(signal);
  return new Blob(parts, {type: 'image/png'});
}
