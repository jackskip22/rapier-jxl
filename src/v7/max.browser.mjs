// SPDX-License-Identifier: MIT
import {fullBrowser} from './full-browser.mjs';
import {MAX_SPEC} from './queue-spec-max.mjs';
export const {encode, fit, variants, prepare, configureDecoder, configure, close, supported} = fullBrowser(MAX_SPEC, true);
