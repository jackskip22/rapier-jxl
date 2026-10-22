// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';

export function inspectICC(profile, level, expectedColorSpace) {
  if (expectedColorSpace !== undefined && !['rgb', 'gray', 'cmyk'].includes(expectedColorSpace))
    throw fault('JXL_INPUT', 'The expected ICC source space is rgb, gray or cmyk.');
  if (!(profile instanceof Uint8Array) || profile.length < 132) throw fault('JXL_INPUT', 'ICC is a Uint8Array containing the complete profile, including its header and tag table.');
  if (level === 5 && profile.length > 4 * 1024 * 1024)
    throw fault('JXL_SIZE', 'Level 5 ICC profiles are at most 4 MiB.');
  const view = new DataView(profile.buffer, profile.byteOffset, profile.byteLength);
  const signature = at => String.fromCharCode(profile[at], profile[at + 1], profile[at + 2], profile[at + 3]);
  if (view.getUint32(0) !== profile.length || signature(36) !== 'acsp') throw fault('JXL_INPUT', 'ICC size or profile signature is invalid.');
  const space = signature(16), connection = signature(20);
  if (!['RGB ', 'XYZ ', 'Lab ', 'Luv ', 'YCbr', 'Yxy ', 'HSV ', 'HLS ', 'CMY ', '3CLR', 'GRAY'].includes(space) &&
      !(space === 'CMYK' && expectedColorSpace === 'cmyk'))
    throw fault('JXL_INPUT', 'ICC requires a defined three-channel space or GRAY; CMYK requires an explicit planar-channel context.');
  if (expectedColorSpace !== undefined && space !== {rgb: 'RGB ', gray: 'GRAY', cmyk: 'CMYK'}[expectedColorSpace])
    throw fault('JXL_INPUT', 'The ICC source space does not match the declared channel context.');
  if (space === 'CMYK' && level === 5) throw fault('JXL_INPUT', 'CMYK profiles and black extra channels require JPEG XL level 10.');
  if (connection !== 'XYZ ' && connection !== 'Lab ') throw fault('JXL_INPUT', 'ICC profile connection space must be XYZ or Lab.');
  const count = view.getUint32(128);
  if (count > Math.floor((profile.length - 132) / 12)) throw fault('JXL_INPUT', 'ICC tag table exceeds the profile.');
  const end = 132 + count * 12;
  for (let i = 0; i < count; i++) {
    const at = 132 + i * 12, offset = view.getUint32(at + 4), length = view.getUint32(at + 8);
    if (offset < end || offset % 4 || length < 8 || offset > profile.length || length > profile.length - offset)
      throw fault('JXL_INPUT', 'ICC tag data is unaligned, incomplete, or outside the profile.');
  }
  return space === 'GRAY' ? 1 : 3;
}

