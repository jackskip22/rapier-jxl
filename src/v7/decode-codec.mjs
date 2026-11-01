// SPDX-License-Identifier: MIT
import {createCodec as createClient} from './client.mjs';
import {MODULES} from './codec-modules.mjs';
import {bounded} from './session.mjs';

export function createDecodeCodec(config) {
  const client = createClient(config, MODULES['rapier-jxl/decode']);
  return Object.freeze({decode: bounded(client, 'decode'), prepare: client.prepare, close: client.close, get stats() { return client.stats; }});
}
