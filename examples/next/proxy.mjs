// SPDX-License-Identifier: MIT
// next/image's requests (/_next/image?url=...&w=...) answered with the JPEG XL file rapier-jxl-next.mjs wrote, where the
// browser sends `Accept: image/jxl`; every other request goes on to Next's own image optimizer, as without it. Runs in
// Next 16's proxy.js (Node) and in middleware.js on the edge runtime. A picture with no .jxl (one the build step left,
// added later, or removed) goes on to Next too: Node looks on disk; the edge, which has no file system, asks for it.
import {NextResponse} from 'next/server';

// Node's file system where the runtime has one (Next 16's proxy), read without an import so the edge bundle builds.
// The edge runtime (EdgeRuntime set) throws on any use of process.getBuiltinModule, so it is not touched there.
const fs = typeof EdgeRuntime === 'string' ? null : globalThis.process?.getBuiltinModule?.('node:fs');
const PUBLIC = fs && globalThis.process.cwd() + '/public';

/** The JPEG XL file's path for a picture's URL path and width (the same as rapier-jxl-next.mjs writes). */
const jxlPath = (url, width) => `/_jxl/w${width}${url}.jxl`;
const LOCAL_IMAGE = /^\/(?!\/)[^?#]*\.(?:jpe?g|png)$/i;

/** Whether a path climbs: any segment that is `.` or `..` once its percent escapes (even stacked ones) are undone, or a
 * backslash, which URL parsing reads as a slash. A malformed escape counts as climbing. */
function climbs(path) {
  try {
    for (let segment of path.split('/')) {
      for (let before = ''; before !== segment;) before = segment, segment = decodeURIComponent(segment);
      if (segment === '.' || segment === '..' || segment.includes('\\') || segment.includes('/')) return true;
    }
  } catch { return true; }
  return false;
}

/** Use in proxy.js: `export {jxlProxy as proxy}`, with `export const config = {matcher: '/_next/image'}` written there
 * (Next reads a config only where it is declared). @param {import('next/server').NextRequest} request */
function acceptsJxl(header) {
  if (!header) return false;
  for (const part of header.split(',')) {
    const [type, ...params] = part.split(';').map(s => s.trim());
    if (type.toLowerCase() !== 'image/jxl') continue;
    const q = params.find(p => /^q\s*=/i.test(p))?.split('=')[1]?.trim();
    if (q === undefined || Number(q) > 0) return true;
  }
  return false;
}

export async function jxlProxy(request) {
  if (request.method && !['GET', 'HEAD'].includes(request.method)) return;
  const {pathname, searchParams} = request.nextUrl;
  if (pathname !== '/_next/image' || !acceptsJxl(request.headers.get('accept'))) return;
  const url = searchParams.get('url') ?? '', width = Number(searchParams.get('w'));
  if (!LOCAL_IMAGE.test(url) || !Number.isInteger(width) || width < 1 || climbs(url)) return;
  const path = jxlPath(url, width);
  if (fs ? !fs.existsSync(PUBLIC + path) : !(await fetch(new URL(path, request.url), {method: 'HEAD'}).then(r => r.ok, () => false))) return;
  const response = NextResponse.rewrite(new URL(path, request.url));
  response.headers.set('Vary', 'Accept');
  return response;
}
