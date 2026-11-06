// SPDX-License-Identifier: MIT
import {prepare as prepareCapture} from './capture-complete-module.mjs';
import {prepare as prepareStill} from './still.mjs';
export {capture} from './capture-complete-module.mjs';
export {configureDecoder} from '../shown-picture.mjs';
export const prepare = (operation = 'encode') => operation === 'capture' ? prepareCapture() : prepareStill(operation);
