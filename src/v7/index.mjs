export * from './still.mjs';
import {encode, prepare as prepareStill} from './still.mjs';
import {preparation} from './preparation.mjs';
import {readPNG16} from '../source.mjs';
import {orientSamples, resizeSamples} from '../sample-transforms.mjs';

export const {fit, variants} = preparation(encode, {deep: async () => ({readSource: bytes => readPNG16(bytes, {named: true}), orient: orientSamples}), orient: orientSamples, resize: resizeSamples});
export const prepare = (operation = 'encode') => prepareStill(operation === 'fit' || operation === 'variants' ? 'encode' : operation);
