// SPDX-License-Identifier: MIT
import {serve, failure} from './door-worker.mjs';
import {encodeCaptureBytes} from './capture-encode.mjs';

const warmup = new Uint8Array(64 * 64 * 4);
warmup.fill(255);
encodeCaptureBytes(warmup, 64, 64);

await serve(async message => {
  if (message.operation !== 'capture') throw Object.assign(new Error('The capture worker encodes captures.'), {code: 'JXL_OPERATION'});
  const data = message.data instanceof Uint8Array ? message.data : new Uint8Array(message.data);
  return encodeCaptureBytes(data, message.width, message.height, {
    nearLossless: message.nearLossless, maxColorError: message.maxColorError, gpu: message.gpu, signal: undefined,
  });
}).catch(error => { throw failure(error); });
