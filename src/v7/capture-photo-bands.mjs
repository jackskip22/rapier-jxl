// SPDX-License-Identifier: MIT
import {CAPTURE_TOOLS, captureExact} from '../capture-codec.mjs';
import {CAPTURE_FACTS} from './capture-facts.mjs';

export function planCapturePhotoBands({read, width, height, coding, hooks, coder, answer, whole,
  drive, captureLarge, exactCoder}) {
  const found = [];
  let photos = false, exactBands = false, textReading = null;
  const shorter = async bytes => {
    if (!textReading) return bytes;
    const reading = {pieces: textReading.pieces, exact: true}, facts = {...coding[CAPTURE_FACTS]};
    const bareCoding = {...coding, exactRects: [], photoRects: [], photoSubjects: coding.photoAdmission ? coding.photoRects : [],
      captureReading: reading, [CAPTURE_FACTS]: facts};
    const bare = await captureLarge(read, width, height, bareCoding, {...hooks, onProgress: undefined}, coder, answer, whole);
    if (reading.exact && bare.length <= bytes.length && (!coding.photoAdmission || coding.photoAdmission.accepts(bare))) {
      Object.assign(coding[CAPTURE_FACTS], facts); return bare;
    }
    return bytes;
  };
  return {
    scan(data, y, count) {
      const inBand = rects => rects?.filter(r => r.y < y + count && r.y + r.height > y).map(r => ({...r, y: r.y - y}));
      found.push(coder.regions(data, width, count, inBand(coding.photoRects), inBand(coding.exactRects?.filter(e => e.edge !== true))));
    },
    photos() { return photos = found.some(regions => regions.length); },
    async prepare(shape) {
      if (whole && photos && coder.large && !shape.alpha && coding.quality < 100 && coding.exactRects?.some(e => e.edge !== true)) {
        const {signal: _signal, ...options} = coding;
        textReading = {pieces: coding.exactRects.filter(e => e.edge !== true).map(r => ({x: r.x, y: r.y, w: r.width, h: r.height}))};
        const page = await drive(coder.large(whole, width, height, {...options, ...answer?.options, textReading, signal: hooks.signal}), answer, hooks);
        if (page) { coding[CAPTURE_FACTS].bands = 1; return {bytes: await shorter(page)}; }
        exactBands = true;
      }
      return {shape: photos && coding.quality < 100 && !exactBands ? {...shape, alpha: true} : shape};
    },
    band(band, index) {
      const {y, shape} = band;
      return exactBands || !photos
        ? {coder: exactCoder, options: {colorSpace: coding.colorSpace, maxError: 0, effort: coding.effort,
          [CAPTURE_TOOLS]: coding[CAPTURE_TOOLS], signal: hooks.signal, y, imageHeight: height, shape}}
        : {coder, options: {...band, regions: found[index]}};
    },
    finish(bytes, parts) {
      return shorter(captureExact(bytes) ? bytes : coding.photoAdmission ? coding.photoAdmission.join(bytes, parts) : bytes);
    },
  };
}
