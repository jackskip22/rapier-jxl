import {defaultEncoder, createEncoder} from './session.mjs';
export {createEncoder};
export function encode(input, options) { return defaultEncoder().encode(input, options); }
