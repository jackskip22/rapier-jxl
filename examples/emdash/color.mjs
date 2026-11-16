// Ruling 91: a copy whose color differs from its source's is stale. Both colors are read from headers alone
// (rapier-jxl/metadata inspect, ruling 279), never by a decode: the copy's from its first bytes, the source's (a JPEG or
// PNG) from its first 64 KiB, as encode codes it lossy.
import {inspect} from 'jpegxl/metadata';

export const COLOR_HEADER_BYTES = 64 * 1024;
const WHITES = ['d65', 'e', 'dci', 'd50'], PRIMARIES = ['srgb', 'display-p3', 'rec2020'];
const TRANSFERS = ['srgb', 'linear', 'bt709', 'dci', 'pq', 'hlg', 'unknown'];
const xy = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);
const named = (value, names, size) => names.includes(value) ||
  (size === 1 ? xy(value) : Array.isArray(value) && value.length === 3 && value.every(xy));

// A header's color as a small record: what the samples mean when the header names it (white point, primaries for
// RGB, transfer or gamma), or {profile: true} when only an ICC profile describes them. The rendering intent is not
// part of it. null when the header cannot be read.
export async function colorOf(bytes) {
  let encoding;
  try { encoding = (await inspect(bytes)).colorEncoding; } catch { return null; }
  if (!encoding || encoding.transferFunction === 'icc') return {profile: true};
  const gray = encoding.space === 'gray';
  if (!gray && encoding.space !== 'rgb') return {profile: true};
  return {space: gray ? 'gray' : 'rgb', whitePoint: encoding.whitePoint ?? 'd65',
    ...(!gray && {primaries: encoding.primaries ?? 'srgb'}),
    ...(encoding.gamma !== undefined ? {gamma: encoding.gamma} : {transferFunction: encoding.transferFunction ?? 'srgb'})};
}

// A stored color record as colorOf writes it.
export function isColor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (value.profile === true) return keys.length === 1;
  if (!['rgb', 'gray'].includes(value.space) || !named(value.whitePoint, WHITES, 1)) return false;
  if (value.space === 'rgb' ? !named(value.primaries, PRIMARIES, 3) : 'primaries' in value) return false;
  const curve = value.gamma !== undefined ? Number.isFinite(value.gamma) && value.gamma > 0 && !('transferFunction' in value)
    : TRANSFERS.includes(value.transferFunction);
  return curve && keys.every(key => ['space', 'whitePoint', 'primaries', 'transferFunction', 'gamma'].includes(key));
}

// Whether a copy keeps its source's color. Where either header leaves the color to a profile, headers cannot tell
// them apart, and the copy is not called stale (a remade copy would read the same, every run). Gray against RGB
// compares white and curve: a gray picture has no primaries.
export function sameColor(color, sourceColor) {
  if (color.profile || sourceColor.profile) return true;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  return same(color.whitePoint, sourceColor.whitePoint) && same(color.gamma, sourceColor.gamma) &&
    same(color.transferFunction, sourceColor.transferFunction) &&
    (color.space !== 'rgb' || sourceColor.space !== 'rgb' || same(color.primaries, sourceColor.primaries));
}

// The sources whose header rapier-jxl/metadata reads: a copy of any other is never checked.
export const checkable = key => /\.(?:jpe?g|jpe|jfif|png)$/i.test(key);
