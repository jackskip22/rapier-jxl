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

export function captureRectangles(options, width, height) {
  const clipped = {}, budget = width * height * 8;
  let work = 0;
  for (const name of ['exactRects', 'photoRects']) {
    if (options[name] === undefined) continue;
    const out = [], seen = new Set();
    for (const r of options[name]) {
      const x = Math.max(0, r.x), y = Math.max(0, r.y);
      const w = Math.min(width, r.x + r.width) - x, h = Math.min(height, r.y + r.height) - y;
      if (w <= 0 || h <= 0) continue;
      const key = `${x},${y},${w},${h},${r.solidText === true},${r.edge === true}`;
      if (seen.has(key)) continue;
      seen.add(key);
      work += w * h;
      if (work > budget) throw fail('JXL_LIMIT', 'Capture rectangles exceed the clipped work budget.');
      out.push({...r, x, y, width: w, height: h});
    }
    clipped[name] = out;
  }
  return clipped;
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
