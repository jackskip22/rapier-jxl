// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';

export function captureDomain(picture) {
  const refuse = what => { throw fault('JXL_INPUT', `A capture takes 8-bit straight sRGB or Display P3 RGBA; this picture's ${what}. Use encode.`); };
  if (!(picture.data instanceof Uint8Array || picture.data instanceof Uint8ClampedArray)) refuse('samples are not 8-bit');
  if (picture.colorSpace !== undefined && picture.colorSpace !== 'srgb' && picture.colorSpace !== 'display-p3') refuse(`colorSpace is ${picture.colorSpace}`);
  if (picture.bitDepth !== undefined && picture.bitDepth !== 8) refuse(`bitDepth is ${picture.bitDepth}`);
  if (picture.sampleFormat !== undefined && picture.sampleFormat !== 'uint') refuse(`sampleFormat is ${picture.sampleFormat}`);
  if (picture.transferFunction !== undefined && picture.transferFunction !== 'srgb') refuse(`transferFunction is ${picture.transferFunction}`);
  if (picture.alphaPremultiplied) refuse('alpha is premultiplied');
  if (picture.intensityTarget !== undefined && picture.intensityTarget !== 255) refuse(`intensityTarget is ${picture.intensityTarget}`);
  if (picture.icc !== undefined) refuse('profile is an ICC profile');
  if (picture.orientation !== undefined && picture.orientation !== 1) refuse(`orientation is ${picture.orientation}`);
  if (picture.extraChannels?.length) refuse('extra channels are set');
}
