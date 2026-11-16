import {serve, acceptsJxl as accepts} from 'jpegxl/serve';

const FILE = /^\/_emdash\/api\/media\/file\/([0-9A-HJKMNP-TV-Z]{26}(?:\.[0-9A-HJKMNP-TV-Z]{26})*\.(?:jpe?g|jpe|jfif|png|webp|avif))$/i;
const REPLACE = /^\/_emdash\/api\/media\/[0-9A-HJKMNP-TV-Z]{26}\/replace$/i;
const WIDTH_FORMATS = new Map([[null, 'image/webp'], ['webp', 'image/webp'], ['avif', 'image/avif'],
  ['jpeg', 'image/jpeg'], ['jpg', 'image/jpeg'], ['png', 'image/png']]);
const NAMED_QUALITY = new Map([['low', 25], ['mid', 50], ['high', 80], ['max', 100]]);
const ALLOWED_PARAMS = new Set(['href', 'w', 'h', 'f', 'q', 'fit', 'pos', 'position']);
const CENTERED_POSITION = new Set(['center', 'centre', '50%', '50% 50%', 'center center', 'centre centre']);
const BOUNDING_FITS = new Set(['contain', 'inside', 'scale-down']);
const EXACT_BOX_FITS = new Set([null, 'cover', 'fill', 'outside']);
const SANDBOX = "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'";
export const mediaKey = url => FILE.exec(new URL(url).pathname)?.[1] ?? null;

// Explicit support, honoring exclusions: serve()'s own negotiation, against the media file's own type.
export const acceptsJxl = (value, alternative = 'image/webp') => accepts(value, alternative);
const secure = response => {
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('content-security-policy', SANDBOX);
  response.headers.set('content-disposition', 'inline');
  return response;
};
const requestForJxl = request => ({method: request.method,
  headers: {accept: 'image/jxl', 'if-none-match': request.headers.get('if-none-match') ?? ''}});

function askedQuality(raw) {
  if (raw === null) return null;
  if (NAMED_QUALITY.has(raw)) return NAMED_QUALITY.get(raw);
  return /^(?:[1-9][0-9]?|100)$/.test(raw) ? Number(raw) : undefined;
}

function centeredPosition(url) {
  const pos = url.searchParams.get('pos'), position = url.searchParams.get('position');
  if (pos !== null && position !== null && pos !== position) return false;
  const raw = position ?? pos;
  return raw === null || CENTERED_POSITION.has(raw.trim().toLowerCase().replace(/\s+/g, ' '));
}

function matchesQuality(result, format, requestedQuality) {
  const fidelity = result?.fidelity;
  const exact = fidelity === 'exact' || fidelity?.maxError === 0 || fidelity?.quality === 100;
  if (format === 'png') return exact || result?.kept === 'pixels';
  if (requestedQuality === null) return true;
  const storedQuality = exact ? 100 : fidelity?.quality;
  return requestedQuality === 85 || requestedQuality === storedQuality;
}

export async function serveMedia({request, storage}) {
  if (!['GET', 'HEAD'].includes(request.method) || request.headers.has('range') || typeof storage?.sidecar !== 'function') return null;
  const key = mediaKey(request.url);
  if (!key) return null;
  const type = /\.(?:jpe?g|jpe|jfif)$/i.test(key) ? 'image/jpeg' : /\.png$/i.test(key) ? 'image/png' :
    /\.avif$/i.test(key) ? 'image/avif' : 'image/webp';
  if (!acceptsJxl(request.headers.get('accept'), type)) return null;
  const result = await storage.sidecar(key, {signal: request.signal});
  // The copy's stored SHA-256 is already checked by the storage read; it names the tag, so the body is hashed once, not twice.
  return result ? secure(await serve(result.bytes, requestForJxl(request), {maxPixels: storage.maxPixels, signal: request.signal,
    ...(typeof result.etag === 'string' && {etag: result.etag})})) : null;
}

