import {RAW_OPERATION} from './result-operation.mjs';
export * from './still.mjs';
import {encode, prepare as prepareStill} from './still.mjs';
import {preparation} from './preparation.mjs';
import {readPNG16} from '../source.mjs';
import {orientSamples, resizeSamples} from '../sample-transforms.mjs';
import {verbSteps, STEPS} from './verb-steps.mjs';

export const {fit, variants} = preparation(encode[RAW_OPERATION], {deep: async () => ({readSource: bytes => readPNG16(bytes, {named: true}), orient: orientSamples}), orient: orientSamples, resize: resizeSamples});
Object.defineProperty(fit, STEPS, {value: verbSteps('fit:rapier-jxl', fit, {taken: ['maxBytes', 'fidelity', 'effort', 'readAs', 'maxPixels', 'features', 'webgpu']})});
Object.defineProperty(variants, STEPS, {value: verbSteps('variants:rapier-jxl', variants, {taken: ['outputs', 'fidelity', 'effort', 'readAs', 'maxPixels', 'features', 'webgpu']})});
export const prepare = (operation = 'encode') => prepareStill(operation === 'fit' || operation === 'variants' ? 'encode' : operation);
