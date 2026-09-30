// SPDX-License-Identifier: MIT
import type {Pixels, EncodeOptions, Limits} from './index.mjs';
export const LIMITS: Limits;
/** Photographs: DCT8 coefficients with exact alpha; quality 90 by default, 100 is exact. */
export function encodePhotoRGBA(data: Pixels, width: number, height: number, options?: EncodeOptions): Uint8Array;
