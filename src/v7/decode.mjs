import {sharedClient} from './shared.mjs';
import {fail, object} from './primitives.mjs';
import {copyBytes, encodedByteLength} from './bytes.mjs';
export function decode(input, options) { return sharedClient().decode(input, options); }
export async function inspect(input, options) {
  const settings = {...object(options)}, maxBytes = settings.maxInputBytes ?? 1073741824;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw fail('JXL_OPTIONS', 'maxInputBytes is a positive safe integer.');
  if (encodedByteLength(input) > maxBytes) throw fail('JXL_LIMIT', 'Encoded input exceeds maxInputBytes.');
  const snapshot = copyBytes(input);
  const {header} = await import('./inspect.mjs');
  return header(snapshot, settings);
}
