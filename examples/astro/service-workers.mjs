// The same service inside a Cloudflare Worker, for on-demand images (no sharp there). format="jxl":
//   a JPEG at its own uncropped size with jpeg: 'exact' and no quality is recompressed (restores the original exactly);
//   otherwise the pixels come from the Images binding (env.IMAGES, resized and cropped as asked) or, for an uncropped PNG, from rapier-jxl itself.
// Other formats go through the Images binding when the Worker has one. Whatever cannot be made, or any JXL_* refusal,
// serves the original file: a page never breaks for the encoder.
import {baseService} from 'astro/assets';
import {encode, variants} from 'jpegxl';
import {recompress} from 'jpegxl/jpeg';
import {asked, bytes, getHTMLAttributes, propertiesToHash, settings, validateOptions} from './options.mjs';

const MIME = {jxl: 'image/jxl', webp: 'image/webp', avif: 'image/avif', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg'};
const FIT = {fill: 'squeeze', contain: 'contain', cover: 'cover', none: 'scale-down', 'scale-down': 'scale-down', outside: 'cover', inside: 'contain'};
const BOUNDING = new Set(['contain', 'inside', 'scale-down']);
const NAMED_GRAVITY = {
  auto: 'auto', attention: 'auto', entropy: 'auto',
  left: 'left', west: 'left', right: 'right', east: 'right', top: 'top', north: 'top', bottom: 'bottom', south: 'bottom',
  'left top': {x: 0, y: 0}, 'top left': {x: 0, y: 0}, northwest: {x: 0, y: 0},
  'right top': {x: 1, y: 0}, 'top right': {x: 1, y: 0}, northeast: {x: 1, y: 0},
  'left bottom': {x: 0, y: 1}, 'bottom left': {x: 0, y: 1}, southwest: {x: 0, y: 1},
  'right bottom': {x: 1, y: 1}, 'bottom right': {x: 1, y: 1}, southeast: {x: 1, y: 1},
};
const X_AXIS = {left: 0, center: 0.5, centre: 0.5, right: 1};
const Y_AXIS = {top: 0, center: 0.5, centre: 0.5, bottom: 1};

// A JPEG's size as it is shown: its first frame header's, with width and height swapped where its Exif orientation is 5 to 8.
function jpegSize(data) {
  let size = null, turned = false;
  for (let at = 2; at + 4 <= data.length;) {
    if (data[at] !== 0xff) return null;
    const marker = data[at + 1];
    if (marker === 0xff) { at++; continue; } // a fill byte before a marker is legal
    if (marker === 0xda) break;
    const end = at + 2 + (data[at + 2] << 8 | data[at + 3]);
    if (marker === 0xe1 && String.fromCharCode(...data.subarray(at + 4, at + 10)) === 'Exif\0\0') turned = orientation(data.subarray(at + 10, end)) >= 5;
    if (!size && at + 9 <= data.length && marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      size = {height: data[at + 5] << 8 | data[at + 6], width: data[at + 7] << 8 | data[at + 8]};
    at = end;
  }
  return size && (turned ? {width: size.height, height: size.width} : size);
}
// The orientation in an Exif segment's TIFF bytes (1 where it has none).
function orientation(tiff) {
  if (tiff.length < 8) return 1;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength), little = tiff[0] === 0x49, ifd = view.getUint32(4, little);
  if (ifd + 2 > tiff.length) return 1;
  for (let i = 0, count = view.getUint16(ifd, little), entry = ifd + 2; i < count && entry + 12 <= tiff.length; i++, entry += 12)
    if (view.getUint16(entry, little) === 0x0112) return view.getUint16(entry + 2, little) === 4 ? view.getUint32(entry + 8, little) : view.getUint16(entry + 8, little);
  return 1;
}
// A PNG's size as it is shown: IHDR width and height, swapped where a pre-IDAT eXIf chunk carries orientation 5 to 8.
function pngSize(data) {
  if (data.length < 24) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const width = view.getUint32(16), height = view.getUint32(20);
  if (!width || !height) return null;
  let turned = false;
  for (let at = 8; at + 8 <= data.length;) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(data[at + 4], data[at + 5], data[at + 6], data[at + 7]);
    if (type === 'IDAT' || at + 12 + length > data.length) break;
    if (type === 'eXIf') turned = orientation(data.subarray(at + 8, at + 8 + length)) >= 5;
    at += 12 + length;
  }
  return turned ? {width: height, height: width} : {width, height};
}
function gravityOf(position) {
  if (!position) return undefined;
  if (typeof position === 'object' && Number.isFinite(position.x) && Number.isFinite(position.y))
    return {x: Math.min(1, Math.max(0, position.x)), y: Math.min(1, Math.max(0, position.y))};
  if (typeof position !== 'string') return undefined;
  const norm = position.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!norm || norm === 'center' || norm === 'centre' || norm === '50%' || norm === '50% 50%' || norm === 'center center' || norm === 'centre centre')
    return undefined;
  if (NAMED_GRAVITY[norm]) return NAMED_GRAVITY[norm];
  const parts = norm.split(' ');
  if (parts.length === 1 && parts[0].endsWith('%')) {
    const x = Number(parts[0].slice(0, -1)) / 100;
    return Number.isFinite(x) ? {x: Math.min(1, Math.max(0, x)), y: 0.5} : undefined;
  }
  if (parts.length === 2) {
    const read = (token, map) => token.endsWith('%') ? Number(token.slice(0, -1)) / 100 : map[token];
    const x = read(parts[0], X_AXIS), y = read(parts[1], Y_AXIS);
    return Number.isFinite(x) && Number.isFinite(y) ? {x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y))} : undefined;
  }
  if (parts.length === 4 && (parts[0] === 'left' || parts[0] === 'right') && (parts[2] === 'top' || parts[2] === 'bottom') &&
      parts[1].endsWith('%') && parts[3].endsWith('%')) {
    const dx = Number(parts[1].slice(0, -1)) / 100, dy = Number(parts[3].slice(0, -1)) / 100;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return undefined;
    return {x: Math.min(1, Math.max(0, parts[0] === 'right' ? 1 - dx : dx)), y: Math.min(1, Math.max(0, parts[2] === 'bottom' ? 1 - dy : dy))};
  }
  return undefined;
}
function keepsWholeFrame(own, width, height, fit) {
  if (!own || (width && width < own.width) || (height && height < own.height)) return false;
  if (!width || !height || BOUNDING.has(fit)) return true;
  if (fit === 'fill') return width === own.width && height === own.height;
  return Math.round(own.height * width / own.width) === height && Math.round(own.width * height / own.height) === width;
}
const kind = data => data[0] === 0xff && data[1] === 0xd8 ? 'jpeg' : data[0] === 0x89 && data[1] === 0x50 ? 'png' : null;

