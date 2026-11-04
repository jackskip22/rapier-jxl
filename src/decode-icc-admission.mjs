// SPDX-License-Identifier: MIT
import {inspectICC} from './icc-profile.mjs';
import {requireDecode} from './decode-bits.mjs';

export const iccProfileLimit = (level, maxBytes) => Math.min(maxBytes, level === 10 ? 0xffffffff : 4 * 1024 * 1024);

export function admitDecodedICC(profile, header, level) {
  const cmyk = profile.length >= 20 && String.fromCharCode(...profile.subarray(16, 20)) === 'CMYK';
  let channels;
  try { channels = inspectICC(profile, level, cmyk ? 'cmyk' : undefined); }
  catch (cause) { requireDecode(false, cause.message); }
  requireDecode(channels === header.colorChannels, 'ICC and codestream color-channel counts differ.');
  requireDecode(!cmyk || level === 10 && header.extraChannels.some(channel => channel.type === 4),
    'A CMYK profile requires level 10 and a black extra channel.');
}
