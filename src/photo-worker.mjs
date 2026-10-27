// SPDX-License-Identifier: MIT
import {encode} from './photo-entry.mjs';
import {installEncoderWorker} from './encode-worker.mjs';
installEncoderWorker(encode);
