import {createCodec as createClient} from './client.mjs';
import {encoder} from './session.mjs';
import {MODULES} from './codec-modules.mjs';
import {fail} from './primitives.mjs';

export function createCodec(config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw fail('JXL_OPTIONS', 'Codec configuration must be an object.');
  const {module = 'rapier-jxl', ...rest} = config;
  const spec = Object.hasOwn(MODULES, module) ? MODULES[module] : null;
  if (!spec) throw fail('JXL_OPTIONS', 'module names the module this codec runs: ' + Object.keys(MODULES).join(', ') + '.');
  if (rest.worker !== undefined) throw fail('JXL_OPTIONS', 'worker is not a codec setting: import the module to run it in place.');
  if (rest.helpers !== undefined && !spec.operations.includes('encode')) throw fail('JXL_OPTIONS', 'helpers are for a module that encodes.');
  if (rest.webgpu !== undefined && !spec.operations.includes('encode')) throw fail('JXL_OPTIONS', 'webgpu is for a module that encodes.');
  return encoder(createClient(rest, spec), rest, spec.operations, spec);
}
