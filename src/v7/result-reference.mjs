// SPDX-License-Identifier: MIT
import {CAPTURE_PROTECTION} from '../capture-protection.mjs';
import {sRGBWithIntent} from './header-intent.mjs';
import {isBlob, OPTION_SYMBOLS, optionSymbol} from './primitives.mjs';
OPTION_SYMBOLS.add(CAPTURE_PROTECTION);
export const RESULT_REFERENCE = /* @__PURE__ */ optionSymbol('result reference');
export const RAW_OPERATION = /* @__PURE__ */ Symbol('raw operation');
export const DEVICE_RAN = /* @__PURE__ */ optionSymbol('device ran');
export const FIT_BYTES = /* @__PURE__ */ Symbol.for('rapier-jxl.fit.bytes');
export const PROFILE_NAMED = /* @__PURE__ */ optionSymbol('profile named');
export const originalSize = source => isBlob(source) ? source.size
  : source instanceof Uint8Array ? source.byteLength : undefined;
export function resultReference(options, reference, source = reference, facts) {
  if (reference !== undefined) options?.[CAPTURE_PROTECTION]?.bind(reference, source);
  if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__)) {
    const originalBytes = originalSize(source);
    if (originalBytes !== undefined) facts = {...facts, originalBytes};
  }
  options?.[RESULT_REFERENCE]?.(reference, source, facts);
}
export const resultFacts = (options, facts) => options?.[RESULT_REFERENCE]?.(undefined, undefined, facts);
export const keptOf = facts => facts?.[PROFILE_NAMED] && facts.kept === 'pixels' ? 'lossy' : facts?.kept;
export const namedPicture = ((typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) || (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true)) ? null : function namedPicture(options, picture, lossy) {
  const [named, intent] = sRGBWithIntent(picture, {lossy});
  if (picture?.icc !== undefined && named?.icc === undefined) resultFacts(options, {[PROFILE_NAMED]: true});
  return [named, intent];
};
