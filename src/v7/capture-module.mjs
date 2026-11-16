import {captureWith, prepareCapture} from './capture-core.mjs';
import {declared, preparedAlone} from './primitives.mjs';
import {captureSupported} from './capture-support.mjs';
import {captureSteps, STEPS} from './capture-steps.mjs';
import {CAPTURE_LEAN, carriedBy} from './capture-levels.mjs';
export const supported = feature => captureSupported(feature);
export const prepare = preparedAlone(() => prepareCapture().catch(error => { throw declared(error); }));
export const capture = captureWith(null);
Object.defineProperty(capture, STEPS, {value: captureSteps(carriedBy('rapier-jxl/capture', CAPTURE_LEAN))});
