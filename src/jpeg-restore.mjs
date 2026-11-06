// SPDX-License-Identifier: MIT
import {restoreJPEG} from './jpeg-reconstruction.mjs';
import {brotliDictionary} from './brotli-dictionary.mjs';

export function reconstructJPEG(bytes) { return restoreJPEG(bytes, brotliDictionary); }
