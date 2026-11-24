import {check, dimensions, fail, object, typedName, unknownOption} from './primitives.mjs';
import {admitSamples} from './surface.mjs';
import {drain} from './common.mjs';
import {encodeFidelity} from './fidelity.mjs';
import {described, refuseDescription, DESCRIPTION} from './describe.mjs';
import {encodeChannelsSteps} from '../channels.mjs';
import {encodeLayersSteps} from '../layers.mjs';
import {encodePatchCompositionSteps, encodePatchesSteps} from '../patches.mjs';
import {encodeSplinesSteps} from '../splines.mjs';
import {encodeGraphicsSteps} from '../graphics.mjs';
import {encodeHybridSteps} from '../hybrid.mjs';
import {encodeDeltaPaletteSteps} from '../delta-palette.mjs';
import {encodePhotoSteps} from '../photo-advanced.mjs';
import {encodeProfileSteps} from '../icc.mjs';
import {encodeAnimationAtlasSteps} from '../animation-atlas.mjs';

const COMMON = ['fidelity', 'effort', 'level', 'iccCompression'];
const PLANES = [...COMMON, ...DESCRIPTION, 'preview'];
const CHANNELS = [...PLANES, 'exponentBits', 'groupSize', 'predictor', 'transforms', 'squeeze', 'progressive', 'weightedPredictor', 'maxTransformBytes', 'upsampling', 'upsamplingWeights', 'intrinsicSize'];
const TAKES = {
  photo: ['fidelity', 'effort', 'level', 'upsampling', 'upsamplingWeights', 'transforms', 'quantization', 'coefficientOrders', 'progressive', 'noise', 'lfFrames'],
  graphics: [...COMMON, 'preset', 'maxColorError', 'paletteColors', 'preserveEdges', 'undither', 'protectedMask', 'deltaPredictor', 'maxPaletteColors', 'groupSize'],
  palette: [...COMMON, 'paletteMode', 'deltaPredictor', 'maxDeltaEntries', 'maxPaletteColors', 'groupSize'],
  patches: [...COMMON, 'atlas', 'patches', 'baseError'], splines: [...COMMON, 'splines', 'quantizationAdjustment'],
  hybrid: [...COMMON, 'regions', 'progressive'], profile: [...COMMON, 'toneMapping'],
  channels: CHANNELS, layers: CHANNELS, 'patch-composition': CHANNELS, atlas: [...PLANES, 'atlas', 'atlasMode', 'atlasSearch'],
};
const KINDS = ['channels', 'layers', 'patch-composition', 'patches', 'splines', 'graphics', 'hybrid', 'palette', 'photo', 'profile', 'atlas'];
const PIXEL_KINDS = ['patches', 'splines', 'graphics', 'hybrid', 'palette', 'photo', 'profile'];
const NO_ORIENTATION = ['graphics', 'palette', 'profile'], NO_EXTRA_CHANNELS = ['patches', 'splines', 'graphics', 'palette', 'profile'];
function refuseLost(kind, image) {
  if (NO_ORIENTATION.includes(kind) && image.orientation !== undefined && image.orientation !== 1)
    throw fail('JXL_UNSUPPORTED', `${kind} orientation: rotate pixels or kind 'photo'`);
  if (NO_EXTRA_CHANNELS.includes(kind) && image.extraChannels !== undefined && !(Array.isArray(image.extraChannels) && !image.extraChannels.length))
    throw fail('JXL_UNSUPPORTED', `${kind} extra channels: kind 'photo' or 'channels'`);
}
export function admitFormat(request, options) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw fail('JXL_INPUT', "format request: {kind}");
  options = object(options);
  if (!KINDS.includes(request.kind)) throw fail('JXL_OPTIONS', "kind: 'photo', 'channels', 'layers' or 'atlas'");
  for (const key of Object.keys(options)) if (!TAKES[request.kind].includes(key)) throw unknownOption(key, options, `${request.kind} option`);
  if (PIXEL_KINDS.includes(request.kind)) { refuseDescription(options, `a ${request.kind} request's options`); admitSamples(request); }
  if (options.effort !== undefined && (!Number.isInteger(options.effort) || options.effort < 1 || options.effort > 9))
    throw fail('JXL_OPTIONS', options.effort === 10 ? "effort 10: import {encode} from 'jpegxl/max'" : 'effort: integer 1-9');
  if (options.fidelity === undefined) return;
  const read = encodeFidelity(options.fidelity);
  if (read.target !== undefined) throw fail('JXL_OPTIONS', "fidelity: 'exact' or {quality}");
  if (read.quality === 100) {
    const loss = (options.preset !== undefined && options.preset !== 'exact') ? `preset '${options.preset}'` :
      options.maxColorError > 0 ? 'maxColorError' : options.baseError > 0 ? 'baseError' : options.undither === true ? 'undither' : undefined;
    if (loss) throw fail('JXL_OPTIONS', `fidelity conflict: 'exact' or ${loss}`);
  }
}
const isFloat16 = value => typedName.call(value) === 'Float16Array';
function normalizeFloat16Picture(picture) {
  if (!picture || !isFloat16(picture.data)) return picture;
  if (picture.sampleFormat !== undefined && picture.sampleFormat !== 'float16') throw fail('JXL_INPUT', "Float16Array: sampleFormat float16");
  return {...picture, data: new Uint16Array(picture.data.buffer, picture.data.byteOffset, picture.data.length), sampleFormat: 'float16'};
}
export async function author(request, options, hooks) {
  admitFormat(request, options);
  let image = request.image ?? request;
  if (!image || typeof image !== 'object' || Array.isArray(image)) throw fail('JXL_INPUT', 'format image: object');
  if (request.kind === 'patch-composition' && image.references !== undefined && !Array.isArray(image.references))
    throw fail('JXL_INPUT', 'references: array');
  const sized = request.kind === 'patch-composition' ? [image.base, ...(image.references ?? [])].map(frame => frame?.image).filter(Boolean) : [image];
  for (const frame of sized) dimensions(frame.width, frame.height, hooks.maxPixels);
  const finish = iterator => drain(iterator, hooks);
  if (PIXEL_KINDS.includes(request.kind)) { refuseLost(request.kind, image); image = normalizeFloat16Picture(image); }
  const {fidelity, ...rest} = options, codec = PIXEL_KINDS.includes(request.kind) ? {...rest, ...described(image)} : {...rest};
  if (request.kind === 'patch-composition') {
    const mapFrame = frame => frame?.image ? {...frame, image: normalizeFloat16Picture(frame.image)} : frame;
    if (isFloat16(image.base?.image?.data) || image.references?.some(ref => isFloat16(ref?.image?.data))) codec.sampleFormat ??= 'float16';
    image = {...image, base: mapFrame(image.base), ...(image.references && {references: image.references.map(mapFrame)})};
  } else if (request.kind === 'atlas' && Array.isArray(image.frames) && image.frames.some(frame => isFloat16(frame?.data))) {
    if (codec.sampleFormat !== undefined && codec.sampleFormat !== 'float16') throw fail('JXL_INPUT', "Float16Array: sampleFormat float16");
    if (!image.frames.every(frame => isFloat16(frame?.data))) throw fail('JXL_INPUT', "frames: same sample array type");
    image = {...image, frames: image.frames.map(frame => ({...frame, data: new Uint16Array(frame.data.buffer, frame.data.byteOffset, frame.data.length)}))};
    codec.sampleFormat = 'float16';
  }
  if (fidelity !== undefined) { const read = encodeFidelity(fidelity); codec.quality = read.qualityIntent !== undefined ? read.qualityIntent * 100 : read.quality; }
  if ((request.kind === 'graphics' || request.kind === 'palette') && codec.effort !== undefined) codec.screenEffort = codec.effort;
  if (request.kind === 'profile' && codec.effort > 2) codec.effort = 2;
  check(hooks.signal);
  switch (request.kind) {
    case 'channels': return finish(encodeChannelsSteps(image, codec));
    case 'layers': return finish(encodeLayersSteps(image, codec));
    case 'patch-composition': return finish(encodePatchCompositionSteps(image, codec));
    case 'patches': return finish(encodePatchesSteps(image.data, image.width, image.height, codec));
    case 'splines': return finish(encodeSplinesSteps(image.data, image.width, image.height, codec));
    case 'graphics': return finish(encodeGraphicsSteps(image.data, image.width, image.height, codec));
    case 'hybrid': return finish(encodeHybridSteps(image.data, image.width, image.height, codec));
    case 'palette': return finish(encodeDeltaPaletteSteps(image.data, image.width, image.height, codec));
    case 'photo': return finish(encodePhotoSteps(image.data, image.width, image.height, codec));
    case 'profile': return finish(encodeProfileSteps(image.data, image.width, image.height, codec));
    case 'atlas': return finish(encodeAnimationAtlasSteps(image, codec, true));
    default: throw fail('JXL_OPTIONS', "kind: 'photo', 'channels', 'layers' or 'atlas'");
  }
}
