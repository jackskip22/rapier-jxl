// SPDX-License-Identifier: MIT
// A complete worker around Rapier JXL: post {id, op: 'encode', data, width, height, quality} or {id, op: 'transcode', jpeg};
// receive {id, ok: true, bytes, width, height, orientation} or {id, ok: false, code, message}. Bytes are transferred.
import {encode, transcode} from '../../index.mjs';

self.onmessage = event => {
  const {id, op} = event.data || {};
  try {
    let out;
    if (op === 'encode') { const {data, width, height, quality} = event.data; out = {bytes: encode(data, width, height, {quality}), width, height, orientation: 1}; }
    else if (op === 'transcode') out = transcode(event.data.jpeg);
    else throw Object.assign(new Error('unknown op ' + op), {code: 'JXL_INPUT'});
    self.postMessage({id, ok: true, ...out}, [out.bytes.buffer]);
  } catch (error) {
    self.postMessage({id, ok: false, code: error.code || 'JXL_ERROR', message: String(error.message || error)});
  }
};
