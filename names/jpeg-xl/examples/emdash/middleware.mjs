import {serve} from 'jpeg-xl/serve';

const FILE = /^\/_emdash\/api\/media\/file\/([0-9A-HJKMNP-TV-Z]{26}(?:\.[0-9A-HJKMNP-TV-Z]{26})*\.(?:jpe?g|jpe|jfif|png|webp|avif))$/i;
const SANDBOX = "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'";
export const mediaKey = url => FILE.exec(new URL(url).pathname)?.[1] ?? null;

// Explicit support; honor exclusions.
export function acceptsJxl(value, alternative = 'image/webp') {
  const weights = new Map();
  const parts = String(value ?? '').match(/(?:[^,"]|"(?:\\.|[^"\\])*")+/g) ?? [];
  for (const part of parts) {
    const [type, ...parameters] = part.trim().toLowerCase().split(';').map(p => p.trim());
    if (!['image/jxl', alternative, 'image/*', '*/*'].includes(type)) continue;
    if (parameters.some(p => p && !/^q=(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(p))) continue;
    const weight = parameters.length ? Number(parameters.at(-1).slice(2)) : 1;
    weights.set(type, Math.max(weights.get(type) ?? 0, weight));
  }
  const other = weights.get(alternative) ?? weights.get('image/*') ?? weights.get('*/*') ?? 0;
  return (weights.get('image/jxl') ?? 0) > 0 && weights.get('image/jxl') >= other;
}
const secure = response => {
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('content-security-policy', SANDBOX);
  response.headers.set('content-disposition', 'inline');
  return response;
};
const requestForJxl = request => ({method: request.method,
  headers: {accept: 'image/jxl', 'if-none-match': request.headers.get('if-none-match') ?? ''}});

export async function serveMedia({request, storage}) {
  if (!['GET', 'HEAD'].includes(request.method) || typeof storage?.sidecar !== 'function') return null;
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
  if (url.pathname !== endpoint || !['GET', 'HEAD'].includes(request.method) || typeof storage?.variants !== 'function' ||
      !acceptsJxl(request.headers.get('accept'))) return null;
  if ([...url.searchParams.keys()].some(k => !['href', 'w', 'h', 'f', 'q'].includes(k)) ||
      ![null, 'webp'].includes(url.searchParams.get('f')) || ![null, '85'].includes(url.searchParams.get('q'))) return null;
  const href = url.searchParams.get('href'), width = Number(url.searchParams.get('w'));
  if (!href || !Number.isSafeInteger(width) || width < 1) return null;
  let source;
  try { source = new URL(href, url); } catch { return null; }
  if (source.origin !== url.origin) return null;
  const key = mediaKey(source);
  if (!key) return null;
  const file = (await storage.variants(key, {signal: request.signal})).find(v => v.width === width);
  if (!file) return null;
  const bytes = await storage.readVariant(file, {signal: request.signal});
  if (!bytes) return null;
  if (url.searchParams.has('h') && Number(url.searchParams.get('h')) !== file.result.height) return null;
  return secure(await serve(bytes, requestForJxl(request), {maxPixels: storage.maxPixels, signal: request.signal,
    ...(typeof file.sha256 === 'string' && {etag: file.sha256.slice(0, 32)})}));
}

// EmDash 1.4 fires media:afterUpload only after signed and plug-in uploads; its admin uploads to R2 bindings and local
// storage directly, so the plug-in's hook gets those uploads here, and no other plug-in's.
export async function announceUpload(hooks, response, id = 'rapier-media') {
  if (response.status !== 201 || typeof hooks?.getTypedHooks !== 'function' || typeof hooks.getContext !== 'function') return;
  const item = (await response.clone().json().catch(() => null))?.data?.item;
  if (!item?.id || typeof item.url !== 'string') return;
  const media = {id: item.id, filename: item.filename, mimeType: item.mimeType, size: item.size, url: item.url, createdAt: item.createdAt};
  for (const hook of hooks.getTypedHooks('media:afterUpload').filter(hook => hook.pluginId === id))
    await hook.handler({media}, hooks.getContext(id));
}

// EmDash 1.4 answers its image endpoint without its runtime: there locals.emdash is the storage alone, with no route
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
  if (enabled && request.method === 'POST' && url.pathname === '/_emdash/api/media') {
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
