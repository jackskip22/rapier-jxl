import {fail, object, declared} from './primitives.mjs';
import {admitEdit} from './edit-changes.mjs';
import {copyBytes, encodedByteLength} from './bytes.mjs';
import {readMetadataAsync, withMetadata, withCompressedMetadata} from '../metadata.mjs';
import {inspectContainer, reframeContainer} from '../container-advanced.mjs';
const DEFAULT_MAX_BOXES = 65536;
export const capture = options => {
  if (options === undefined) return {maxBoxes: DEFAULT_MAX_BOXES};
  object(options);
  const copy = {...options};
  for (const key of ['exif', 'xmp', 'jumb']) {
    if (ArrayBuffer.isView(copy[key])) copy[key] = copyBytes(copy[key], true);
    else if (Array.isArray(copy[key])) copy[key] = copy[key].map(value => ArrayBuffer.isView(value) ? copyBytes(value, true) : value);
  }
  if (copy.maxBoxes === undefined) copy.maxBoxes = DEFAULT_MAX_BOXES;
  else if (!Number.isSafeInteger(copy.maxBoxes) || copy.maxBoxes < 1) throw fail('JXL_OPTIONS', 'maxBoxes is a positive safe integer.');
  return copy;
};
const admitContainer = (input, settings) => {
  const maxBytes = settings.maxBytes ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw fail('JXL_OPTIONS', 'maxBytes is a positive safe integer.');
  if (encodedByteLength(input) > maxBytes) throw fail('JXL_LIMIT', 'The JPEG XL container exceeds maxBytes.');
};
const copyContainer = (input, settings) => {
  admitContainer(input, settings);
  return copyBytes(input);
};
export const read = (input, options) => readContainer(input, options).catch(error => { throw declared(error); });
async function readContainer(input, options) {
  const settings = capture(options), snapshot = copyContainer(input, settings);
  return readMetadataAsync(snapshot, settings);
}
export const write = (input, options) => writeContainer(input, options).catch(error => { throw declared(error); });
async function writeContainer(input, options = {}) {
  admitContainer(input, object(options));
  const settings = capture(options), snapshot = copyContainer(input, settings);
  return settings.compression ? withCompressedMetadata(snapshot, settings) : withMetadata(snapshot, settings);
}
export const inspect = (input, options) => inspectBoxes(input, options).catch(error => { throw declared(error); });
async function inspectBoxes(input, options) {
  const settings = capture(options), snapshot = copyContainer(input, settings);
  return inspectContainer(snapshot, settings);
}
export const repack = (input, options) => repackContainer(input, options).catch(error => { throw declared(error); });
async function repackContainer(input, options) {
  const settings = capture(options), snapshot = copyContainer(input, settings);
  return reframeContainer(snapshot, settings);
}
export const edit = (input, changes) => editContainer(input, changes).catch(error => { throw declared(error); });
async function editContainer(input, changes) {
  const {bounds: {maxInputBytes, ...bounds}, metadata, framing} = admitEdit(changes);
  if (maxInputBytes !== undefined) bounds.maxBytes = maxInputBytes;
  let bytes = input;
  if (Object.keys(metadata).length) bytes = await writeContainer(bytes, {...bounds, ...metadata});
  if (Object.keys(framing).length) bytes = await repackContainer(bytes, {...bounds, ...framing});
  return bytes;
}
