// SPDX-License-Identifier: MIT
// ICC profiles for the tests (never shipped), made of the tags a display profile carries, and a JPEG given one in an
// APP2 segment. The colorants are D50 (Bradford), as profile makers write them.
const ascii = text => [...text].map(c => c.charCodeAt(0));
const u32 = value => [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
const s15 = value => u32(Math.round(value * 65536) >>> 0);

export const COLORANTS = {
  srgb: [[0.436041, 0.222485, 0.01392], [0.385113, 0.716905, 0.097067], [0.143046, 0.06061, 0.713913]],
  'display-p3': [[0.515119, 0.241189, -0.00105], [0.291978, 0.692244, 0.041879], [0.157103, 0.066567, 0.784071]],
  'adobe-rgb': [[0.609741, 0.311113, 0.019465], [0.205273, 0.625675, 0.060875], [0.149187, 0.063212, 0.74456]],
};
const srgb = x => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
export const CURVES = {
  // The sRGB curve as ICC's parametric curve 3, as a table of 1,024 entries, and a plain gamma of 2.2.
  para: [...ascii('para'), 0, 0, 0, 0, 0, 3, 0, 0, ...[2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045].flatMap(s15)],
  table: [...ascii('curv'), 0, 0, 0, 0, ...u32(1024), ...Array.from({length: 1024}, (_, i) => { const v = Math.round(65535 * srgb(i / 1023)); return [v >> 8, v & 255]; }).flat()],
  gamma: [...ascii('curv'), 0, 0, 0, 0, ...u32(1), 2, 51],
};

// A profile of the given tags ([signature, bytes]), its header naming the colour space and the XYZ connection space.
export function iccProfile(space, tags) {
  const table = [], data = [], start = 132 + tags.length * 12;
  for (const [name, bytes] of tags) {
    table.push(...ascii(name), ...u32(start + data.length), ...u32(bytes.length));
    data.push(...bytes);
    while (data.length % 4) data.push(0);
  }
  const header = new Array(128).fill(0);
  header.splice(0, 4, ...u32(start + data.length));
  header.splice(8, 4, 2, 0x10, 0, 0);
  header.splice(12, 12, ...ascii('mntr'), ...ascii(space), ...ascii('XYZ '));
  header.splice(36, 4, ...ascii('acsp'));
  header.splice(68, 12, ...s15(0.9642), ...s15(1), ...s15(0.8249));
  return Uint8Array.from([...header, ...u32(tags.length), ...table, ...data]);
}

// A profile's description tag: what it says, which says nothing about what it does.
export const descriptionTag = text => [...ascii('desc'), 0, 0, 0, 0, ...u32(text.length + 1), ...ascii(text), 0];

// A display profile: RGB with three colorants and one curve for every channel, or grey with its curve.
export function displayProfile({colorants = 'srgb', curve = 'para', description = 'a test profile', grey = false, extra = []} = {}) {
  const desc = descriptionTag(description);
  if (grey) return iccProfile('GRAY', [['desc', desc], ['kTRC', CURVES[curve]], ...extra]);
  const xyz = ([x, y, z]) => [...ascii('XYZ '), 0, 0, 0, 0, ...s15(x), ...s15(y), ...s15(z)];
  const [r, g, b] = COLORANTS[colorants];
  return iccProfile('RGB ', [['desc', desc], ['rXYZ', xyz(r)], ['gXYZ', xyz(g)], ['bXYZ', xyz(b)], ['rTRC', CURVES[curve]], ['gTRC', CURVES[curve]], ['bTRC', CURVES[curve]], ...extra]);
}

// The JPEG with the profile in one APP2 segment after its start of image.
export function withProfile(jpeg, profile) {
  const payload = [...ascii('ICC_PROFILE'), 0, 1, 1, ...profile], length = payload.length + 2;
  return Uint8Array.from([0xFF, 0xD8, 0xFF, 0xE2, length >> 8, length & 255, ...payload, ...jpeg.subarray(2)]);
}
