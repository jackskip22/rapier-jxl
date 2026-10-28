import {defaultEncoder} from './session.mjs';
export function encode(input, options) { return defaultEncoder().format(input, options); }
