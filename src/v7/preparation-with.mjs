// SPDX-License-Identifier: MIT
import {fitWith} from './preparation-fit.mjs';
import {variantsWith} from './preparation-variants.mjs';
import {DRIVE} from './drive.mjs';
import {declared} from './primitives.mjs';

export function preparationWith(encode, hooks) {
  const bind = run => {
    const invoke = (input, options, helpers) => {
      const drive = helpers && encode[DRIVE];
      const coder = drive ? (picture, settings) => drive(picture, settings, helpers) : encode;
      return run(coder, input, options, hooks).catch(error => { throw error === options?.signal?.reason ? error : declared(error); });
    };
    const operation = (input, options) => invoke(input, options);
    operation[DRIVE] = invoke;
    return operation;
  };
  return {fit: bind(fitWith), variants: bind(variantsWith)};
}
