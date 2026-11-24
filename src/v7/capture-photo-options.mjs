import {admitCapture} from './capture-options.mjs';
import {capturePhotoFidelity} from './fidelity.mjs';
import {fail} from './primitives.mjs';

function admitRects(name, rects) {
  if (rects === undefined) return;
  if (!Array.isArray(rects)) throw fail('JXL_OPTIONS', `${name}: rectangle array`);
  for (const r of rects) if (!r || typeof r !== 'object' || ![r.x, r.y, r.width, r.height].every(Number.isSafeInteger) || r.width < 1 || r.height < 1)
    throw fail('JXL_OPTIONS', `${name}: integer rects {x, y, width, height}`);
  for (const r of rects) for (const flag of ['solidText', 'edge']) if (r[flag] !== undefined && (name !== 'exactRects' || typeof r[flag] !== 'boolean'))
    throw fail('JXL_OPTIONS', `${flag}: boolean, exactRects only`);
}

function admitWithoutText(value) {
  if (value === undefined) return;
  const ok = value && typeof value === 'object' && (value.data instanceof Uint8Array || value.data instanceof Uint8ClampedArray) &&
    [value.width, value.height].every(n => Number.isSafeInteger(n) && n >= 1) && value.data.length === value.width * value.height * 4;
  if (!ok) throw fail('JXL_OPTIONS', "withoutText: {data, width, height, rects} RGBA8");
  admitRects('withoutText.rects', value.rects);
}

export function captureRectangles(options, width, height) {
  const clipped = {}, budget = width * height * 8;
  if (options.withoutText !== undefined && (options.withoutText.width !== width || options.withoutText.height !== height))
    throw fail('JXL_OPTIONS', `withoutText: ${String(options.withoutText.width)}x${String(options.withoutText.height)}, expected ${width}x${height}`);
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
      if (work > budget) throw fail('JXL_LIMIT', 'rectangles: reduce count or area');
      out.push({...r, x, y, width: w, height: h});
    }
    clipped[name] = out;
  }
  return clipped;
}

export function admitCapturePhoto(options = {}, carried = null) {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw fail('JXL_OPTIONS', "options: object");
  const {exactRects, photoRects, textComplete, withoutText, ...rest} = options;
  admitCapture({...rest, fidelity: 'exact'}, carried);
  admitRects('exactRects', exactRects);
  admitRects('photoRects', photoRects);
  admitWithoutText(options.withoutText);
  if (textComplete !== undefined && (textComplete !== true || !Array.isArray(exactRects)))
    throw fail('JXL_OPTIONS', "textComplete: exactRects array required");
  if (options.features?.firstRegion !== undefined)
    throw fail('JXL_UNSUPPORTED', "firstRegion: use encode");
  return capturePhotoFidelity(options.fidelity);
}
