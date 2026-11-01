import {captureWith, prepareCapture} from './capture-core.mjs';
import {readTexture} from './texture.mjs';
import {declared} from './primitives.mjs';
import {captureSupported} from './capture-support.mjs';
export {configureWasm} from '../wasm-modules.mjs';
export const supported = feature => captureSupported(feature);

export const prepare = () => prepareCapture().catch(error => { throw declared(error); });

export const capture = captureWith(readTexture);
