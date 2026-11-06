// SPDX-License-Identifier: MIT
import {header} from './inspect.mjs';
import {isDecoded} from './describe.mjs';
import {check, fail} from './primitives.mjs';
import {nativePicture, decodesJXL} from '../native-picture.mjs';
import {configuredDecoder} from '../shown-picture.mjs';
import {ownDecoder} from './verify-own.mjs';

const SETUP = " here needs configureDecoder(decode, restore) with rapier-jxl/decode's decode and rapier-jxl/jpeg's restore.";
const host = name => configuredDecoder()?.[name] ?? ownDecoder?.[name];

function whyHost(info, options) {
  const encoding = info.colorEncoding, alphas = info.extraChannels;
  if (options.region) return 'Banded verification';
  if (info.animation) return 'Verifying an animation';
  if (info.bitDepth.float || info.bitDepth.bits !== 8) return 'Verifying a file of more than 8 bits or float samples';
  if (encoding.wantICC || encoding.space !== 'rgb' || encoding.whitePoint !== 'd65' || !['srgb', 'display-p3'].includes(encoding.primaries) ||
      encoding.transferFunction !== 'srgb' || info.toneMapping?.intensityTarget !== 255)
    return 'Verifying a file whose color is not sRGB or Display P3';
  if (info.orientation !== 1 || alphas.length > 1 || alphas.some(c => c.type !== 0 || c.associated || c.bitDepth.float || c.bitDepth.bits !== 8 || c.dimShift))
    return 'Verifying a file with orientation or extra channels';
  if ((options.colorSpace ?? 'original') !== 'original' || options.unpremultiplyAlpha) return 'Verifying in another color space';
  return null;
}

function shown(info, picture) {
  const {primaries, renderingIntent} = info.colorEncoding;
  const encoding = {space: 'rgb', whitePoint: 'd65', primaries, transferFunction: 'srgb', renderingIntent};
  return {width: info.width, height: info.height, data: new Uint8Array(picture.data.buffer, picture.data.byteOffset, picture.data.length),
    format: 'uint8', planes: [], extraChannels: info.extraChannels.map(channel => ({...channel})), colorEncoding: encoding, icc: null,
    rgbaColorEncoding: encoding, rgbaICC: null, duration: 0, durationSeconds: 0, alphaPremultiplied: false, orientation: 1,
    orientationApplied: false, animation: null, bitDepth: 8, sampleFormat: 'uint', colorSpace: primaries, transferFunction: 'srgb', header: info};
}

export async function decodeFile(bytes, options) {
  const info = header(bytes), why = whyHost(info, options);
  if (!options.region && options.maxPixels !== undefined && info.width * info.height > options.maxPixels)
    throw fail('JXL_DECODE', `The JPEG XL image is ${info.width}x${info.height}, over maxPixels (${options.maxPixels}).`);
  if (!why && await decodesJXL()) {
    check(options.signal);
    return shown(info, await nativePicture(bytes, {width: info.width, height: info.height, colorSpace: info.colorEncoding.primaries,
      signal: options.signal, ...(options.maxPixels !== undefined && {maxPixels: options.maxPixels})}));
  }
  const decode = host('decode');
  if (!decode) throw fail('JXL_UNSUPPORTED', (why ?? 'Verifying a JPEG XL file') + SETUP + (why ? '' : ' Or use a browser that decodes JPEG XL.'));
  const decoded = await decode(bytes.slice(), options);
  check(options.signal);
  if (!isDecoded(decoded)) throw fail('JXL_PLATFORM', "Verify reads files with rapier-jxl/decode's decode: configureDecoder(decode, restore).");
  return decoded;
}

export async function restoreFile(bytes, {maxPixels, signal}) {
  const configured = configuredDecoder()?.restore;
  if (configured) {
    const restored = await configured(bytes.slice(), {maxPixels, signal});
    check(signal);
    const out = restored?.bytes ?? restored;
    if (!(out instanceof Uint8Array)) throw fail('JXL_PLATFORM', "The configured restore must be rapier-jxl/jpeg's restore.");
    return out;
  }
  if (ownDecoder) return ownDecoder.restore(bytes, {maxPixels});
  throw fail('JXL_UNSUPPORTED', 'Verifying a recompressed JPEG' + SETUP);
}

export const jpegReader = () => ownDecoder?.readJPEG;
