// SPDX-License-Identifier: MIT
// A preload that runs a whole test run with the WebAssembly kernels on, to prove that they change no byte (the frozen
// seeds, the roundtrips, the hurry rules):
//   node --import ./test/kernels-on.mjs --test "test/*.test.mjs"
// JXL_KERNELS=scalar runs the scalar module alone; the default is the SIMD one.
import {configureKernels} from '../src/kernels.mjs';

const mode = process.env.JXL_KERNELS || 'simd';
if (configureKernels(mode) !== mode) throw new Error('The ' + mode + ' kernels are not available here');
