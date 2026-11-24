// SPDX-License-Identifier: MIT
const fail = (code, message) => Object.assign(new Error(message), {code});

function headerParts(text, separator) {
  const parts = [];
  let start = 0, quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (escaped) { escaped = false; continue; }
    if (quoted && char === '\\') { escaped = true; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (!quoted && char === separator) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  if (quoted || escaped) return [];
  parts.push(text.slice(start));
  return parts;
}
export function acceptsJxl(acceptHeader, alternative = 'image/jpeg') {
  normalizeType(alternative);
  if (acceptHeader === null || acceptHeader === undefined) return false;
  if (typeof acceptHeader !== 'string') throw fail('JXL_OPTIONS', "Invalid Accept header; pass its text, such as request.headers.get('accept').");
  const [jxl, other] = acceptWeights(acceptHeader, [alternative]);
  return jxl > 0 && jxl >= other;
}
export function acceptWeights(acceptHeader, alternatives) {
  const types = alternatives.map(alternative => normalizeType(alternative));
  const wildcards = types.map(type => type.slice(0, type.indexOf('/') + 1) + '*');
  const ranges = new Set(['image/jxl', '*/*', ...types, ...wildcards]);
  const exact = Object.create(null), parameterized = Object.create(null);
  for (const part of headerParts(acceptHeader, ',')) {
    const [type, ...params] = headerParts(part, ';').map(text => text.trim());
    const range = type.toLowerCase();
    if (!ranges.has(range)) continue;
    let weight = 1, seenQ = false, mediaParams = false;
    for (const param of params) {
      if (!param) continue;
      const at = param.indexOf('='), key = (at < 0 ? param : param.slice(0, at)).trim(), value = at < 0 ? '' : param.slice(at + 1).trim();
      if (!seenQ && key.toLowerCase() === 'q') {
        seenQ = true;
        weight = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value) ? Number(value) : NaN;
      } else mediaParams = true;
    }
    if (range === 'image/jxl' && mediaParams) continue;
    if (mediaParams && weight === 0) continue;
    const q = mediaParams ? parameterized : exact;
    if (!Number.isNaN(weight)) q[range] = Math.max(q[range] ?? 0, weight);
    else if (range !== 'image/jxl') q[range] = Math.max(q[range] ?? 0, 1);
  }
  return [exact['image/jxl'] ?? 0, ...types.map((type, i) => {
    const base = exact[type] ?? exact[wildcards[i]] ?? exact['*/*'];
    if (base === 0) return -1;
    return Math.max(base ?? 0, parameterized[type] ?? 0, parameterized[wildcards[i]] ?? 0, parameterized['*/*'] ?? 0);
  })];
}
export function normalizeType(alternative) {
  if (typeof alternative !== 'string') throw fail('JXL_OPTIONS', 'Invalid alternative media type; pass a MIME type string.');
  alternative = alternative.split(';', 1)[0].trim().toLowerCase();
  if (!/^[!#$%&'*+\-.^_`|~0-9a-z]+\/[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(alternative) || alternative.startsWith('*/') || alternative.endsWith('/*'))
    throw fail('JXL_OPTIONS', 'Invalid alternative media type; pass a concrete type/subtype MIME string.');
  return alternative;
}

