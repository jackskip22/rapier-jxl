/** Optional, realm-local acceleration; call before an encode, not from a progress callback. */
export function configureKernels(mode?: 'off' | 'auto' | 'scalar' | 'simd', parts?: {channel?: boolean; weighted?: boolean; fill?: boolean}): 'off' | 'scalar' | 'simd';
export function kernelMode(): 'off' | 'scalar' | 'simd';
