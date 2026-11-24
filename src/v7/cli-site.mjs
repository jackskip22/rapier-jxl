// SPDX-License-Identifier: MIT
import {readFile, readdir, stat, lstat, realpath, open} from 'node:fs/promises';
import {basename, dirname, extname, join, relative, resolve, sep} from 'node:path';
import {atomicWrite, insideProject, refuseReadOnly} from './project-files.mjs';
import {COMMAND} from './package-name.mjs';
import {cliError, cliArgs} from './cli-error.mjs';

export const SITE_HELP = `Usage: ${COMMAND} site <folder> [--dry-run] [--json] [options]

Prepare a static site folder for GitHub Pages, S3 or any static host with no server config.
Converts images in <folder> with --keep-extension and rewrites each HTML file's <img> (with its srcset and sizes)
to <picture> with <source type="image/jxl">, only where every candidate has its .jxl.
Leaves an existing <picture> that already has a JPEG XL source alone, never touches <script>, <template>, comments
or attribute text, and a second run changes nothing.

Options:
      --dry-run            List what would change without writing files
      --json               Emit one JSON summary object
  -q, --quality <1-100>    Target quality (default 90, and a JPEG without it stays exact)
  -e, --effort <1-10>      Encoding effort, 1 fastest, 10 slowest (default: 7)
      --max-bytes <size>   Fit output under byte budget (e.g. 80KB, 1.5MB)
      --exact              Every pixel kept (default for JPEG)
      --jpeg-pixels        Re-encode JPEG pixels, retaining no JPEG reconstruction
  -j, --jobs <count>       Nonnegative helper count (default: 0)
      --verify             Verify each output before writing it
  -h, --help               Show this help
`;

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.hdr', '.exr']);
const HTML_EXTENSIONS = new Set(['.html', '.htm']);
const RAW_TEXT_TAGS = new Set(['style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript']);
const USED_ATTRIBUTES = new Set(['src', 'srcset', 'sizes', 'type', 'media', 'href', 'charset', 'http-equiv', 'content']);
const VALUE_FLAGS = new Set(['-q', '--quality', '-e', '--effort', '--max-bytes', '-j', '--jobs']);
const BOOL_FLAGS = new Set(['--exact', '--jpeg-pixels', '--verify', '--keep-extension']);

