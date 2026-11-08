// SPDX-License-Identifier: MIT
import {inspectICC, inspectICCSteps} from './icc-profile.mjs';
import {requireDecode} from './decode-bits.mjs';
import {journalTool} from './step-journal.mjs';

export const iccProfileLimit = (level, maxBytes) => Math.min(maxBytes, level === 10 ? 0xffffffff : 4 * 1024 * 1024);

const cmykICC = profile => profile.length >= 20 && String.fromCharCode(...profile.subarray(16, 20)) === 'CMYK';

export function admitDecodedICC(profile, header, level) {
  const cmyk = cmykICC(profile);
  let channels;
  try { channels = inspectICC(profile, level, cmyk ? 'cmyk' : undefined); }
  catch (cause) { requireDecode(false, cause.message); }
  admitChannels(channels, cmyk, header, level);
}
function admitChannels(channels, cmyk, header, level) {
  requireDecode(channels === header.colorChannels, 'ICC and codestream color-channel counts differ.');
  requireDecode(!cmyk || level === 10 && header.extraChannels.some(channel => channel.type === 4),
    'A CMYK profile requires level 10 and a black extra channel.');
}

export function* admitDecodedICCSteps(profile, header, level) {
  return yield* journalTool('admitDecodedICC')(profile, header, level,
    {cmyk: cmykICC, inspect: inspectICCSteps, require: requireDecode, channels: admitChannels});
}
