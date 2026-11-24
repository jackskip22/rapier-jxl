// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';

export function captureDomain(picture) {
  const refuse = what => { throw fault('JXL_INPUT', `capture RGBA8 sRGB or Display P3 (${what}): use encode`); };
  if (!(picture.data instanceof Uint8Array || picture.data instanceof Uint8ClampedArray)) refuse('not 8-bit');
  if (picture.colorSpace !== undefined && picture.colorSpace !== 'srgb' && picture.colorSpace !== 'display-p3') refuse('colorSpace');
  if (picture.bitDepth !== undefined && picture.bitDepth !== 8) refuse('bitDepth');
  if (picture.sampleFormat !== undefined && picture.sampleFormat !== 'uint') refuse('sampleFormat');
  if (picture.transferFunction !== undefined && picture.transferFunction !== 'srgb') refuse('transferFunction');
  if (picture.alphaPremultiplied) refuse('alphaPremultiplied');
  if (picture.intensityTarget !== undefined && picture.intensityTarget !== 255) refuse('intensityTarget');
  if (picture.icc !== undefined) refuse('icc');
  if (picture.orientation !== undefined && picture.orientation !== 1) refuse('orientation');
  if (picture.extraChannels?.length) refuse('extraChannels');
}
