// SPDX-License-Identifier: MIT
import {createCodec as createClient} from './client.mjs';
import {DECODE_SPEC} from './codec-spec-decode.mjs';
import {bounded} from './session.mjs';

export function createDecodeCodec(config) {
  const client = createClient(config, DECODE_SPEC);
  return Object.freeze({decode: bounded(client, 'decode'), prepare: client.prepare, close: client.close, get stats() { return client.stats; }});
}
