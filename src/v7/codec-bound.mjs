// SPDX-License-Identifier: MIT
import {createCodec as createClient, helperReservation} from './client.mjs';
import {encoder} from './session.mjs';
import {fail} from './primitives.mjs';

export function createBoundCodec(config = {}, spec) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw fail('JXL_OPTIONS', 'Codec configuration must be an object.');
  if (config.worker !== undefined) throw fail('JXL_OPTIONS', 'worker is not a codec setting; import the module to run in place.');
  const encodes = spec.operations.some(name => name === 'encode' || name === 'fit' || name === 'variants');
  if (config.helpers !== undefined && !encodes && !spec.helpers) throw fail('JXL_OPTIONS', 'helpers are for a module that encodes.');
  if (config.webgpu !== undefined && !encodes && !spec.captureGpu) throw fail('JXL_OPTIONS', 'webgpu needs a module that encodes or has GPU capture.');
  if (spec.captureAdmission !== undefined && (typeof spec.captureAdmission !== 'function' || !spec.operations.includes('capture')))
    throw fail('JXL_OPTIONS', 'captureAdmission must be a function.');
  const helpers = config.helpers === undefined ? undefined : helperReservation(config.helpers);
  if (helpers?.count && spec.helpers?.url) spec = {...spec, url: spec.helpers.url, worker: spec.helpers.worker};
  return encoder(createClient(config.helpers === undefined ? config : {...config, helpers}, spec), config, spec.operations, spec);
}
