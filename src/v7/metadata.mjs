import {check, fail, object} from './primitives.mjs';
import {copyBytes, encodedByteLength} from './bytes.mjs';
const DEFAULT_MAX_BOXES = 65536;
const capture = options => {
  if (options === undefined) return {maxBoxes: DEFAULT_MAX_BOXES};
  object(options);
  const copy = {...options};
  for (const key of ['exif', 'xmp', 'jumb']) {
    if (ArrayBuffer.isView(copy[key])) copy[key] = copyBytes(copy[key], true);
    else if (Array.isArray(copy[key])) copy[key] = copy[key].map(value => ArrayBuffer.isView(value) ? copyBytes(value, true) : value);
  }
  if (copy.maxBoxes === undefined) copy.maxBoxes = DEFAULT_MAX_BOXES;
  else if (!Number.isSafeInteger(copy.maxBoxes) || copy.maxBoxes < 1) {
    throw fail('JXL_INPUT', 'maxBoxes is an integer from 1 to ' + Number.MAX_SAFE_INTEGER + '.');
  }
  return copy;
};
const copyContainer = (input, settings) => {
  const maxBytes = settings.maxBytes ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw fail('JXL_INPUT', 'maxBytes is an integer from 1 to ' + Number.MAX_SAFE_INTEGER + '.');
  if (encodedByteLength(input) > maxBytes) throw fail('JXL_SIZE', 'The JPEG XL container exceeds maxBytes.');
  return copyBytes(input);
};
export async function read(input, options) {
  const snapshot = copyBytes(input), settings = capture(options);
  const {readMetadataAsync} = await import('../metadata.mjs');
  return readMetadataAsync(snapshot, settings);
}
export async function write(input, options = {}) {
  const snapshot = copyBytes(input), settings = capture(options);
  const {withMetadata, withCompressedMetadata} = await import('../metadata.mjs');
  return settings.compression ? withCompressedMetadata(snapshot, settings) : withMetadata(snapshot, settings);
}
export async function inspect(input, options) {
  const settings = capture(options), snapshot = copyContainer(input, settings);
  const {inspectContainer} = await import('../container-advanced.mjs');
  return inspectContainer(snapshot, settings);
}
export async function repack(input, options) {
  const settings = capture(options), snapshot = copyContainer(input, settings);
  const {reframeContainer} = await import('../container-advanced.mjs');
  return reframeContainer(snapshot, settings);
}
export function stream(source, options = {}) {
  const settings = capture(options);
  return (async function* () {
    const {streamContainer} = await import('../container-stream.mjs');
    check(settings.signal); yield* streamContainer(source, settings);
  })();
}
