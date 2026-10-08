// Optional all-in-one accelerated effort entry point. MIT (LICENSE).
// Bundling the encoder and kernels together preserves their shared hooks.
import {configureKernels, kernelMode} from './kernels.mjs';
import {encode, encodeSteps, LIMITS} from './effort.mjs';
configureKernels('auto');
export {encode, encodeSteps, LIMITS, configureKernels, kernelMode};
