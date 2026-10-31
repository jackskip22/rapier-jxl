import {fail, object, declared} from './primitives.mjs';
import {copyBytes, encodedByteLength} from './bytes.mjs';
import {admitEdit} from './edit-changes.mjs';
import {header} from './inspect.mjs';
import {read as readBoxes, inspect as inspectBoxes, edit as editBoxes} from './container.mjs';
import {headerFields} from './header-fields.mjs';
export async function inspect(input, options) {
  try { return await readHeader(input, options); } catch (error) { throw declared(error); }
}
const DETAILS = ['metadata', 'layout'];
async function readHeader(input, options) {
  const {details: asked = [], decompress, ...settings} = {...object(options)}, maxBytes = settings.maxInputBytes ?? 1073741824;
  for (const key of Object.keys(settings)) if (!['maxPixels', 'maxDimension', 'maxMetadataBytes', 'maxInputBytes', 'maxBoxes'].includes(key))
    throw fail('JXL_OPTIONS', `Unknown inspect option: ${key}.`);
  if (!Array.isArray(asked)) throw fail('JXL_OPTIONS', 'details lists metadata and layout.');
  const details = [...asked];
  if (details.some(detail => !DETAILS.includes(detail))) throw fail('JXL_OPTIONS', 'details lists metadata and layout.');
  if (decompress !== undefined && (typeof decompress !== 'function' || !details.includes('metadata')))
    throw fail('JXL_OPTIONS', 'decompress is a function, for details metadata.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw fail('JXL_OPTIONS', 'maxInputBytes is a positive safe integer.');
  if (encodedByteLength(input) > maxBytes) throw fail('JXL_LIMIT', 'Encoded input exceeds maxInputBytes.');
  const snapshot = copyBytes(input);
  const info = headerFields(header(snapshot, settings));
  if (!details.length) return info;
  const bounds = {maxBytes, ...(settings.maxBoxes !== undefined && {maxBoxes: settings.maxBoxes})};
  const out = {...info};
  if (details.includes('metadata'))
    out.metadata = await readBoxes(snapshot, {...bounds, ...(settings.maxMetadataBytes !== undefined && {maxDecodedBytes: settings.maxMetadataBytes}),
      ...(decompress && {decompress})});
  if (details.includes('layout')) out.layout = await inspectBoxes(snapshot, bounds);
  return out;
}
export async function edit(input, changes) {
  let owned;
  try { owned = ownEdit(input, changes); } catch (error) { throw declared(error); }
  return editBoxes(owned.input, owned.changes);
}
function ownEdit(input, changes) {
  const {bounds, maxBytes, metadata, framing} = admitEdit(changes);
  if (encodedByteLength(input) > maxBytes) throw fail('JXL_LIMIT', 'The JPEG XL container exceeds maxInputBytes.');
  for (const key of ['exif', 'xmp', 'jumb']) {
    if (ArrayBuffer.isView(metadata[key])) metadata[key] = copyBytes(metadata[key], true);
    else if (Array.isArray(metadata[key])) metadata[key] = metadata[key].map(value => ArrayBuffer.isView(value) ? copyBytes(value, true) : value);
  }
  return {input: copyBytes(input), changes: {...bounds, ...metadata, ...framing}};
}
