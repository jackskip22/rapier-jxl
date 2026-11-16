// SPDX-License-Identifier: MIT
// Netlify edge function: a JPEG or PNG the build gave a .jxl is answered with that file where the browser sends
// `Accept: image/jxl`; every other request goes on untouched. The build plug-in writes this file with the list of
// pictures it converted (WITH_JXL), so a picture with no .jxl is never sent to a missing file.
const WITH_JXL = new Set(/* paths */[]);

// The next two functions are rapier-jxl/serve's, copied unchanged (an edge file cannot import the package): the same
// answer to every Accept header. A test holds the copy equal to the source and runs the same cases through both.
// RFC 9110 12.5.1: image/jxl only where the request names it with q > 0, and not below the alternative's own weight.
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
  // An unclosed quote would take every range after it: the header names nothing.
  if (quoted || escaped) return [];
  parts.push(text.slice(start));
  return parts;
}
function acceptsJxl(acceptHeader, alternative = 'image/jpeg') {
  if (typeof acceptHeader !== 'string') return false;
  if (typeof alternative !== 'string') throw fail('JXL_OPTIONS', 'Invalid alternative media type; pass a MIME type string.');
  // The alternative is a concrete type/subtype media type, compared in lower case as the header's ranges are.
  alternative = alternative.split(';', 1)[0].trim().toLowerCase();
  if (!/^[!#$%&'*+\-.^_`|~0-9a-z]+\/[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(alternative) || alternative.startsWith('*/') || alternative.endsWith('/*'))
    throw fail('JXL_OPTIONS', 'Invalid alternative media type; pass a concrete type/subtype MIME string.');
  const q = Object.create(null);
  for (const part of headerParts(acceptHeader, ',')) {
    const [type, ...params] = headerParts(part, ';').map(text => text.trim());
    const range = type.toLowerCase();
    if (!['image/jxl', alternative, 'image/*', '*/*'].includes(range)) continue;
    // RFC 9110 12.5.1: the q parameter is the weight wherever it stands ("regardless of parameter ordering"); every other
    // parameter, before or after it, is the media range's own (9110 has no accept-ext).
    let weight = 1, seenQ = false, mediaParams = false;
    for (const param of params) {
      if (!param) continue;
      const at = param.indexOf('='), key = (at < 0 ? param : param.slice(0, at)).trim(), value = at < 0 ? '' : param.slice(at + 1).trim();
      if (!seenQ && key.toLowerCase() === 'q') {
        seenQ = true;
        weight = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value) ? Number(value) : NaN;
      } else mediaParams = true;
    }
    // A JXL range with parameters names a variant this server does not make: it does not select the bare file.
    if (range === 'image/jxl' && mediaParams) continue;
    // A range with parameters refusing its type (q=0) does not refuse the bare alternative or mask a wider range; an
    // unreadable weight on the alternative's ranges counts as 1, so it never lets a lower JXL weight win.
    if (mediaParams && weight === 0) continue;
    if (!Number.isNaN(weight)) q[range] = Math.max(q[range] ?? 0, weight);
    else if (range !== 'image/jxl') q[range] = Math.max(q[range] ?? 0, 1);
  }
  const other = q[alternative] ?? q['image/*'] ?? q['*/*'] ?? 0;
  return (q['image/jxl'] ?? 0) > 0 && q['image/jxl'] >= other;
}

// A Vary with Accept added once, and a Netlify-Vary with header=Accept added once: the origin's own variation stays. Null
// where the origin names headers in a form this does not extend (it is then left as it is).
const varied = vary => !vary ? 'Accept' : /(?:^|,)\s*(?:\*|accept)\s*(?:,|$)/i.test(vary) ? vary : `${vary}, Accept`;
function netlifyVaried(vary) {
  if (!vary?.trim()) return 'header=Accept';
  const headers = vary.split(',').map(part => part.trim()).find(part => /^header=/i.test(part));
  if (!headers) return `${vary}, header=Accept`;
  return headers.slice(7).split('|').some(name => name.trim().toLowerCase() === 'accept') ? vary : null;
}

export default async (request, context) => {
  const {pathname} = new URL(request.url);
  // A part of the picture (Range) is the site's to answer: the whole JPEG XL file is not a part of it.
  if (!WITH_JXL.has(pathname) || !['GET', 'HEAD'].includes(request.method) || request.headers.has('range')) return;
  let response = null;
  if (acceptsJxl(request.headers.get('accept') ?? '', /\.png$/i.test(pathname) ? 'image/png' : 'image/jpeg')) {
    response = await fetch(new URL(pathname.replace(/\.[^./]+$/, '.jxl'), request.url), {method: request.method});
    if (!response.ok || netlifyVaried(response.headers.get('netlify-vary')) === null) response = null;
  }
  const jxl = response !== null;
  response ??= await context.next();
  // Netlify's cache keeps one copy per Accept: a browser without JPEG XL is never handed one.
  const netlify = netlifyVaried(response.headers.get('netlify-vary'));
  if (netlify === null) return response;
  const headers = new Headers(response.headers);
  if (jxl) headers.set('Content-Type', 'image/jxl');
  headers.set('Vary', varied(headers.get('vary')));
  headers.set('Netlify-Vary', netlify);
  return new Response(response.body, {status: response.status, headers});
};

export const config = {path: ['/*.jpg', '/*.jpeg', '/*.png', '/*.JPG', '/*.JPEG', '/*.PNG'], cache: 'manual'};
