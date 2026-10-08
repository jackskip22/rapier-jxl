// SPDX-License-Identifier: MIT
export type {ErrorCode, EncoderError} from './index.mjs';
export type KernelMode = 'off' | 'scalar' | 'simd';
export interface KernelParts { channel?: boolean | undefined; weighted?: boolean | undefined; fill?: boolean | undefined; screen?: boolean | undefined; }
/** Configure acceleration for the current realm before encoding, never from a progress callback.
 * Omitting parts enables all kernels; supplying parts enables only fields set to true.
 * Unavailable or blocked backends return 'off'; unknown modes throw JXL_INPUT. */
export function configureKernels(mode?: KernelMode | 'auto', parts?: KernelParts): KernelMode;
export function kernelMode(): KernelMode;
