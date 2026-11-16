// SPDX-License-Identifier: MIT
import * as nodeModule from 'node:module';
import acorn from '../vendor/acorn.mjs';

export function parseConfig(source) {
  const options = {sourceType: 'module', ecmaVersion: 'latest'};
  const input = source.startsWith('\ufeff#!') ? '//!' + source.slice(3) : source;
  try { return acorn.parse(input, options); }
  catch (cause) {
    const {stripTypeScriptTypes} = nodeModule;
    if (typeof stripTypeScriptTypes !== 'function') throw cause;
    const warn = process.emitWarning;
    let stripped;
    try { process.emitWarning = () => {}; stripped = stripTypeScriptTypes(input, {mode: 'strip'}); } catch { throw cause; }
    finally { process.emitWarning = warn; }
    if (stripped.length !== input.length) throw cause;
    return acorn.parse(stripped, options);
  }
}

export function spanEnd(source, from, limit) {
  let depth = 0, lastTokenEnd = from, comma = -1;
  for (let i = from; i < limit; i++) {
    const c = source[i], n = source[i + 1];
    if (c === '/' && n === '/') { i = source.indexOf('\n', i + 2); if (i < 0) break; continue; }
    if (c === '/' && n === '*') { const end = source.indexOf('*/', i + 2); if (end < 0) break; i = end + 1; continue; }
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < limit && source[i] !== c; i++) if (source[i] === '\\') i++;
      lastTokenEnd = i + 1; continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; lastTokenEnd = i + 1; }
    else if (c === ',' && depth === 0) { comma = i; break; }
    else if (!/\s/.test(c)) lastTokenEnd = i + 1;
  }
  return {end: lastTokenEnd, comma};
}

export function prologueEnd(source, ast) {
  let at = source.startsWith('\ufeff') ? 1 : 0;
  if (source.startsWith('#!', at)) { const nl = source.indexOf('\n', at); at = nl < 0 ? source.length : nl + 1; }
  for (const stmt of ast?.body ?? []) {
    if (stmt.type === 'ExpressionStatement' && typeof stmt.directive === 'string') {
      const nl = /^\r?\n/.exec(source.slice(stmt.end))?.[0].length ?? 0;
      at = Math.max(at, stmt.end + nl);
    } else break;
  }
  return at;
}
