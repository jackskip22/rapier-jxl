// SPDX-License-Identifier: MIT
import {CAPTURE_PROTECTION} from '../capture-protection.mjs';
export const RESULT_REFERENCE = Symbol('result reference');
export const RAW_OPERATION = Symbol('raw operation');
export const FIT_BYTES = Symbol.for('rapier-jxl.fit.bytes');
export function resultReference(options, reference, source = reference, facts) {
  if (reference !== undefined) options?.[CAPTURE_PROTECTION]?.bind(reference, source);
  options?.[RESULT_REFERENCE]?.(reference, source, facts);
}
export const resultFacts = (options, facts) => options?.[RESULT_REFERENCE]?.(undefined, undefined, facts);
