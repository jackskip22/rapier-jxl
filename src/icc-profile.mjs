// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';
import {journaling, journalTool} from './step-journal.mjs';

function profileHeader(profile, level, expectedColorSpace) {
  if (expectedColorSpace !== undefined && !['rgb', 'gray', 'cmyk'].includes(expectedColorSpace))
    throw fault('JXL_INPUT', 'The expected ICC source space is rgb, gray or cmyk.');
  if (!(profile instanceof Uint8Array) || profile.length < 132) throw fault('JXL_INPUT', 'ICC is a Uint8Array of the complete profile.');
  if (level === 5 && profile.length > 4 * 1024 * 1024)
    throw fault('JXL_SIZE', 'Level 5 ICC profiles are at most 4 MiB.');
  const head = profile.subarray(0, 132), view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const signature = at => String.fromCharCode(head[at], head[at + 1], head[at + 2], head[at + 3]);
  if (view.getUint32(0) !== profile.length || signature(36) !== 'acsp') throw fault('JXL_INPUT', 'ICC size or profile signature is invalid.');
  const space = signature(16), connection = signature(20);
  if (!['RGB ', 'XYZ ', 'Lab ', 'Luv ', 'YCbr', 'Yxy ', 'HSV ', 'HLS ', 'CMY ', '3CLR', 'GRAY'].includes(space) &&
      !(space === 'CMYK' && expectedColorSpace === 'cmyk'))
    throw fault('JXL_INPUT', 'ICC needs RGB, GRAY, or CMYK with a planar-channel context.');
  if (expectedColorSpace !== undefined && space !== {rgb: 'RGB ', gray: 'GRAY', cmyk: 'CMYK'}[expectedColorSpace])
    throw fault('JXL_INPUT', 'The ICC space does not match the channels.');
  if (space === 'CMYK' && level === 5) throw fault('JXL_INPUT', 'CMYK and black channels need level 10.');
  if (connection !== 'XYZ ' && connection !== 'Lab ') throw fault('JXL_INPUT', 'ICC profile connection space must be XYZ or Lab.');
  const count = view.getUint32(128);
  if (count > Math.floor((profile.length - 132) / 12)) throw fault('JXL_INPUT', 'ICC tag table exceeds the profile.');
  return {count, end: 132 + count * 12, channels: space === 'GRAY' ? 1 : 3};
}
function profileTags(profile, head, first, last) {
  const bytes = profile.subarray(132 + first * 12, 132 + last * 12), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < last - first; i++) {
    const at = i * 12, offset = view.getUint32(at + 4), length = view.getUint32(at + 8);
    if (offset < head.end || offset % 4 || length < 8 || offset > profile.length || length > profile.length - offset)
      throw fault('JXL_INPUT', 'ICC tag data is unaligned or outside the profile.');
  }
}
export function inspectICC(profile, level, expectedColorSpace) {
  const head = profileHeader(profile, level, expectedColorSpace);
  for (let first = 0; first < head.count; first += 4096) profileTags(profile, head, first, Math.min(head.count, first + 4096));
  return head.channels;
}
export function* inspectICCSteps(profile, level, expectedColorSpace) {
  if (!journaling()) return inspectICC(profile, level, expectedColorSpace);
  return yield* journalTool('inspectICC')(profile, level, expectedColorSpace, {header: profileHeader, tags: profileTags});
}
