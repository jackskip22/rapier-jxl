import {fail, snapshotOptions, snapshotArray, declared} from './primitives.mjs';
import {copyBytes, encodedByteLength, viewBytes, admitSignature} from './bytes.mjs';
import {admitEdit} from './edit-changes.mjs';
import {boundedHeader} from './inspect.mjs';
import {read as readBoxes, inspect as inspectBoxes, edit as editBoxes} from './container.mjs';
import {headerFields} from './header-fields.mjs';
import {isSourceHeader, inspectSource} from './source-header.mjs';
export async function inspect(input, options) {
  try { return await readHeader(input, options); } catch (error) { throw declared(error); }
}
const DETAILS = ['metadata', 'layout'];
async function readHeader(input, options) {
  const {details: asked = [], decompress, ...settings} = snapshotOptions(options), {maxInputBytes: maxBytes = Number.MAX_SAFE_INTEGER} = settings;
  for (const key of Object.keys(settings)) if (!['maxPixels', 'maxDimension', 'maxMetadataBytes', 'maxInputBytes', 'maxBoxes'].includes(key))
    throw fail('JXL_OPTIONS', `unknown option: ${key}`);
  if (!Array.isArray(asked)) throw fail('JXL_OPTIONS', "details: metadata or layout");
  const details = snapshotArray(asked, 'details');
  if (details.some(detail => !DETAILS.includes(detail))) throw fail('JXL_OPTIONS', "details: metadata or layout");
  if (decompress !== undefined && (typeof decompress !== 'function' || !details.includes('metadata')))
    throw fail('JXL_OPTIONS', "decompress: function; details: [\"metadata\"]");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw fail('JXL_OPTIONS', "maxInputBytes: positive safe integer");
  if (encodedByteLength(input) > maxBytes) throw fail('JXL_LIMIT', 'maxInputBytes: exceeded');
  if (isSourceHeader(viewBytes(input))) {
    if (details.length) throw fail('JXL_OPTIONS', 'details: jxl only');
    for (const key of ['maxPixels', 'maxDimension', 'maxMetadataBytes', 'maxBoxes'])
      if (settings[key] !== undefined && !(Number.isSafeInteger(settings[key]) && settings[key] > 0)) throw fail('JXL_OPTIONS', `${key}: positive safe integer`);
    return inspectSource(viewBytes(input), settings);
  }
  const info = headerFields(boundedHeader(viewBytes(input), settings));
  if (!details.length) return info;
  const snapshot = copyBytes(input);
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
  try {
    if (changes === null) { admitSignature(viewBytes(input), 'JXL_INPUT'); return copyBytes(input); }
    owned = ownEdit(input, changes);
  } catch (error) { throw declared(error); }
  return editBoxes(owned.input, owned.changes);
}
function ownEdit(input, changes) {
  const {bounds, maxBytes, metadata, framing} = admitEdit(changes);
  if (encodedByteLength(input) > maxBytes) throw fail('JXL_LIMIT', "maxInputBytes: exceeded");
  admitSignature(viewBytes(input), 'JXL_INPUT');
  for (const key of ['exif', 'xmp', 'jumb']) {
    if (ArrayBuffer.isView(metadata[key])) metadata[key] = copyBytes(metadata[key], true);
    else if (Array.isArray(metadata[key])) metadata[key] = snapshotArray(metadata[key], key, undefined, 'JXL_INPUT').map(value => ArrayBuffer.isView(value) ? copyBytes(value, true) : value);
  }
  return {input: copyBytes(input), changes: {...bounds, ...metadata, ...framing}};
}
