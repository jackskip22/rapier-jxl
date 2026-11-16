import {completionOptions} from './result-operation.mjs';
// SPDX-License-Identifier: MIT
import {fitWith} from './preparation-fit.mjs';
import {variantsWith} from './preparation-variants.mjs';
import {DRIVE} from './drive.mjs';
import {check, declared} from './primitives.mjs';
import {JOURNAL} from '../step-journal.mjs';
import {previewCall} from './preview.mjs';
import {DEVICE_RAN} from './result-reference.mjs';
import {withinCall, withinPicture} from '../call-scope.mjs';

export function preparationWith(encode, hooks) {
  const bind = run => {
    const invoke = async (input, journal, completion, helpers) => {
      const options = completion.options;
      const preview = previewCall(options);
      const drive = helpers && encode[DRIVE];
      const direct = drive ? (picture, settings) => withinPicture(() => drive(picture, settings, helpers)) : (picture, settings) => withinPicture(() => encode(picture, settings));
      let ran = false;
      const marked = hooks.device ? (picture, settings) => direct(picture, {...settings, [DEVICE_RAN]: () => { ran = true; }}) : direct;
      const coder = journal === undefined ? marked : (picture, settings) => marked(picture, {...settings, [JOURNAL]: journal});
      try {
        let result = await run(coder, input, options, journal === undefined ? hooks : {...hooks, journal}).catch(error => { throw declared(error); });
        if (hooks.device) result = Array.isArray(result) ? result.map(each => ({...each, usedWebGPU: ran})) : {...result, usedWebGPU: ran};
        await completion.finish();
        await preview?.finish();
        return result;
      } finally { preview?.close(); }
    };
    const settle = (input, given, helpers) => {
      let completion;
      return withinCall(() => {
        const journal = given?.[JOURNAL];
        completion = completionOptions(journal === undefined ? given : (({[JOURNAL]: _journal, ...rest}) => rest)(given));
        return invoke(input, journal, completion, helpers);
      }).then(result => { check(completion.options.signal); return result; });
    };
    const operation = (input, options) => settle(input, options);
    operation[DRIVE] = (input, options, helpers) => settle(input, options, helpers);
    return operation;
  };
  return {fit: bind(fitWith), variants: bind(variantsWith)};
}
