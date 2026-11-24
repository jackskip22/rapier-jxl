// SPDX-License-Identifier: MIT
// npx jpegxl add <apache|nginx|caddy> [folder] [--url https://site] [--dry-run] [--json]
// npx jpegxl remove <apache|nginx|caddy> [folder] [--dry-run] [--json]
import {readdir, realpath, rm, stat} from 'node:fs/promises';
import {extname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {createHash} from 'node:crypto';
import {atomicWrite, insideProject, readIfAny, refuseReadOnly, refuseLinks} from './project-files.mjs';
import {COMMAND} from './package-name.mjs';
import {cliError as fail, cliArgs} from './cli-error.mjs';

export const SERVER_PLACES = ['apache', 'nginx', 'caddy'];

// Uses \s* rather than literal spaces so Apache RewriteCond reads it as one pattern token, and avoids lookaheads so both
// PCRE (Apache, LiteSpeed, OpenLiteSpeed, nginx) and Go RE2 (Caddy) compile the same expression.
export const ACCEPT_JXL_PATTERN = '(?:^|,)\\s*image/jxl(?:\\s*;\\s*q=(?:1(?:\\.00?0?)?|0\\.(?:[1-9][0-9]?[0-9]?|0[1-9][0-9]?|00[1-9])))?\\s*(?:,|$)';

const BEGIN_MARKER = '# BEGIN jpegxl';
const END_MARKER = '# END jpegxl';
const IMAGE_EXT = /\.(?:jpe?g|png|webp|gif)$/i;
const JXL_CODESTREAM = [0xff, 0x0a];
const JXL_CONTAINER = [0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a];

const sha = text => createHash('sha256').update(text).digest('hex');
const setup = (message, fix) => fail('JXL_SETUP', message, fix);
const posix = path => path.split(sep).join('/');
const eolOf = text => typeof text === 'string' && text.includes('\r\n') ? '\r\n' : '\n';
const quoteShell = value => /[\s"'\\]/.test(value) ? `"${value.replace(/(["\\])/g, '\\$1')}"` : value;

const SERVERS = {
  apache: {
    file: '.htaccess',
    line: 'An Apache or LiteSpeed folder: .htaccess serves .jxl by Accept with Vary: Accept.',
    summary: 'Writes or updates .htaccess between # BEGIN jpegxl and # END jpegxl markers so Apache and LiteSpeed serve <file>.jxl when Accept lists image/jxl and send Vary: Accept for JPEG, PNG, WebP and GIF.',
  },
  nginx: {
    file: 'jpegxl.conf',
    line: 'An nginx site: jpegxl.conf serves .jxl by Accept with try_files and Vary: Accept.',
    summary: 'Writes jpegxl.conf to include inside a server block in nginx.conf. Never edits nginx configuration files directly.',
  },
  caddy: {
    file: 'jpegxl.caddy',
    line: 'A Caddy site: jpegxl.caddy serves .jxl by Accept with try_files and Vary: Accept.',
    summary: 'Writes jpegxl.caddy to import inside a site block in Caddyfile. Never edits Caddyfile directly.',
  },
};

export const serverLines = () => SERVER_PLACES.map(name => ({name, line: SERVERS[name].line}));

export function apacheBlock() {
  return [
    BEGIN_MARKER,
    '<IfModule mod_mime.c>',
    '  AddType image/jxl .jxl',
    '</IfModule>',
    '<IfModule mod_headers.c>',
    '  <FilesMatch "(?i)\\.(?:jpe?g|png|webp|gif|jxl)$">',
    '    Header append Vary Accept',
    '  </FilesMatch>',
    '</IfModule>',
    '<IfModule mod_rewrite.c>',
    '  RewriteEngine On',
    `  RewriteCond %{HTTP_ACCEPT} ${ACCEPT_JXL_PATTERN} [NC]`,
    '  RewriteCond "%{REQUEST_FILENAME}.jxl" -f',
    '  RewriteRule ^/?(.+\\.(?:jpe?g|png|webp|gif))$ "$1.jxl" [NC,T=image/jxl,E=Cache-Control:vary=%{ENV:LSCACHE_VARY_VALUE}+jxl,L]',
    '</IfModule>',
    END_MARKER,
  ].join('\n');
}

export function nginxBody() {
  return [
    '# Include inside a server { ... } block in nginx.conf.',
    '# Equivalent http {} map: map $http_accept $jxl_suffix { default ""; "~*' + ACCEPT_JXL_PATTERN + '" ".jxl"; }',
    'set $jxl_suffix "";',
    `if ($http_accept ~* "${ACCEPT_JXL_PATTERN}") {`,
    '  set $jxl_suffix ".jxl";',
    '}',
    '',
    'location ~* \\.jxl$ {',
    '  types { image/jxl jxl; }',
    '  default_type image/jxl;',
    '}',
    '',
    'location ~* \\.(?:jpe?g|png|webp|gif)$ {',
    '  types {',
    '    image/jxl jxl;',
    '    image/jpeg jpg jpeg;',
    '    image/png png;',
    '    image/webp webp;',
    '    image/gif gif;',
    '  }',
    '  add_header Vary Accept always;',
    '  try_files $uri$jxl_suffix $uri =404;',
    '}',
    '',
  ].join('\n');
}

export function caddyBody() {
  return [
    '# Import inside a site block in Caddyfile.',
    '@jxl_images path_regexp (?i)\\.(?:jpe?g|png|webp|gif)$',
    'header @jxl_images +Vary Accept',
    '',
    '@jxl_direct path_regexp (?i)\\.jxl$',
    'header @jxl_direct Content-Type image/jxl',
    '',
    '@jxl {',
    '  path_regexp (?i)\\.(?:jpe?g|png|webp|gif)$',
    `  header_regexp Accept (?i)${ACCEPT_JXL_PATTERN}`,
    '  file {path}.jxl',
    '}',
    'route @jxl {',
    '  header Content-Type image/jxl',
    '  try_files {path}.jxl {path}',
    '}',
    '',
  ].join('\n');
}

function stamped(place, body) {
  return `# npx ${COMMAND} add ${place} writes this snippet. Edit it freely. sha256:${sha(body)}\n` + body;
}

function snippetState(current, next) {
  if (current === null) return {state: 'created', write: true};
  const norm = current.replace(/\r\n/g, '\n');
  if (norm === next) return {state: 'unchanged', write: false};
  const [head, ...rest] = norm.split('\n');
  const mark = head.match(/sha256:([0-9a-f]{64})$/);
  if (!mark) return {state: 'left (already there)', write: false};
  return sha(rest.join('\n')) === mark[1]
    ? {state: 'updated', write: true}
    : {state: 'left (edited)', write: false};
}

function findMarkers(text) {
  const markers = [...text.matchAll(/^(# (?:BEGIN|END) jpegxl)[ \t]*(?:\r?\n|$)/gm)];
  if (!markers.length) return null;
  if (markers.length !== 2 || markers[0][1] !== BEGIN_MARKER || markers[1][1] !== END_MARKER)
    throw setup('.htaccess has unmatched # BEGIN jpegxl and # END jpegxl markers', 'fix the # BEGIN jpegxl block in .htaccess, then run again');
  const [begin, end] = markers;
  return {start: begin.index, end: end.index + end[0].length, body: text.slice(begin.index, end.index + end[0].length)};
}

const UNDO = /^# jpegxl undo: ([01]) ([0-9a-f]*)$/m;
function readUndo(body) {
  const normalized = body.replace(/\r\n/g, '\n'), rows = normalized.match(/^# jpegxl undo:.*$/gm) ?? [];
  if (!rows.length) return null;
  const undo = rows[0].match(UNDO);
  if (rows.length !== 1 || !undo || undo[2].length % 2 || !/^(?:\r?\n){0,2}$/.test(Buffer.from(undo[2], 'hex').toString()))
    throw setup('.htaccess undo marker is invalid', 'restore the jpegxl block before changing it');
  return undo;
}
function undoBlock(block, eol, missing, padding) {
  return block.replace(END_MARKER, `# jpegxl undo: ${missing ? 1 : 0} ${Buffer.from(padding).toString('hex')}\n${END_MARKER}`).replace(/\n/g, eol);
}

export function mergeHtaccess(existing) {
  const block = apacheBlock(), eol = eolOf(existing);
  const markers = existing === null ? null : findMarkers(existing);
  let text;
  if (!markers) {
    const before = existing ?? '';
    const newline = before.length && !before.endsWith('\n') ? eol : '';
    const padding = before.length ? newline + ((before + newline).endsWith(eol + eol) ? '' : eol) : '';
    text = before + padding + undoBlock(block, eol, existing === null, padding) + eol;
  } else {
    const undo = readUndo(markers.body);
    const padding = undo ? Buffer.from(undo[2], 'hex').toString() : '';
    const oldTail = markers.body.endsWith('\r\n') ? '\r\n' : markers.body.endsWith('\n') ? '\n' : '';
    const next = undoBlock(block, eol, undo?.[1] === '1', padding);
    text = existing.slice(0, markers.start) + next + oldTail + existing.slice(markers.end);
  }
  if (text === existing) return {action: 'unchanged', text: existing, block, write: false};
  return {action: existing === null ? 'created' : 'updated', text, block, write: true};
}

export function stripHtaccess(existing) {
  if (existing === null) return {found: false};
  const markers = findMarkers(existing);
  if (!markers) return {found: false};
  const undo = readUndo(markers.body);
  let before = existing.slice(0, markers.start), after = existing.slice(markers.end);
  if (undo) {
    const padding = Buffer.from(undo[2], 'hex').toString();
    if (!/^(?:\r?\n){0,2}$/.test(padding) || !before.endsWith(padding))
      throw setup('.htaccess undo marker does not match its separator', 'restore the jpegxl block before removing it');
    before = before.slice(0, before.length - padding.length);
  }
  const text = before + after;
  return {found: true, removeFile: undo?.[1] === '1' && text.length === 0, text};
}

function serverHelp(place) {
  return `Usage: ${COMMAND} add ${place} [folder] [--url <https://site>] [--dry-run] [--json]
       ${COMMAND} remove ${place} [folder] [--dry-run] [--json]

${SERVERS[place].line}
${SERVERS[place].summary}
Covers JPEG, PNG, WebP and GIF converted with npx ${COMMAND} <folder> --keep-extension.
Running add again changes nothing. Existing configuration lines and edits are kept.
Pass --url to send two requests to a converted image and check whether a CDN honors Vary: Accept.`;
}

function parseServerArgs(place, verb, rawArgs) {
  const args = cliArgs(rawArgs);
  if (args.length === 1 && ['--help', '-h'].includes(String(args[0]))) return {help: true};
  let dryRun = false, json = false, url, folder, positionalOnly = false;
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    if (!positionalOnly && arg === '--') { positionalOnly = true; continue; }
    if (!positionalOnly && arg === '--dry-run') { dryRun = true; continue; }
    if (!positionalOnly && arg === '--json') { json = true; continue; }
    if (!positionalOnly && arg === '--url' && verb === 'add') {
      const next = args[i + 1];
      if (next === undefined || String(next).startsWith('-'))
        throw fail('JXL_OPTIONS', '--url: missing site or image URL', `run: npx ${COMMAND} add ${place} --url https://example.com`);
      if (url !== undefined)
        throw fail('JXL_OPTIONS', '--url: given more than once', `run: npx ${COMMAND} add ${place} --url https://example.com`);
      url = String(args[++i]);
      continue;
    }
    if (!positionalOnly && arg.startsWith('--url=') && verb === 'add') {
      if (url !== undefined)
        throw fail('JXL_OPTIONS', '--url: given more than once', `run: npx ${COMMAND} add ${place} --url https://example.com`);
      url = arg.slice(6);
      if (!url) throw fail('JXL_OPTIONS', '--url: missing site or image URL', `run: npx ${COMMAND} add ${place} --url https://example.com`);
      continue;
    }
    if (!positionalOnly && arg.startsWith('-'))
      throw fail('JXL_OPTIONS', `${verb} ${place}: unknown option ${arg}`, `run: npx ${COMMAND} ${verb} ${place} --help`);
    if (folder !== undefined)
      throw fail('JXL_OPTIONS', `${verb} ${place}: one folder path at most`, `run: npx ${COMMAND} ${verb} ${place} [folder]`);
    folder = arg;
  }
  if (url !== undefined) {
    let parsed;
    try { parsed = new URL(url); } catch { parsed = null; }
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol))
      throw fail('JXL_OPTIONS', `--url "${url}": http or https URL required`, `run: npx ${COMMAND} add ${place} --url https://example.com`);
  }
  return {help: false, dryRun, json, url, folder};
}

async function resolveFolder(cwd, folder, place, verb) {
  const targetDir = folder !== undefined ? resolve(cwd, folder) : cwd;
  const shown = folder ?? '.';
  let info;
  try { info = await stat(targetDir); }
  catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR')
      throw fail('JXL_INPUT', `"${shown}": missing`, `create "${shown}" or pass an existing folder to npx ${COMMAND} ${verb} ${place}`);
    throw fail('JXL_IO', `"${shown}": could not inspect folder`, 'check folder permissions');
  }
  if (!info.isDirectory())
    throw fail('JXL_INPUT', `"${shown}": not a folder`, `pass a folder path to npx ${COMMAND} ${verb} ${place}`);
  return {targetDir, shown};
}

async function inspectImageFolder(targetDir) {
  const root = await realpath(targetDir);
  const files = new Set();
  const walk = async dir => {
    let entries;
    try { entries = await readdir(dir, {withFileTypes: true}); } catch { return; }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.add(posix(relative(root, full)));
    }
  };
  await walk(root);
  const jxlFiles = [], sourceImages = [], convertedImages = [];
  for (const rel of [...files].sort()) {
    if (extname(rel).toLowerCase() === '.jxl') jxlFiles.push(rel);
    else if (IMAGE_EXT.test(rel)) {
      sourceImages.push(rel);
      if (files.has(rel + '.jxl')) convertedImages.push(rel);
    }
  }
  return {hasJxl: jxlFiles.length > 0, jxlCount: jxlFiles.length, sourceImages, convertedImages};
}

export function isJxlBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 2) return false;
  if (bytes[0] === JXL_CODESTREAM[0] && bytes[1] === JXL_CODESTREAM[1]) return true;
  if (bytes.length < JXL_CONTAINER.length) return false;
  return JXL_CONTAINER.every((b, i) => bytes[i] === b);
}

function variesOnAccept(varyHeader) {
  if (!varyHeader) return false;
  return varyHeader.split(',').some(part => {
    const token = part.trim().toLowerCase();
    return token === 'accept' || token === '*';
  });
}

function detectCdn(headers) {
  const get = name => headers.get(name) ?? '';
  const has = name => headers.has(name);
  const server = get('server'), via = get('via'), xCache = get('x-cache');
  if (has('cf-ray') || has('cf-cache-status') || /\bcloudflare\b/i.test(server))
    return {provider: 'Cloudflare', cacheStatus: get('cf-cache-status') || null};
  if (has('x-amz-cf-id') || has('x-amz-cf-pop') || /\bcloudfront\b/i.test(via) || /\bcloudfront\b/i.test(xCache))
    return {provider: 'Amazon CloudFront', cacheStatus: xCache || null};
  if (has('x-nf-request-id') || /\bnetlify\b/i.test(server))
    return {provider: 'Netlify', cacheStatus: get('cache-status') || xCache || null};
  if (has('x-vercel-id') || has('x-vercel-cache') || /\bvercel\b/i.test(server))
    return {provider: 'Vercel', cacheStatus: get('x-vercel-cache') || null};
  if (has('cdn-pullzone') || has('cdn-requestid') || /\bbunnycdn\b/i.test(server))
    return {provider: 'Bunny CDN', cacheStatus: get('cdn-cache') || xCache || null};
  if (has('x-fastly-request-id') || (has('x-served-by') && /\bcache-/i.test(get('x-served-by'))))
    return {provider: 'Fastly', cacheStatus: xCache || null};
  if (has('akamai-grn') || has('x-akamai-transformed') || has('x-true-cache-key') || /\bakamai/i.test(server))
    return {provider: 'Akamai', cacheStatus: xCache || get('x-cache-remote') || null};
  if (has('x-edge-location') || /\bkeycdn\b/i.test(server))
    return {provider: 'KeyCDN', cacheStatus: xCache || null};
  const generic = get('cdn-cache-status') || get('cache-status') || xCache || get('x-cache-status') || get('x-proxy-cache');
  if (generic || has('age')) return {provider: 'CDN cache', cacheStatus: generic || (has('age') ? `age=${get('age')}` : null)};
  return {provider: null, cacheStatus: null};
}

function cdnRemedy(provider) {
  if (provider === 'Cloudflare')
    return `run npx ${COMMAND} add workers to serve JPEG XL from a Cloudflare Worker, or turn on Vary for images in Cloudflare Cache settings.`;
  if (provider === 'Netlify')
    return `run npx ${COMMAND} add netlify, or configure Vary: Accept for images on Netlify.`;
  if (provider === 'Amazon CloudFront')
    return `forward the Accept header in your CloudFront cache policy, or use npx ${COMMAND} add workers on Cloudflare.`;
  if (provider === 'Bunny CDN')
    return `enable Vary Cache on the Accept header in Bunny CDN settings, or use npx ${COMMAND} add workers on Cloudflare.`;
  if (provider)
    return `configure ${provider} to key cached images by the Accept header, or use npx ${COMMAND} add workers on Cloudflare.`;
  return `make sure your server or cache honors Vary: Accept and serves .jxl only when Accept lists image/jxl. On Cloudflare, run npx ${COMMAND} add workers or enable Vary for images.`;
}

function resolveProbeUrl(rawUrl, {shown, convertedImages}) {
  const parsed = new URL(rawUrl);
  if (IMAGE_EXT.test(parsed.pathname)) return parsed.href;
  if (!convertedImages.length)
    throw setup('--url needs a converted image in the folder or a direct image URL',
      `run npx ${COMMAND} ${quoteShell(shown)} --keep-extension first, or pass https://example.com/photo.jpg to --url`);
  const encodedRel = convertedImages[0].split('/').map(encodeURIComponent).join('/');
  parsed.pathname = (parsed.pathname.endsWith('/') ? parsed.pathname : parsed.pathname + '/') + encodedRel;
  return parsed.href;
}

export async function checkServerUrl(targetUrl, {fetchImpl = globalThis.fetch} = {}) {
  const probe = async accept => {
    let res;
    try {
      res = await fetchImpl(targetUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: {accept},
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      throw fail('JXL_IO', `--url "${targetUrl}": request failed (${error?.cause?.code ?? error?.message ?? 'network error'})`,
        'check that the site is running and reachable');
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') ?? '';
    const vary = res.headers.get('vary') ?? '';
    const cdn = detectCdn(res.headers);
    const isJxl = isJxlBytes(bytes) || /\bimage\/jxl\b/i.test(contentType);
    return {status: res.status, contentType, vary, varies: variesOnAccept(vary), bytesLength: bytes.length, isJxl, ...cdn};
  };

  const withJxl = await probe('image/jxl,*/*');
  const withoutJxl = await probe('image/avif,image/webp,image/apng,image/png,image/jpeg,*/*;q=0.8');
  const provider = withJxl.provider ?? withoutJxl.provider;
  const cacheStatus = withoutJxl.cacheStatus ?? withJxl.cacheStatus;
  const who = provider ?? 'The server';
  const fix = cdnRemedy(provider);

  let warning = null;
  if (withJxl.status >= 300 && withJxl.status < 400 || withoutJxl.status >= 300 && withoutJxl.status < 400) {
    warning = `${who} redirected ${targetUrl} (HTTP ${withJxl.status}). Pass the final image URL so only two requests are needed.`;
  } else if (withJxl.status !== 200 || withoutJxl.status !== 200) {
    warning = `${who} answered HTTP ${withJxl.status} and ${withoutJxl.status} for ${targetUrl}.`;
  } else if (withoutJxl.isJxl) {
    warning = `${who} served JPEG XL (${withoutJxl.contentType || 'image/jxl'}) to a browser without image/jxl in Accept. Its cache ignores Vary: Accept.`;
  } else if (!withJxl.isJxl) {
    warning = provider
      ? `${who} did not serve JPEG XL when Accept listed image/jxl${cacheStatus ? ` (cache: ${cacheStatus})` : ''}. It may be serving a cached original without varying on Accept.`
      : `${targetUrl} did not serve a .jxl file when Accept listed image/jxl (received ${withJxl.contentType || 'non-JXL bytes'}).`;
  } else if (!withJxl.varies || !withoutJxl.varies) {
    warning = `${who} did not send Vary: Accept on ${targetUrl}, so caches can hand a .jxl file to browsers without JPEG XL.`;
  }

  return {
    checked: true,
    url: targetUrl,
    ok: warning === null,
    provider,
    cacheStatus,
    jxlServed: withJxl.isJxl,
    fallbackServed: withoutJxl.status === 200 && !withoutJxl.isJxl,
    varyAccept: withJxl.varies && withoutJxl.varies,
    warning,
    fix: warning ? fix : null,
  };
}

export async function runAddServer(place, rawArgs, {cwd, stdout, fetchImpl}) {
  if (!Object.hasOwn(SERVERS, place))
    throw fail('JXL_OPTIONS', `unknown server: "${place}"`, `run: npx ${COMMAND} add apache | nginx | caddy`);
  const parsed = parseServerArgs(place, 'add', rawArgs);
  if (parsed.help) { await stdout(serverHelp(place)); return; }
  const {dryRun, json, url, folder} = parsed;
  const {targetDir, shown} = await resolveFolder(cwd, folder, place, 'add');
  const spec = SERVERS[place];
  await refuseLinks(targetDir, [spec.file], setup);
  const [land] = await insideProject(targetDir, [spec.file], setup);
  const displayFile = posix(relative(cwd, join(targetDir, spec.file))) || spec.file;
  const folderScan = await inspectImageFolder(targetDir);
  const probeUrl = url !== undefined ? resolveProbeUrl(url, {shown, convertedImages: folderScan.convertedImages}) : null;

  let action, textToWrite, previewText, write = false;
  if (place === 'apache') {
    const existing = await readIfAny(land, 'utf8', displayFile);
    const merged = mergeHtaccess(existing);
    action = merged.action;
    textToWrite = merged.text;
    previewText = merged.text;
    write = merged.write;
  } else {
    const existing = await readIfAny(land, 'utf8', displayFile);
    const full = stamped(place, place === 'nginx' ? nginxBody() : caddyBody());
    const status = snippetState(existing, full);
    action = status.state;
    textToWrite = full;
    previewText = full;
    write = status.write;
  }

  if (write) await refuseReadOnly(land, displayFile);
  if (write && !dryRun) await atomicWrite(land, textToWrite);

  const next = [];
  if (!folderScan.hasJxl)
    next.push(`run npx ${COMMAND} ${quoteShell(shown)} --keep-extension to write a .jxl beside each JPEG, PNG, WebP and GIF`);

  const snippetAbs = join(targetDir, spec.file);
  if (place === 'apache') {
    next.push('Apache needs AllowOverride FileInfo on this folder. OpenLiteSpeed reloads .htaccess with lswsctrl restart');
  } else if (place === 'nginx') {
    next.push(`add inside your server { ... } block in nginx.conf: include ${quoteShell(snippetAbs)};`);
    next.push('reload nginx: sudo nginx -t && sudo nginx -s reload');
  } else if (place === 'caddy') {
    next.push(`add inside your site block in Caddyfile: import ${quoteShell(snippetAbs)}`);
    next.push('reload Caddy: caddy reload --config /etc/caddy/Caddyfile');
  }

  const folderFlag = folder !== undefined ? ` ${quoteShell(folder)}` : '';
  const cdnNote = `when the site is behind Cloudflare or another CDN, check Vary: Accept with npx ${COMMAND} add ${place}${folderFlag} --url https://example.com`;
  const cdn = probeUrl ? await checkServerUrl(probeUrl, {fetchImpl}) : {checked: false, note: cdnNote};

  const changes = [{file: displayFile, action}];
  if (json) {
    await stdout(JSON.stringify({
      type: 'add',
      place,
      folder: shown,
      dryRun,
      changes,
      ...(dryRun && {wouldWrite: write ? previewText : null}),
      next,
      cdn,
    }));
    return;
  }

  for (const c of changes)
    await stdout(`${c.file}: ${dryRun && (c.action === 'created' || c.action === 'updated') ? 'would be ' : ''}${c.action}`);
  if (dryRun && write) await stdout(previewText.trimEnd());
  for (const line of next) await stdout(`next: ${line}`);
  if (!cdn.checked) await stdout(`cdn: ${cdn.note}`);
  else if (cdn.ok) await stdout(`url: ${cdn.url} honors Vary: Accept`);
  else {
    await stdout(`warning: ${cdn.warning}`);
    await stdout(`fix: ${cdn.fix}`);
  }
}

export async function runRemoveServer(place, rawArgs, {cwd, stdout}) {
  if (!Object.hasOwn(SERVERS, place))
    throw fail('JXL_OPTIONS', `unknown server: "${place}"`, `run: npx ${COMMAND} remove apache | nginx | caddy`);
  const parsed = parseServerArgs(place, 'remove', rawArgs);
  if (parsed.help) { await stdout(serverHelp(place)); return; }
  const {dryRun, json, folder} = parsed;
  const {targetDir, shown} = await resolveFolder(cwd, folder, place, 'remove');
  const spec = SERVERS[place];
  await refuseLinks(targetDir, [spec.file], setup);
  const [land] = await insideProject(targetDir, [spec.file], setup);
  const displayFile = posix(relative(cwd, join(targetDir, spec.file))) || spec.file;
  const existing = await readIfAny(land, 'utf8', displayFile);

  let action;
  if (place === 'apache') {
    const stripped = stripHtaccess(existing);
    if (!stripped.found)
      throw setup(`${place}: no # BEGIN jpegxl block in ${displayFile}`, 'nothing to remove');
    await refuseReadOnly(land, displayFile);
    if (stripped.removeFile) {
      action = 'removed';
      if (!dryRun) await rm(land, {force: true});
    } else {
      action = 'updated';
      if (!dryRun) await atomicWrite(land, stripped.text);
    }
  } else {
    if (existing === null)
      throw setup(`${place}: ${displayFile} not found`, 'nothing to remove');
    const norm = existing.replace(/\r\n/g, '\n');
    const [head, ...rest] = norm.split('\n');
    const mark = head.match(/sha256:([0-9a-f]{64})$/);
    if (!mark)
      throw setup(`${displayFile} was not written by add ${place}`, `delete ${displayFile} by hand if you no longer want it`);
    if (sha(rest.join('\n')) !== mark[1]) {
      action = 'left (edited)';
    } else {
      await refuseReadOnly(land, displayFile);
      action = 'removed';
      if (!dryRun) await rm(land, {force: true});
    }
  }

  const changes = [{file: displayFile, action}];
  if (json) {
    await stdout(JSON.stringify({type: 'remove', place, folder: shown, dryRun, changes}));
    return;
  }
  for (const c of changes)
    await stdout(`${c.file}: ${dryRun && (c.action === 'removed' || c.action === 'updated') ? 'would be ' : ''}${c.action}`);
}
