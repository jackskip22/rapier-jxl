import {createBoundCodec} from './codec-bound.mjs';
import {MODULES} from './codec-modules.mjs';
import {fail} from './primitives.mjs';
import './preparation-jpeg.mjs';

export function createCodec(config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw fail('JXL_OPTIONS', 'Codec configuration must be an object.');
  const {module = 'rapier-jxl', ...rest} = config;
  const spec = Object.hasOwn(MODULES, module) ? MODULES[module] : null;
  if (!spec) throw fail('JXL_OPTIONS', 'module names the module this codec runs: ' + Object.keys(MODULES).join(', ') + '.');
  return createBoundCodec(rest, spec);
}
