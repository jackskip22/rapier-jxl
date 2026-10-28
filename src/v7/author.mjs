import {check, dimensions, fail, object} from './primitives.mjs';
import {drain} from './common.mjs';

export async function author(request, options, hooks) {
  object(request, 'Format input'); object(options);
  const image = request.image ?? request;
  dimensions(image.width, image.height, hooks.maxPixels);
  const finish = iterator => drain(iterator, hooks);
  const codec = {...options, effort: options.effort ?? 7};
  check(hooks.signal);
  switch (request.kind) {
    case 'channels': return finish((await import('../channels.mjs')).encodeChannelsSteps(image, codec));
    case 'layers': return finish((await import('../layers.mjs')).encodeLayersSteps(image, codec));
    case 'patch-composition': return finish((await import('../patches.mjs')).encodePatchCompositionSteps(image, codec));
    case 'patches': return finish((await import('../patches.mjs')).encodePatchesSteps(image.data, image.width, image.height, codec));
    case 'splines': return finish((await import('../splines.mjs')).encodeSplinesSteps(image.data, image.width, image.height, codec));
    case 'graphics': return finish((await import('../graphics.mjs')).encodeGraphicsSteps(image.data, image.width, image.height, codec));
    case 'hybrid': return finish((await import('../hybrid.mjs')).encodeHybridSteps(image.data, image.width, image.height, codec));
    case 'palette': return finish((await import('../delta-palette.mjs')).encodeDeltaPaletteSteps(image.data, image.width, image.height, codec));
    case 'photo': return finish((await import('../photo-advanced.mjs')).encodePhotoSteps(image.data, image.width, image.height, codec));
    case 'profile': return finish((await import('../icc.mjs')).encodeProfileSteps(image.data, image.width, image.height, codec));
    case 'atlas': return finish((await import('../animation-atlas.mjs')).encodeAnimationAtlasSteps(image, codec));
    default: throw fail('JXL_OPTIONS', 'Unknown JPEG XL format author.');
  }
}
