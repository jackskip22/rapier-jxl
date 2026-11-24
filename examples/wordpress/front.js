// SPDX-License-Identifier: MIT
import {supportsJXL} from 'https://cdn.jsdelivr.net/npm/jpegxl@8.5.0/dist/polyfill.mjs';

const CDN = 'https://cdn.jsdelivr.net/npm/jpegxl@8.5.0/dist';
let jpegModule = null;
let decodeModule = null;
const cache = new Map();
const pendingUpgrades = new WeakMap();

export function parseSrcset(value) {
  const text = String(value || ''), entries = [];
  let offset = 0;
  while (offset < text.length) {
    while (/[\t\n\f\r ,]/.test(text[offset] || '') && offset < text.length) offset++;
    const start = offset;
    while (offset < text.length && !/[\t\n\f\r ]/.test(text[offset])) offset++;
    let url = text.slice(start, offset), descriptor = '';
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
    } else {
      const descriptorStart = offset;
      while (offset < text.length && text[offset] !== ',') offset++;
      descriptor = text.slice(descriptorStart, offset).trim();
    }
    const width = /^(\d+)w$/.exec(descriptor);
    if (url && (!descriptor || width) && (!width || Number(width[1]) > 0)) {
      entries.push({url, width: width ? Number(width[1]) : 0});
    }
  }
  return entries.sort((a, b) => a.width - b.width);
}

export function measureSizes(sizesAttr, img) {
  const fallback = img.getBoundingClientRect().width || Number(img.getAttribute('width')) || window.innerWidth;
  if (!sizesAttr) return fallback;
  for (const raw of sizesAttr.split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const match = /^(\([^)]+\))\s+(.+)$/.exec(part);
    const media = match ? match[1] : '';
    const length = match ? match[2].trim() : part;
    if (media && !window.matchMedia(media).matches) continue;
    if (length.endsWith('vw')) {
      return (parseFloat(length) / 100) * window.innerWidth;
    }
    if (length.endsWith('px')) {
      return parseFloat(length);
    }
  }
  return fallback;
}

export function chooseCandidate(entries, neededPixels) {
  if (!entries.length) return null;
  for (const entry of entries) {
    if (entry.width >= neededPixels) return entry;
  }
  return entries[entries.length - 1];
}

async function pixelsToPngBlob(data, width, height) {
  const clamped = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d').putImageData(new ImageData(clamped, width, height), 0, 0);
    return canvas.convertToBlob({type: 'image/png'});
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').putImageData(new ImageData(clamped, width, height), 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('Canvas encode failed'))), 'image/png');
  });
}

async function rebuildUrl(url, isExactJpeg) {
  const key = (isExactJpeg ? 'jpeg:' : 'decode:') + url;
  if (!cache.has(key)) {
    cache.set(key, (async () => {
      const response = await fetch(url, {credentials: 'same-origin'});
      if (!response.ok) throw new Error('JPEG XL fetch failed: ' + response.status);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (isExactJpeg) {
        jpegModule ??= import(`${CDN}/jpeg.browser.mjs`);
        const {restore} = await jpegModule;
        const restored = await restore(bytes);
        return URL.createObjectURL(new Blob([restored.bytes], {type: 'image/jpeg'}));
      }
      decodeModule ??= import(`${CDN}/decode.browser.mjs`);
      const {decode} = await decodeModule;
      const decoded = await decode(bytes, {format: 'uint8', colorSpace: 'srgb'});
      const blob = await pixelsToPngBlob(decoded.data, decoded.width, decoded.height);
      return URL.createObjectURL(blob);
    })().catch(error => {
      cache.delete(key);
      throw error;
    }));
  }
  return cache.get(key);
}

export async function upgradePicture(picture) {
  const img = picture.querySelector('img[data-jxl-space-saver="1"]');
  if (!img) return;

  const source = picture.querySelector('source[type="image/jxl"], source[data-jxl-srcset]');
  if (source && !source.dataset.jxlSrcset) {
    source.dataset.jxlSrcset = source.getAttribute('srcset') || '';
    source.dataset.jxlSizes = source.getAttribute('sizes') || '';
    source.removeAttribute('srcset');
    source.removeAttribute('type');
  }

  const rawSrcset = picture.dataset.jxlSrcset || source?.dataset.jxlSrcset || img.dataset.jxlSrcset || '';
  const rawSizes = picture.dataset.jxlSizes || source?.dataset.jxlSizes || img.dataset.jxlSizes || '';
  if (!rawSrcset) return;

  const entries = parseSrcset(rawSrcset);
  const cssWidth = measureSizes(rawSizes, img);
  const neededPixels = Math.max(1, cssWidth * (window.devicePixelRatio || 1));
  const chosen = chooseCandidate(entries, neededPixels);
  if (!chosen || img.dataset.jxlRebuiltUrl === chosen.url || pendingUpgrades.get(img)?.url === chosen.url) return;
  const request = {url: chosen.url};
  pendingUpgrades.set(img, request);
  const stillCurrent = () => pendingUpgrades.get(img) === request &&
    picture.querySelector('img[data-jxl-space-saver="1"]') === img &&
    (picture.dataset.jxlSrcset || source?.dataset.jxlSrcset || img.dataset.jxlSrcset || '') === rawSrcset;

  try {
    const blobUrl = await rebuildUrl(chosen.url, img.dataset.jxlJpeg === '1');
    if (typeof Image === 'function') {
      const preload = new Image();
      preload.src = blobUrl;
      await preload.decode?.().catch(() => {});
    }
    if (!stillCurrent()) return;
    img.src = blobUrl;
    img.dataset.jxlRebuiltUrl = chosen.url;
  } catch (error) {
    console.warn('JPEG XL fallback rebuild kept server preview:', error);
  } finally {
    if (pendingUpgrades.get(img) === request) pendingUpgrades.delete(img);
  }
}

async function boot() {
  if (typeof document === 'undefined') return;
  if (await supportsJXL()) return;

  const scan = () => {
    document.querySelectorAll('picture.rapier-jxl-picture').forEach(upgradePicture);
  };
  scan();

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(scan, 150);
  });

  new MutationObserver(scan).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

boot();