export async function serveWidth({request, storage, endpoint = '/_image'}) {
  const url = new URL(request.url);
  if (url.pathname !== endpoint || !['GET', 'HEAD'].includes(request.method) || request.headers.has('range') ||
      (typeof storage?.variants !== 'function' && typeof storage?.sidecar !== 'function')) return null;
  if ([...url.searchParams.keys()].some(k => !ALLOWED_PARAMS.has(k)) || !centeredPosition(url)) return null;
  const format = url.searchParams.get('f'), alternative = WIDTH_FORMATS.get(format);
  if (!alternative || !acceptsJxl(request.headers.get('accept'), alternative)) return null;
  const requestedQuality = askedQuality(url.searchParams.get('q'));
  if (requestedQuality === undefined) return null;
  const fit = url.searchParams.get('fit');
  if (!EXACT_BOX_FITS.has(fit) && !BOUNDING_FITS.has(fit)) return null;
  const href = url.searchParams.get('href');
  if (!href) return null;
  const hasW = url.searchParams.has('w'), hasH = url.searchParams.has('h');
  const width = hasW ? Number(url.searchParams.get('w')) : null;
  const height = hasH ? Number(url.searchParams.get('h')) : null;
  if (hasW && (!Number.isSafeInteger(width) || width < 1)) return null;
  if (hasH && (!Number.isSafeInteger(height) || height < 1)) return null;
  let source;
  try { source = new URL(href, url); } catch { return null; }
  if (source.origin !== url.origin) return null;
  const key = mediaKey(source);
  if (!key) return null;

  const list = typeof storage.variants === 'function' ? await storage.variants(key, {signal: request.signal}) : [];
  let targetW = width, targetH = height, main = undefined;
  const readMain = async () => {
    if (main === undefined) main = typeof storage.sidecar === 'function' ? await storage.sidecar(key, {signal: request.signal}) : null;
    return main;
  };

  if (BOUNDING_FITS.has(fit)) {
    // Bounding-box fits (contain, inside, scale-down) never crop; resolve the proportional target from the full rendition.
    const full = await readMain();
    if (!full || !Number.isSafeInteger(full.width) || !Number.isSafeInteger(full.height)) {
      if (!hasW) return null;
      const direct = list.find(v => v.width === width && (!hasH || v.result.height === height));
      if (!direct || !matchesQuality(direct.result, format, requestedQuality)) return null;
      const bytes = await storage.readVariant(direct, {signal: request.signal});
      return bytes ? secure(await serve(bytes, requestForJxl(request), {maxPixels: storage.maxPixels, signal: request.signal,
        ...(typeof direct.sha256 === 'string' && {etag: direct.sha256.slice(0, 32)})})) : null;
    }
    const scaleW = hasW ? width / full.width : 1, scaleH = hasH ? height / full.height : 1;
    const rawScale = Math.min(scaleW, scaleH);
    if (rawScale > 1 && fit !== 'scale-down') return null;
    const scale = Math.min(1, rawScale);
    targetW = Math.max(1, Math.round(full.width * scale));
    targetH = Math.max(1, Math.round(full.height * scale));
  } else if (!hasW && hasH) {
    const full = await readMain();
    if (!full || !Number.isSafeInteger(full.width) || !Number.isSafeInteger(full.height) || height > full.height) return null;
    targetW = Math.max(1, Math.round(full.width * height / full.height));
    targetH = height;
  }

  if (targetW !== null) {
    const file = list.find(v => v.width === targetW);
    if (file && (targetH === null || targetH === file.result.height) && matchesQuality(file.result, format, requestedQuality)) {
      const bytes = await storage.readVariant(file, {signal: request.signal});
      if (bytes) return secure(await serve(bytes, requestForJxl(request), {maxPixels: storage.maxPixels, signal: request.signal,
        ...(typeof file.sha256 === 'string' && {etag: file.sha256.slice(0, 32)})}));
    }
  }

  // Full-size hits (intrinsic width in responsive srcset, 2x density at source width, scale-down clamp, or bare href)
  // use the verified main rendition when its displayed width and height match the uncropped request.
  const full = await readMain();
  if (!full || (targetW !== null && full.width !== targetW) || (targetH !== null && full.height !== targetH) ||
      !matchesQuality(full, format, requestedQuality)) return null;
  return secure(await serve(full.bytes, requestForJxl(request), {maxPixels: storage.maxPixels, signal: request.signal,
    ...(typeof full.etag === 'string' && {etag: full.etag})}));
}

// EmDash fires media:afterUpload only after signed and plug-in uploads; its admin uploads and replaces on R2 bindings
// and local storage directly, so the plug-in's hook gets those writes here, and no other plug-in's.
export async function announceUpload(hooks, response, id = 'rapier-media') {
  if (![200, 201].includes(response.status) || typeof hooks?.getTypedHooks !== 'function' || typeof hooks.getContext !== 'function') return;
  const data = (await response.clone().json().catch(() => null))?.data, item = data?.item ?? data;
  if (!item?.id || typeof item.url !== 'string') return;
  const media = {id: item.id, filename: item.filename, mimeType: item.mimeType, size: item.size, url: item.url, createdAt: item.createdAt};
  for (const hook of hooks.getTypedHooks('media:afterUpload').filter(hook => hook.pluginId === id))
    await hook.handler({media}, hooks.getContext(id));
}

// EmDash answers its image endpoint without its runtime: there locals.emdash is the storage alone, with no route
// metadata. That storage is the process's one cached adapter, so the last full request's live route-metadata reader is
// kept on it: a plug-in disabled since then reads disabled at once, and before any full request the host answers.
const activation = new WeakMap();
export async function onRequest(context, next) {
  const emdash = context.locals.emdash, storage = emdash?.storage, request = context.request;
  // Native storage remains configured when a plugin is disabled. Its public route metadata follows activation
  // on both anonymous and signed-in requests, so disabled plugins leave the host's original response in charge.
  // Until a full request has shown the plug-in enabled, the image endpoint leaves the host's response in charge too.
  const owned = !!storage && typeof storage === 'object';
  if (owned && typeof emdash?.getPublicPluginRouteMeta === 'function') activation.set(storage, emdash.getPublicPluginRouteMeta);
  const meta = typeof emdash?.getPublicPluginRouteMeta === 'function' ? emdash.getPublicPluginRouteMeta
    : owned ? activation.get(storage) : undefined;
  const enabled = typeof meta === 'function' && meta('rapier-media', 'available')?.public === true;
  const rendition = enabled ? await serveMedia({request, storage}) ?? await serveWidth({request, storage}) : null;
  if (rendition) return rendition;
  const response = await next(), url = new URL(request.url);
  const directWrite = request.method === 'POST' && url.pathname === '/_emdash/api/media' && response.status === 201 ||
    request.method === 'PUT' && REPLACE.test(url.pathname) && response.status === 200;
  if (enabled && directWrite) {
    const work = announceUpload(emdash?.hooks, response).catch(error => console.error('[rapier-jxl] upload', error));
    context.locals.cfContext?.waitUntil?.(work);
    return response;
  }
  if (!['GET', 'HEAD'].includes(request.method) || !mediaKey(url) && url.pathname !== '/_image') return response;
  // Both representations vary: a cached original must not hide a later negotiated rendition.
  const headers = new Headers(response.headers), vary = headers.get('vary');
  if (!vary?.split(',').some(value => ['*', 'accept'].includes(value.trim().toLowerCase())))
    headers.set('vary', vary ? vary + ', Accept' : 'Accept');
  return new Response(response.body, {status: response.status, statusText: response.statusText, headers});
}
