import {completionOptions} from './result-operation.mjs';
// SPDX-License-Identifier: MIT
import {fitWith} from './preparation-fit.mjs';
import {variantsWith} from './preparation-variants.mjs';
import {DRIVE} from './drive.mjs';
import {declared} from './primitives.mjs';
import {JOURNAL} from '../step-journal.mjs';
import {previewCall} from './preview.mjs';

export function preparationWith(encode, hooks) {
  const bind = run => {
    const invoke = async (input, given, helpers) => {
      const journal = given?.[JOURNAL];
      const completion = completionOptions(journal === undefined ? given : (({[JOURNAL]: _journal, ...rest}) => rest)(given));
      const options = completion.options;
      const preview = previewCall(options);
      const drive = helpers && encode[DRIVE];
      const direct = drive ? (picture, settings) => drive(picture, settings, helpers) : encode;
      const coder = journal === undefined ? direct : (picture, settings) => direct(picture, {...settings, [JOURNAL]: journal});
      try {
        const result = await run(coder, input, options, journal === undefined ? hooks : {...hooks, journal}).catch(error => { throw error === options?.signal?.reason ? error : declared(error); });
        completion.finish();
        return result;
      } finally { preview?.close(); }
    };
    const operation = (input, options) => invoke(input, options);
    operation[DRIVE] = invoke;
    return operation;
  };
  return {fit: bind(fitWith), variants: bind(variantsWith)};
}
