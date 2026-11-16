// Astro's sharp service with format="jxl" added. Sharp reads, rotates and resizes; rapier-jxl writes the file.
// Every other format is Astro's sharp service unchanged.
import sharpService from 'astro/assets/services/sharp';
import {encode} from 'jpegxl';
import {recompress} from 'jpegxl/jpeg';
import {asked, bytes, getHTMLAttributes, propertiesToHash, settings, validateOptions} from './options.mjs';

const FIT = {fill: 'fill', contain: 'inside', cover: 'cover', none: 'outside', 'scale-down': 'inside', outside: 'outside', inside: 'inside'};
const BOUNDING = new Set(['contain', 'inside', 'scale-down']);
const X_AXIS = {left: 0, center: 0.5, centre: 0.5, right: 1};
const Y_AXIS = {top: 0, center: 0.5, centre: 0.5, bottom: 1};
let sharp;

function focalPoint(position) {
  if (position && typeof position === 'object' && Number.isFinite(position.x) && Number.isFinite(position.y))
    return {x: Math.min(1, Math.max(0, position.x)), y: Math.min(1, Math.max(0, position.y))};
  if (typeof position !== 'string' || !position.includes('%')) return null;
  const parts = position.trim().toLowerCase().split(/\s+/);
  if (parts.length === 1 && parts[0].endsWith('%')) {
    const v = Number(parts[0].slice(0, -1)) / 100;
    return Number.isFinite(v) ? {x: Math.min(1, Math.max(0, v)), y: 0.5} : null;
  }
  if (parts.length === 2) {
    const read = (token, map) => token.endsWith('%') ? Number(token.slice(0, -1)) / 100 : map[token];
    const x = read(parts[0], X_AXIS), y = read(parts[1], Y_AXIS);
    return Number.isFinite(x) && Number.isFinite(y) ? {x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y))} : null;
  }
  if (parts.length === 4 && (parts[0] === 'left' || parts[0] === 'right') && (parts[2] === 'top' || parts[2] === 'bottom') &&
      parts[1].endsWith('%') && parts[3].endsWith('%')) {
    const dx = Number(parts[1].slice(0, -1)) / 100, dy = Number(parts[3].slice(0, -1)) / 100;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
    const x = parts[0] === 'right' ? 1 - dx : dx, y = parts[2] === 'bottom' ? 1 - dy : dy;
    return {x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y))};
  }
  return null;
}

function keepsWholeFrame(shownWidth, shownHeight, width, height, fit) {
  if (!Number.isFinite(shownWidth) || !Number.isFinite(shownHeight)) return false;
  if ((width && width < shownWidth) || (height && height < shownHeight)) return false;
  if (!width || !height || BOUNDING.has(fit)) return true;
  if (fit === 'fill') return width === shownWidth && height === shownHeight;
  return Math.round(shownHeight * width / shownWidth) === height && Math.round(shownWidth * height / shownHeight) === width;
}

async function transform(input, options, config, logger) {
  if (options.format !== 'jxl') return sharpService.transform(input, options, config, logger);
  sharp ??= (await import('sharp')).default;
  const {effort, quality, jpeg} = settings(config);
  const {kernel, limitInputPixels} = config.service.config ?? {};
  const image = sharp(input, {failOn: 'none', limitInputPixels});
  const meta = await image.metadata();
  const turned = (meta.orientation ?? 1) >= 5;
  const shownWidth = turned ? meta.height : meta.width, shownHeight = turned ? meta.width : meta.height;
  const width = options.width && Math.round(options.width), height = options.height && Math.round(options.height);
  // jpeg: 'exact' keeps a JPEG shown at its own uncropped size, with no quality asked: recompress() preserves Exif orientation 1 to 8.
  if (jpeg === 'exact' && meta.format === 'jpeg' && asked(options.quality) === undefined &&
      keepsWholeFrame(shownWidth, shownHeight, width, height, options.fit) && !options.background)
    return {data: bytes(await recompress(input, {effort}), options.src), format: 'jxl'};
  image.rotate();
  const size = {width, height, kernel, withoutEnlargement: true};
  if (width && height) {
    const resolvedFit = options.fit ? FIT[options.fit] ?? 'inside' : undefined;
    const focal = (resolvedFit === undefined || resolvedFit === 'cover') ? focalPoint(options.position) : null;
    if (focal && Number.isFinite(shownWidth) && Number.isFinite(shownHeight) && typeof image.extract === 'function') {
      const targetAspect = width / height, sourceAspect = shownWidth / shownHeight;
      if (Math.abs(targetAspect - sourceAspect) > 1e-6) {
        const cropWidth = targetAspect < sourceAspect ? Math.max(1, Math.round(shownHeight * targetAspect)) : shownWidth;
        const cropHeight = targetAspect > sourceAspect ? Math.max(1, Math.round(shownWidth / targetAspect)) : shownHeight;
        const left = Math.min(shownWidth - cropWidth, Math.max(0, Math.round((shownWidth - cropWidth) * focal.x)));
        const top = Math.min(shownHeight - cropHeight, Math.max(0, Math.round((shownHeight - cropHeight) * focal.y)));
        image.extract({left, top, width: cropWidth, height: cropHeight});
      }
      image.resize(size);
    } else {
      image.resize({...size, fit: resolvedFit, position: options.position});
    }
  } else if (width || height) image.resize(size);
  if (options.background) image.flatten({background: options.background});
  // Sharp hands back 8-bit samples unless asked for more: a 16-bit source stays 16-bit, a gray one becomes RGB, and a
  // profile stays on the pixels it describes (RGB only: gray and CMYK pixels are converted away from theirs).
  const wide = meta.depth === 'ushort';
  if (wide) image.toColorspace('rgb16');
  const {data, info} = await image.ensureAlpha().raw({depth: wide ? 'ushort' : 'uchar'}).toBuffer({resolveWithObject: true});
  const icc = meta.icc && !['b-w', 'grey16', 'cmyk'].includes(meta.space) && !(meta.channels < 3) ? new Uint8Array(meta.icc) : undefined;
  const samples = wide ? new Uint16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length)) : new Uint8Array(data.buffer, data.byteOffset, data.length);
  const pixels = {data: samples, width: info.width, height: info.height, ...(icc && {icc})};
  return {data: bytes(await encode(pixels, {effort, fidelity: {quality: asked(options.quality) ?? quality}}), options.src), format: 'jxl'};
}

export default {...sharpService, validateOptions, getHTMLAttributes, propertiesToHash, transform};
