import {check, dimensions, fail, object} from './primitives.mjs';
import {drain} from './common.mjs';
import {encodeFidelity} from './fidelity.mjs';
import {described, refuseDescription} from './describe.mjs';
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
const RETIRED = ['quality', 'lossless', 'target', 'maxError', 'photo', 'filter', 'losslessProfile', 'mode', 'acceleration'];

const KINDS = ['channels', 'layers', 'patch-composition', 'patches', 'splines', 'graphics', 'hybrid', 'palette', 'photo', 'profile', 'atlas'];
const PIXEL_KINDS = ['patches', 'splines', 'graphics', 'hybrid', 'palette', 'photo', 'profile'];
const NO_ORIENTATION = ['graphics', 'palette', 'profile'], NO_EXTRA_CHANNELS = ['patches', 'splines', 'graphics', 'palette', 'profile'];
function refuseLost(kind, image) {
  if (NO_ORIENTATION.includes(kind) && image.orientation !== undefined && image.orientation !== 1)
    throw fail('JXL_UNSUPPORTED', `A ${kind} file does not carry orientation in this version; rotate the pixels, or use kind 'photo'.`);
  if (NO_EXTRA_CHANNELS.includes(kind) && image.extraChannels !== undefined && !(Array.isArray(image.extraChannels) && !image.extraChannels.length))
    throw fail('JXL_UNSUPPORTED', `A ${kind} file does not carry extra channels in this version; write them with kind 'photo' or 'channels'.`);
}
export function admitFormat(request, options) {
  object(request, 'Format input'); object(options);
  if (!KINDS.includes(request.kind)) throw fail('JXL_OPTIONS', 'Unknown JPEG XL format author.');
  for (const key of RETIRED) if (options[key] !== undefined) throw fail('JXL_OPTIONS', `Unknown format option: ${key}.`);
  if (options.screenEffort !== undefined) throw fail('JXL_OPTIONS', 'screenEffort is not a format option: effort sets the screen search.');
  if (PIXEL_KINDS.includes(request.kind)) refuseDescription(options, `options of a ${request.kind} request; set it on the request`);
  if (options.effort !== undefined && (!Number.isInteger(options.effort) || options.effort < 1 || options.effort > 9)) throw fail('JXL_OPTIONS', 'effort must be an integer 1–9.');
  if (options.fidelity === undefined) return;
  const read = encodeFidelity(options.fidelity);
  if (read.target !== undefined) throw fail('JXL_OPTIONS', "A format request takes fidelity 'exact' or {quality}.");
  if (read.quality === 100) {
    const loss = (options.preset !== undefined && options.preset !== 'exact') ? `preset '${options.preset}'` :
      options.maxColorError > 0 ? 'maxColorError' : options.baseError > 0 ? 'baseError' : options.undither === true ? 'undither' : undefined;
    if (loss) throw fail('JXL_OPTIONS', `fidelity 'exact' keeps every sample; ${loss} allows loss. Leave out one or the other.`);
  }
}
export async function author(request, options, hooks) {
  admitFormat(request, options);
  const image = request.image ?? request;
  dimensions(image.width, image.height, hooks.maxPixels);
  const finish = iterator => drain(iterator, hooks);
  if (PIXEL_KINDS.includes(request.kind)) refuseLost(request.kind, image);
  const {fidelity, ...rest} = options, codec = PIXEL_KINDS.includes(request.kind) ? {...rest, ...described(image)} : {...rest};
  if (fidelity !== undefined) codec.quality = encodeFidelity(fidelity).quality;
  if ((request.kind === 'graphics' || request.kind === 'palette') && codec.effort !== undefined) codec.screenEffort = codec.effort;
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
    case 'atlas': return finish(encodeAnimationAtlasSteps(image, codec));
    default: throw fail('JXL_OPTIONS', 'Unknown JPEG XL format author.');
  }
}
