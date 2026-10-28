import {defaultEncoder} from './session.mjs';
export function recompress(input, options) { return defaultEncoder().recompress(input, options); }
export function restore(input, options) { return defaultEncoder().restore(input, options); }
