// SPDX-License-Identifier: MIT
export type {ErrorCode, EncoderError} from './index.mjs';
export type KernelMode = 'off' | 'scalar' | 'simd';
export interface KernelParts { channel?: boolean | undefined; weighted?: boolean | undefined; fill?: boolean | undefined; }
/** Optional, realm-local acceleration; call before an encode, not from a progress callback.
 * Omitting parts enables all three; supplying parts enables only its true fields.
 * An unavailable or blocked backend returns 'off'; an unknown mode is JXL_INPUT. */
export function configureKernels(mode?: KernelMode | 'auto', parts?: KernelParts): KernelMode;
export function kernelMode(): KernelMode;