const isAsciiAlpha = ch => (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
const isHtmlSpace = ch => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
const isTagEndBoundary = ch => ch === undefined || isHtmlSpace(ch) || ch === '/' || ch === '>';
const posixRel = (root, full) => relative(root, full).split(sep).join('/');

function isJxlSignature(bytes) {
  if (!bytes || bytes.length < 2) return false;
  if (bytes[0] === 0xff && bytes[1] === 0x0a) return true;
  return bytes.length >= 12 &&
    bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x00 && bytes[3] === 0x0c &&
    bytes[4] === 0x4a && bytes[5] === 0x58 && bytes[6] === 0x4c && bytes[7] === 0x20 &&
    bytes[8] === 0x0d && bytes[9] === 0x0a && bytes[10] === 0x87 && bytes[11] === 0x0a;
}

function canDryRunConvert(bytes) {
  if (!bytes || bytes.length < 4) return false;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return true;
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 &&
      (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return true;
  if (bytes[0] === 0x76 && bytes[1] === 0x2f && bytes[2] === 0x31 && bytes[3] === 0x01) return true;
  const head = Buffer.from(bytes.subarray(0, 16)).toString('latin1');
  if (head.startsWith('#?RADIANCE') || head.startsWith('#?RGBE')) return true;
  const hasRuntimeDecoder = typeof globalThis.createImageBitmap === 'function' && typeof globalThis.OffscreenCanvas === 'function';
  if (hasRuntimeDecoder) {
    if (bytes.length >= 12 && head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return true;
    if (bytes.length >= 12 && head.slice(4, 8) === 'ftyp' && /^avif|avis|mif1$/i.test(head.slice(8, 12))) return true;
  }
  return false;
}

async function readMagic(filePath, count = 32) {
  let fh;
  try {
    fh = await open(filePath, 'r');
    const buf = new Uint8Array(count);
    const {bytesRead} = await fh.read(buf, 0, count, 0);
    return buf.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

export function decodeHtmlEntities(str) {
  if (!str || !str.includes('&')) return str;
  for (let i = str.indexOf('&'); i >= 0; i = str.indexOf('&', i + 1)) {
    const rest = str.slice(i);
    if (/^&(?:#[xX][0-9a-fA-F]+|#\d+|amp|AMP|lt|LT|gt|GT|quot|QUOT|apos);/.test(rest)) continue;
    const name = /^&([a-zA-Z][a-zA-Z0-9]*)/.exec(rest);
    if (rest[1] === '#' || name && rest[name[0].length] !== '=') return null;
  }
  let unknown = false;
  const decoded = str.replace(/&(?:#[xX]([0-9a-fA-F]+)|#(\d+)|(amp|AMP|lt|LT|gt|GT|quot|QUOT|apos));/g, (full, hex, dec, named) => {
    if (named) {
      const lower = named.toLowerCase();
      if (lower === 'amp') return '&';
      if (lower === 'lt') return '<';
      if (lower === 'gt') return '>';
      if (lower === 'quot') return '"';
      if (lower === 'apos') return "'";
      return full;
    }
    const cp = hex !== undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (!Number.isSafeInteger(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) || (cp >= 0x80 && cp <= 0x9f)) {
      unknown = true;
      return full;
    }
    return String.fromCodePoint(cp);
  });
  return unknown ? null : decoded;
}

function escapeHtmlAttr(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function parseSrcset(input) {
  if (typeof input !== 'string') return null;
  const len = input.length, out = [];
  let i = 0;
  while (i < len) {
    while (i < len && (isHtmlSpace(input[i]) || input[i] === ',')) i++;
    if (i >= len) break;
    const urlStart = i;
    while (i < len && !isHtmlSpace(input[i])) i++;
    let url = input.slice(urlStart, i);
    let trailingCommas = 0;
    while (url.endsWith(',')) { url = url.slice(0, -1); trailingCommas++; }
    if (!url || trailingCommas > 1) return null;
    let descriptor = '';
    if (trailingCommas === 0) {
      while (i < len && isHtmlSpace(input[i])) i++;
      const descStart = i;
      let inParens = false;
      while (i < len) {
        const ch = input[i];
        if (inParens) {
          if (ch === ')') inParens = false;
          i++;
        } else if (ch === '(') {
          inParens = true;
          i++;
        } else if (ch === ',') {
          i++;
          break;
        } else {
          i++;
        }
      }
      descriptor = input.slice(descStart, input[i - 1] === ',' ? i - 1 : i).trim().replace(/\s+/g, ' ');
    }
    out.push({url, descriptor});
  }
  return out.length ? out : null;
}

function parseStartTag(html, start) {
  const len = html.length;
  let i = start + 1;
  if (i >= len || !isAsciiAlpha(html[i])) return null;
  while (i < len && !isHtmlSpace(html[i]) && html[i] !== '/' && html[i] !== '>') i++;
  const name = html.slice(start + 1, i).toLowerCase();
  const attrs = new Map();
  let selfClosing = false;

  while (i < len) {
    while (i < len && isHtmlSpace(html[i])) i++;
    if (i >= len) return null;
    if (html[i] === '>') return {name, attrs, selfClosing, end: i + 1};
    if (html[i] === '/') {
      selfClosing = true;
      i++;
      if (i < len && html[i] === '>') return {name, attrs, selfClosing: true, end: i + 1};
      selfClosing = false;
      continue;
    }
    const attrStart = i;
    while (i < len && !isHtmlSpace(html[i]) && html[i] !== '=' && html[i] !== '/' && html[i] !== '>') i++;
    const attrName = html.slice(attrStart, i).toLowerCase();
    while (i < len && isHtmlSpace(html[i])) i++;
    let attrVal = '';
    if (i < len && html[i] === '=') {
      i++;
      while (i < len && isHtmlSpace(html[i])) i++;
      if (i >= len) return null;
      if (html[i] === '"' || html[i] === "'") {
        const quote = html[i++];
        const valStart = i;
        const closeIdx = html.indexOf(quote, i);
        if (closeIdx < 0) return null;
        attrVal = html.slice(valStart, closeIdx);
        i = closeIdx + 1;
      } else {
        const valStart = i;
        while (i < len && !isHtmlSpace(html[i]) && html[i] !== '>') i++;
        attrVal = html.slice(valStart, i);
      }
    }
    if (attrName && !attrs.has(attrName)) attrs.set(attrName, decodeHtmlEntities(attrVal));
  }
  return null;
}

function parseEndTag(html, start) {
  const len = html.length;
  let i = start + 2;
  if (i >= len) return null;
  if (html[i] === '>') return {name: '', end: i + 1};
  if (!isAsciiAlpha(html[i])) {
    const gt = html.indexOf('>', i);
    return gt < 0 ? null : {name: '', end: gt + 1};
  }
  const nameStart = i;
  while (i < len && !isHtmlSpace(html[i]) && html[i] !== '/' && html[i] !== '>') i++;
  const name = html.slice(nameStart, i).toLowerCase();
  let quote = '';
  while (i < len) {
    const ch = html[i++];
    if (quote) { if (ch === quote) quote = ''; }
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return {name, end: i};
  }
  return null;
}

function scanScriptEnd(html, from) {
  const len = html.length;
  let i = from, escaped = false, doubleEscaped = false;
  while (i < len) {
    if (!escaped && html.startsWith('<!--', i)) {
      escaped = true;
      i += 4;
      continue;
    }
    if (escaped && html.startsWith('-->', i)) {
      escaped = false;
      doubleEscaped = false;
      i += 3;
      continue;
    }
    if (escaped && !doubleEscaped && html[i] === '<' && html.slice(i + 1, i + 7).toLowerCase() === 'script' && isTagEndBoundary(html[i + 7])) {
      doubleEscaped = true;
      i += 7;
      continue;
    }
    if (html[i] === '<' && html[i + 1] === '/' && html.slice(i + 2, i + 8).toLowerCase() === 'script' && isTagEndBoundary(html[i + 8])) {
      if (doubleEscaped) {
        doubleEscaped = false;
        i += 8;
        continue;
      }
      const endTag = parseEndTag(html, i);
      return endTag ? endTag.end : null;
    }
    i++;
  }
  return null;
}

function scanRawTextEnd(html, from, tagName) {
  const len = html.length, tagLen = tagName.length;
  let i = from;
  while (i < len) {
    if (html[i] === '<' && html[i + 1] === '/' &&
        html.slice(i + 2, i + 2 + tagLen).toLowerCase() === tagName &&
        isTagEndBoundary(html[i + 2 + tagLen])) {
      const endTag = parseEndTag(html, i);
      return endTag ? endTag.end : null;
    }
    i++;
  }
  return null;
}

function mapCandidateUrl(rawUrl, htmlDir, siteRootReal, hasJxl) {
  const trimmed = String(rawUrl ?? '').replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '');
  if (!trimmed) return null;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(trimmed)) return null;
  let splitIdx = trimmed.length;
  const qIdx = trimmed.indexOf('?'), hIdx = trimmed.indexOf('#');
  if (qIdx >= 0 && qIdx < splitIdx) splitIdx = qIdx;
  if (hIdx >= 0 && hIdx < splitIdx) splitIdx = hIdx;
  const rawPath = trimmed.slice(0, splitIdx), suffix = trimmed.slice(splitIdx);
  if (!rawPath) return null;
  let decoded;
  try { decoded = decodeURIComponent(rawPath); } catch { return null; }
  if (!decoded || decoded.includes('\0') || decoded.includes('\\')) return null;
  const resolved = decoded.startsWith('/')
    ? resolve(siteRootReal, '.' + decoded)
    : resolve(htmlDir, decoded);
  if (resolved === siteRootReal || !resolved.startsWith(siteRootReal + sep)) return null;
  if (!hasJxl(resolved + '.jxl')) return null;
  return (rawPath + '.jxl' + suffix).replaceAll(' ', '%20').replace(/,+$/, commas => '%2C'.repeat(commas.length));
}

function buildJxlSourceTag(attrs, htmlDir, siteRootReal, hasJxl) {
  const hasSrc = attrs.has('src'), hasSrcset = attrs.has('srcset');
  if (!hasSrc && !hasSrcset) return null;

  let mappedSrc = null;
  if (hasSrc) {
    mappedSrc = mapCandidateUrl(attrs.get('src'), htmlDir, siteRootReal, hasJxl);
    if (!mappedSrc) return null;
  }

  let jxlSrcset = '';
  if (hasSrcset) {
    const parsed = parseSrcset(attrs.get('srcset'));
    if (!parsed) return null;
    const mappedParts = [];
    for (const entry of parsed) {
      const mapped = mapCandidateUrl(entry.url, htmlDir, siteRootReal, hasJxl);
      if (!mapped) return null;
      mappedParts.push(entry.descriptor ? `${mapped} ${entry.descriptor}` : mapped);
    }
    jxlSrcset = mappedParts.join(', ');
  } else {
    jxlSrcset = mappedSrc;
  }
  if (!jxlSrcset) return null;

  const sizes = attrs.get('sizes');
  const sizesAttr = sizes !== undefined && sizes !== '' ? ` sizes="${escapeHtmlAttr(sizes)}"` : '';
  return `<source type="image/jxl" srcset="${escapeHtmlAttr(jxlSrcset)}"${sizesAttr}>`;
}

export function rewriteHtmlDocument(html, {htmlDir, siteRootReal, hasJxl}) {
  if (html.includes('\0')) return {html, count: 0};
  const edits = [];
  const len = html.length;
  let i = 0, templateDepth = 0, svgDepth = 0, foreignObjectDepth = 0;
  const pictureStack = [];

  while (i < len) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    i = lt;

    if (html.startsWith('<!--', i)) {
      if (html.startsWith('<!-->', i)) { i += 5; continue; }
      if (html.startsWith('<!--->', i)) { i += 6; continue; }
      const end = html.indexOf('-->', i + 4);
      if (end < 0) return {html, count: 0};
      i = end + 3;
      continue;
    }
    if (html.startsWith('<![CDATA[', i)) {
      const end = html.indexOf(']]>', i + 9);
      if (end < 0) return {html, count: 0};
      i = end + 3;
      continue;
    }
    if (html[i + 1] === '!' || html[i + 1] === '?') {
      const end = html.indexOf('>', i + 2);
      if (end < 0) return {html, count: 0};
      i = end + 1;
      continue;
    }
    if (html[i + 1] === '/') {
      const endTag = parseEndTag(html, i);
      if (!endTag) return {html, count: 0};
      const name = endTag.name;
      if (name === 'template') {
        if (templateDepth > 0) templateDepth--;
      } else if (templateDepth === 0) {
        if (name === 'foreignobject' && svgDepth > 0 && foreignObjectDepth > 0) foreignObjectDepth--;
        else if (name === 'svg' && svgDepth > 0) svgDepth--;
        else if (name === 'picture' && (svgDepth === 0 || foreignObjectDepth > 0) && pictureStack.length > 0) {
          const scope = pictureStack.pop();
          if (!scope.hasJxlSource && !scope.hasMediaSource && !scope.nested && scope.imgs.length === 1) {
            const img = scope.imgs[0];
            const sourceTag = buildJxlSourceTag(img.attrs, htmlDir, siteRootReal, hasJxl);
            if (sourceTag) {
              const at = scope.firstChildStart ?? img.start;
              edits.push({from: at, to: at, text: sourceTag});
            }
          }
        }
      }
      i = endTag.end;
      continue;
    }
    if (isAsciiAlpha(html[i + 1])) {
      const tag = parseStartTag(html, i);
      if (!tag) return {html, count: 0};
      const {name, attrs, selfClosing, end} = tag;
      for (const attr of USED_ATTRIBUTES) if (attrs.has(attr) && attrs.get(attr) === null) return {html, count: 0};
      if (name === 'base' && attrs.has('href')) return {html, count: 0};
      if (name === 'meta') {
        const charset = attrs.get('charset') ?? ((attrs.get('http-equiv') ?? '').trim().toLowerCase() === 'content-type'
          ? /(?:^|;)\s*charset\s*=\s*["']?([^\s"';]+)/i.exec(attrs.get('content') ?? '')?.[1] : undefined);
        if (charset !== undefined) {
          try { if (new TextDecoder(charset).encoding !== 'utf-8') return {html, count: 0}; }
          catch { return {html, count: 0}; }
        }
      }
      if (name === 'script') {
        i = scanScriptEnd(html, end);
        if (i === null) return {html, count: 0};
        continue;
      }
      if (RAW_TEXT_TAGS.has(name)) {
        i = scanRawTextEnd(html, end, name);
        if (i === null) return {html, count: 0};
        continue;
      }
      if (name === 'plaintext') break;
      if (name === 'template') {
        templateDepth++;
        i = end;
        continue;
      }
      if (templateDepth === 0) {
        if (name === 'svg') {
          if (!selfClosing) svgDepth++;
          i = end;
          continue;
        }
        if (name === 'foreignobject' && svgDepth > 0) {
          if (!selfClosing) foreignObjectDepth++;
          i = end;
          continue;
        }
        if (svgDepth === 0 || foreignObjectDepth > 0) {
          if (name === 'picture') {
            if (pictureStack.length > 0) pictureStack.at(-1).nested = true;
            pictureStack.push({
              hasJxlSource: false,
              hasMediaSource: false,
              nested: pictureStack.length > 0,
              firstChildStart: null,
              imgs: [],
            });
          } else if (name === 'source' && pictureStack.length > 0) {
            const scope = pictureStack.at(-1);
            scope.firstChildStart ??= i;
            const rawType = (attrs.get('type') ?? '').split(';', 1)[0].trim().toLowerCase();
            if (rawType === 'image/jxl') scope.hasJxlSource = true;
            if (attrs.has('media') && (attrs.get('media') ?? '').trim() !== '') scope.hasMediaSource = true;
          } else if (name === 'img') {
            if (pictureStack.length > 0) {
              const scope = pictureStack.at(-1);
              scope.firstChildStart ??= i;
              scope.imgs.push({start: i, end, attrs});
            } else {
              const sourceTag = buildJxlSourceTag(attrs, htmlDir, siteRootReal, hasJxl);
              if (sourceTag) {
                const rawImg = html.slice(i, end);
                edits.push({from: i, to: end, text: `<picture>${sourceTag}${rawImg}</picture>`});
              }
            }
          }
        }
      }
      i = end;
      continue;
    }
    i++;
  }

  if (templateDepth || svgDepth || pictureStack.length || !edits.length) return {html, count: 0};
  edits.sort((a, b) => a.from - b.from);
  let out = '', cursor = 0;
  for (const edit of edits) {
    out += html.slice(cursor, edit.from) + edit.text;
    cursor = edit.to;
  }
  out += html.slice(cursor);
  return {html: out, count: edits.length};
}

function parseSiteArgs(argv) {
  argv = cliArgs(argv);
  let folder, dryRun = false, json = false, help = false, positionalOnly = false;
  const encodeFlags = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i]);
    if (!positionalOnly && arg === '--') { positionalOnly = true; continue; }
    if (!positionalOnly && (arg === '-h' || arg === '--help')) { help = true; continue; }
    if (!positionalOnly && arg === '--dry-run') { dryRun = true; continue; }
    if (!positionalOnly && arg === '--json') { json = true; continue; }
    if (!positionalOnly && (arg === '-o' || arg === '--out' || arg.startsWith('--out='))) {
      throw cliError('JXL_OPTIONS', 'site updates <folder> in place and does not take --out', `run: npx ${COMMAND} site <folder>`);
    }
    if (!positionalOnly && BOOL_FLAGS.has(arg)) {
      if (arg !== '--keep-extension') encodeFlags.push(arg);
      continue;
    }
    if (!positionalOnly && VALUE_FLAGS.has(arg)) {
      const next = argv[i + 1];
      if (next === undefined) throw cliError('JXL_OPTIONS', `missing value for ${arg}`, `run: npx ${COMMAND} site --help`);
      encodeFlags.push(arg, String(argv[++i]));
      continue;
    }
    if (!positionalOnly && arg.startsWith('-')) {
      const eq = arg.indexOf('=');
      if (eq > 0 && VALUE_FLAGS.has(arg.slice(0, eq))) {
        encodeFlags.push(arg.slice(0, eq), arg.slice(eq + 1));
        continue;
      }
      throw cliError('JXL_OPTIONS', `unknown option: ${arg}`, `run: npx ${COMMAND} site --help`);
    }
    if (folder !== undefined) throw cliError('JXL_OPTIONS', 'site takes one folder', `run: npx ${COMMAND} site <folder>`);
    folder = arg;
  }
  return {folder, dryRun, json, help, encodeFlags};
}

async function scanSiteTree(siteRootReal, currentDir = siteRootReal, acc = {images: [], jxls: [], htmls: []}) {
  const entries = (await readdir(currentDir, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = join(currentDir, entry.name);
    const linkInfo = await lstat(full).catch(() => null);
    if (!linkInfo) continue;
    if (linkInfo.isSymbolicLink()) {
      const targetInfo = await stat(full).catch(() => null);
      if (!targetInfo?.isFile()) continue;
      const real = await realpath(full).catch(() => null);
      if (!real || (real !== siteRootReal && !real.startsWith(siteRootReal + sep))) continue;
      const ext = extname(entry.name).toLowerCase();
      if (ext === '.jxl') acc.jxls.push(real);
      else if (IMAGE_EXTENSIONS.has(ext)) acc.images.push(real);
      else if (HTML_EXTENSIONS.has(ext)) acc.htmls.push(real);
      continue;
    }
    if (linkInfo.isDirectory()) {
      await scanSiteTree(siteRootReal, full, acc);
    } else if (linkInfo.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (ext === '.jxl') acc.jxls.push(full);
      else if (IMAGE_EXTENSIONS.has(ext)) acc.images.push(full);
      else if (HTML_EXTENSIONS.has(ext)) acc.htmls.push(full);
    }
  }
  return acc;
}

export async function runSite(argv, {cwd = process.cwd(), stdout, stderr, encodeImages, checkFlags} = {}) {
  const out = stdout ?? (line => process.stdout.write(line + '\n'));
  const err = stderr ?? (line => process.stderr.write(line + '\n'));
  const {folder, dryRun, json, help, encodeFlags} = parseSiteArgs(argv);
  if (help) return {help: true, exitCode: 0};
  if (!folder) throw cliError('JXL_OPTIONS', 'site: folder required', `run: npx ${COMMAND} site public/`);

  const resolvedFolder = resolve(cwd, folder);
  let folderStat;
  try { folderStat = await stat(resolvedFolder); }
  catch (cause) {
    if (cause?.code === 'ENOENT' || cause?.code === 'ENOTDIR')
      throw cliError('JXL_INPUT', `"${folder}": missing`, 'check: folder path');
    throw Object.assign(cliError('JXL_IO', `"${folder}": inspection failed`, 'check: path permissions'), {cause});
  }
  if (!folderStat.isDirectory()) throw cliError('JXL_INPUT', `"${folder}": not a folder`, `run: npx ${COMMAND} site public/`);

  const siteRootReal = await realpath(resolvedFolder);
  const tree = await scanSiteTree(siteRootReal);

  const validJxls = new Set();
  for (const jxlPath of tree.jxls) {
    const magic = await readMagic(jxlPath, 16);
    if (isJxlSignature(magic)) validJxls.add(jxlPath);
  }

  const imagesWritten = [], imagesSkipped = [];
  let failed = 0;

  const pendingImages = [];
  for (const imgPath of tree.images) {
    const siblingJxl = imgPath + '.jxl';
    if (validJxls.has(siblingJxl)) {
      imagesSkipped.push(posixRel(siteRootReal, siblingJxl));
    } else {
      pendingImages.push(imgPath);
    }
  }

  if (pendingImages.length > 0) {
    if (dryRun) {
      if (encodeFlags.length > 0) {
        if (!checkFlags) throw cliError('JXL_OPTIONS', 'site: encode options need the command line (npx jpegxl site)');
        checkFlags([pendingImages[0], '--keep-extension', ...encodeFlags]);
      }
      for (const imgPath of pendingImages) {
        const magic = await readMagic(imgPath, 32);
        if (canDryRunConvert(magic)) {
          const siblingJxl = imgPath + '.jxl';
          validJxls.add(siblingJxl);
          imagesWritten.push(posixRel(siteRootReal, siblingJxl));
        }
      }
    } else {
      if (!encodeImages) throw cliError('JXL_OPTIONS', 'site: converting needs the command line (npx jpegxl site)');
      const runEncode = encodeImages;
      const encoded = await runEncode(pendingImages, encodeFlags);
      for (const imgPath of pendingImages) {
        const siblingJxl = imgPath + '.jxl';
        const magic = await readMagic(siblingJxl, 16);
        if (isJxlSignature(magic)) {
          validJxls.add(siblingJxl);
          imagesWritten.push(posixRel(siteRootReal, siblingJxl));
        }
      }
      if (encoded.exitCode !== 0) {
        const firstErr = (encoded.lines ?? []).map(l => { try { return JSON.parse(l); } catch { return null; } })
          .find(r => r?.error)?.error;
        if (firstErr && imagesWritten.length === 0 && ['JXL_OPTIONS', 'JXL_SETUP'].includes(firstErr.code)) {
          throw cliError(firstErr.code, firstErr.message, firstErr.hint ?? `run: npx ${COMMAND} site --help`);
        }
        failed += Math.max(1, pendingImages.length - imagesWritten.length);
        if (!json && firstErr) await err(`${COMMAND}: ${firstErr.code}: ${firstErr.message}`);
      }
    }
  }

  const htmlUpdated = [];
  for (const htmlPath of tree.htmls) {
    const relHtml = posixRel(siteRootReal, htmlPath);
    await insideProject(siteRootReal, [relHtml], msg => cliError('JXL_SETUP', msg, 'keep HTML files inside the site folder'));
    const htmlBytes = await readFile(htmlPath);
    let rawHtml;
    try {
      rawHtml = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(htmlBytes);
      if (rawHtml.includes('\0')) throw new Error('NUL in HTML');
    } catch {
      throw cliError('JXL_INPUT', `${relHtml}: unsupported HTML encoding`, 'save this page as UTF-8 before running site');
    }
    const {html: nextHtml, count} = rewriteHtmlDocument(rawHtml, {
      htmlDir: dirname(htmlPath),
      siteRootReal,
      hasJxl: candidatePath => validJxls.has(candidatePath),
    });
    if (count > 0 && nextHtml !== rawHtml) {
      await refuseReadOnly(htmlPath, relHtml);
      if (!dryRun) await atomicWrite(htmlPath, nextHtml);
      htmlUpdated.push({file: relHtml, count});
    }
  }

  const displayFolder = relative(cwd, resolvedFolder) || '.';
  if (json) {
    await out(JSON.stringify({
      type: 'site',
      folder: displayFolder.split(sep).join('/'),
      dryRun,
      imagesWritten,
      imagesSkipped,
      htmlUpdated,
      failed,
    }));
  } else {
    for (const jxlRel of imagesWritten) {
      await out(`${dryRun ? 'would write' : 'wrote'}: ${jxlRel}`);
    }
    for (const {file, count} of htmlUpdated) {
      await out(`${dryRun ? 'would rewrite' : 'rewrote'}: ${file} (${count} <img>)`);
    }
    if (imagesWritten.length === 0 && htmlUpdated.length === 0 && failed === 0) {
      await out(dryRun ? 'nothing would change' : 'nothing changed');
    }
  }

  return {exitCode: failed ? 1 : 0, imagesWritten, imagesSkipped, htmlUpdated};
}
