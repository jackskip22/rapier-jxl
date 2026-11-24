// SPDX-License-Identifier: MIT
import {fullBrowser} from './full-browser.mjs';
import {STILL_SPEC} from './queue-spec-still.mjs';
export const {encode, fit, variants, prepare, configureDecoder, configure, close, supported} = fullBrowser(STILL_SPEC);
