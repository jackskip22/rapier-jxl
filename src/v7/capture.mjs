import {defaultEncoder} from './session.mjs';
export function encode(input, options) { return defaultEncoder().capture(input, options); }