let images;
async function binding(config) {
  if (images === undefined) {
    const name = config.service.config?.imagesBindingName ?? 'IMAGES';
    try { images = (await import('cloudflare:workers')).env[name] ?? null; } catch { images = null; }
  }
  return images;
}

async function through(images, input, options, mime, quality) {
  const size = {width: options.width && Math.round(options.width), height: options.height && Math.round(options.height)};
  const fit = size.width && size.height
    ? (options.fit === 'fill' && options.background ? 'pad' : options.fit ? FIT[options.fit] ?? 'contain' : 'cover')
    : 'scale-down';
  const gravity = fit === 'cover' ? gravityOf(options.position) : undefined;
  const result = await images.input(new Blob([input]).stream()).transform({...size, fit,
    ...(gravity !== undefined && {gravity}),
    ...(options.background && {background: options.background})}).output({format: mime, ...(quality && {quality})});
  return new Uint8Array(await result.response().arrayBuffer());
}

async function transform(input, options, config, logger) {
  const source = kind(input), original = {data: input, format: source === 'jpeg' ? 'jpg' : source ?? 'png'};
  const images = await binding(config);
  try {
    if (options.format !== 'jxl') return images && MIME[options.format] ? {data: await through(images, input, options, MIME[options.format], asked(options.quality)), format: options.format} : original;
    const {effort, quality, jpeg, maxPixels} = settings(config, true);
    const reqWidth = options.width && Math.round(options.width), reqHeight = options.height && Math.round(options.height);
    if (jpeg === 'exact' && source === 'jpeg' && asked(options.quality) === undefined && !options.background) {
      // Astro gives an imported picture its own width; a smaller side or a cover crop cannot use lossless recompression.
      if (keepsWholeFrame(jpegSize(input), reqWidth, reqHeight, options.fit))
        return {data: bytes(await recompress(input, {effort, maxPixels}), options.src), format: 'jxl'};
    }
    const fidelity = {quality: asked(options.quality) ?? quality};
    if (images) return {data: bytes(await encode(new Blob([await through(images, input, options, 'image/png')], {type: 'image/png'}), {effort, maxPixels, fidelity}), options.src), format: 'jxl'};
    // Without the binding a PNG is read and resized by rapier-jxl only when the request needs no crop, stretch or background.
    const png = source === 'png' && !options.background && pngSize(input);
    if (png) {
      let width = null;
      if (reqWidth && reqHeight && BOUNDING.has(options.fit)) {
        const scale = Math.min(1, reqWidth / png.width, reqHeight / png.height);
        width = Math.max(1, Math.round(png.width * scale));
      } else if (!reqWidth || !reqHeight ||
          (options.fit !== 'fill' && gravityOf(options.position) === undefined &&
           Math.abs(Math.round(Math.min(reqWidth, png.width) * png.height / png.width) - Math.min(reqHeight, png.height)) <= 1) ||
          (options.fit === 'fill' && reqWidth === png.width && reqHeight === png.height)) {
        width = Math.min(Math.round(reqWidth ?? (reqHeight ? reqHeight * png.width / png.height : png.width)), png.width);
      }
      if (width !== null) {
        const blob = new Blob([input], {type: 'image/png'});
        const result = width < png.width ? (await variants(blob, {effort, maxPixels, fidelity, outputs: [{width}]}))[0] : await encode(blob, {effort, maxPixels, fidelity});
        return {data: bytes(result, options.src), format: 'jxl'};
      }
    }
    logger.warn(`${options.src}: no Images binding in this Worker to read or crop a ${source ?? 'picture'}; the original is served`);
  } catch (error) {
    logger.warn(`${options.src}: ${error.code ?? error.name} ${error.message}; the original is served`);
  }
  return original;
}

export default {...baseService, validateOptions, getHTMLAttributes, propertiesToHash, transform};
