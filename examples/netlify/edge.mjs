// SPDX-License-Identifier: MIT
// Netlify edge function: a JPEG or PNG the build gave a .jxl is answered with that file where the browser sends
// `Accept: image/jxl`; every other request goes on untouched. The build plug-in writes this file with the list of
// pictures it converted (WITH_JXL), so a picture with no .jxl is never sent to a missing file.
const WITH_JXL = new Set(/* paths */[]);

import {acceptsJxl} from '../files/accept.mjs';

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
