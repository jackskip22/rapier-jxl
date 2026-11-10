// SPDX-License-Identifier: MIT
import {createBoundCodec} from './codec-bound.mjs';
import {fail} from './primitives.mjs';
import './preparation-jpeg.mjs';

export const door = spec => function createCodec(config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw fail('JXL_OPTIONS', 'Codec configuration must be an object.');
  const {module = spec.module, ...rest} = config;
  if (module !== spec.module) throw fail('JXL_OPTIONS', `This codec runs ${spec.module}; rapier-jxl/codec runs any module.`);
  return createBoundCodec(rest, spec);
};
