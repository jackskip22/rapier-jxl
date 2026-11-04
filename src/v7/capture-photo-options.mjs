import {admitCapture} from './capture-options.mjs';
import {capturePhotoFidelity} from './fidelity.mjs';
import {fail} from './primitives.mjs';

function admitRects(name, rects) {
  if (rects === undefined) return;
  if (!Array.isArray(rects) || rects.length > 65536) throw fail('JXL_OPTIONS', `${name} is an array of at most 65,536 rectangles.`);
  for (const r of rects) if (!r || typeof r !== 'object' || ![r.x, r.y, r.width, r.height].every(Number.isSafeInteger) || r.width < 1 || r.height < 1)
    throw fail('JXL_OPTIONS', `${name} entries are {x, y, width, height} in whole pixels, at least 1 wide and high.`);
  for (const r of rects) for (const flag of ['solidText', 'edge']) if (r[flag] !== undefined && (name !== 'exactRects' || typeof r[flag] !== 'boolean'))
    throw fail('JXL_OPTIONS', `${flag} is true or false, on exactRects only.`);
}

export function admitCapturePhoto(options = {}, carried = null) {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw fail('JXL_OPTIONS', 'JPEG XL options must be an object.');
  const {exactRects, photoRects, ...rest} = options;
  admitCapture({...rest, fidelity: 'exact'}, carried);
  admitRects('exactRects', exactRects);
  admitRects('photoRects', photoRects);
  if (options.features?.firstRegion !== undefined)
    throw fail('JXL_UNSUPPORTED', 'firstRegion is for encode, not capture.');
  return capturePhotoFidelity(options.fidelity);
}
