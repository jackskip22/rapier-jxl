// SPDX-License-Identifier: MIT
import {encode} from './capture.mjs';
import {installEncoderWorker} from './encode-worker.mjs';
installEncoderWorker(encode);
