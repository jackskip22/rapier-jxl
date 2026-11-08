// SPDX-License-Identifier: MIT
import {readFile, writeFile, lstat, stat, realpath, mkdtemp, rename, chmod, rm} from 'node:fs/promises';
import {join, dirname, resolve, basename} from 'node:path';
import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createInterface} from 'node:readline/promises';
import acorn from '../vendor/acorn.mjs';
import {WORDS, CLI_WORDS, words} from './examples/emdash/media-words.mjs';

const text = (key, values) => words(CLI_WORDS[key], {name: WORDS.name, ...values});
export const ADD_EMDASH_HELP = text('addHelp');
export const REMOVE_EMDASH_HELP = text('removeHelp');
const error = (message, fix = CLI_WORDS.manual) => Object.assign(new Error(text('error', {message, fix})), {code: 'JXL_SETUP', fix});

export async function runAddEmdash(args, options) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { options.stdout(ADD_EMDASH_HELP.trimEnd()); return; }
  let packagePath, workersPaid;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--package' && packagePath === undefined && args[i + 1] && !String(args[i + 1]).startsWith('-'))
      packagePath = args[++i];
    else if (['--workers-paid', '--workers-free'].includes(args[i]) && workersPaid === undefined)
      workersPaid = args[i] === '--workers-paid';
    else
      throw Object.assign(error(CLI_WORDS.addOption, CLI_WORDS.addHelpFix), {code: 'JXL_OPTIONS'});
  }
  return addEmdash({...options, packagePath, workersPaid});
}

export async function runRemoveEmdash(args, options) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { options.stdout(REMOVE_EMDASH_HELP.trimEnd()); return; }
  let url;
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--url' || !args[1] || String(args[1]).startsWith('-'))
      throw Object.assign(error(CLI_WORDS.removeOption, CLI_WORDS.removeHelpFix), {code: 'JXL_OPTIONS'});
    url = args[1];
  }
  return removeEmdash({...options, url});
}

const propertyName = property => property.type === 'Property'
  ? property.computed ? property.key.type === 'Literal' ? property.key.value : null
    : property.key.name ?? property.key.value : null;
const called = (node, name) => node?.type === 'CallExpression' && !node.optional && node.callee.type === 'Identifier' && node.callee.name === name;

function property(object, name) {
  if (object?.type !== 'ObjectExpression') throw error(text('explicitObject', {property: name}));
  const matches = object.properties.filter(p => propertyName(p) === name);
  if (matches.length !== 1 || matches[0].kind !== 'init' || matches[0].method)
    throw error(text('explicitProperty', {property: name}));
  const found = matches[0], later = object.properties.slice(object.properties.indexOf(found) + 1);
  if (later.some(p => p.type === 'SpreadElement' || p.computed && propertyName(p) === null))
    throw error(text('laterProperty', {property: name}));
  return found.value;
}

export const planEmdashConfig = (source, options) => planConfig(source, false, options);
export function planEmdashRemoval(source) {
  try { return planConfig(source, true); }
  catch (cause) {
    const message = cause?.fix ? cause.message.slice(0, cause.message.lastIndexOf(' Fix: ')) : String(cause?.message ?? cause);
    throw error(message, CLI_WORDS.removeFix);
  }
}

function planConfig(source, remove, {cpuLimitMs, inspect = false} = {}) {
  let ast;
  const tokens = [];
  try { ast = acorn.parse(source, {sourceType: 'module', ecmaVersion: 'latest', onToken: tokens}); }
  catch (cause) { throw error(text('configSyntax', {detail: cause.message}), CLI_WORDS.configSyntaxFix); }
  const imports = ast.body.filter(node => node.type === 'ImportDeclaration');
  const imported = (from, name) => imports.flatMap(node => node.source.value === from
    ? node.specifiers.filter(s => name === 'default' ? s.type === 'ImportDefaultSpecifier' || s.imported?.name === 'default'
      : s.type === 'ImportSpecifier' && (s.imported.name ?? s.imported.value) === name).map(s => ({name: s.local.name, node})) : []);
  const integrations = imported('emdash/astro', 'default');
  if (integrations.length !== 1) throw error(CLI_WORDS.emdashImport);
  const emdash = integrations[0], configs = imported('astro/config', 'defineConfig');
  const exported = ast.body.find(node => node.type === 'ExportDefaultDeclaration')?.declaration;
  const config = exported?.type === 'ObjectExpression' ? exported
    : exported?.arguments?.length === 1 && configs.some(item => called(exported, item.name)) ? exported.arguments[0] : null;
  if (config?.type !== 'ObjectExpression')
    throw error(CLI_WORDS.configDynamic);
  const list = property(config, 'integrations');
  if (list.type !== 'ArrayExpression' || list.elements.some(node => node?.type === 'SpreadElement'))
    throw error(CLI_WORDS.explicitIntegrations);
  const react = imported('@astrojs/react', 'default');
  if (!remove && !list.elements.some(node => react.some(item => called(node, item.name))))
    throw error(CLI_WORDS.reactMissing, CLI_WORDS.reactFix);
  const wrappers = imported('rapier-jxl/emdash', 'jxl');
  const wrapped = node => wrappers.some(wrapper => called(node, wrapper.name)) && node.arguments[0]?.type === 'Identifier'
    && node.arguments[0].name === emdash.name;
  const matches = list.elements.filter(node => called(node, emdash.name) || wrapped(node));
  if (matches.length !== 1) throw error(CLI_WORDS.oneIntegration);
  const call = matches[0], already = wrapped(call), options = call.arguments[already ? 1 : 0];
  if ((!already && call.arguments.length !== 1 || already && ![2, 3].includes(call.arguments.length)) ||
      options?.type !== 'ObjectExpression' || already && call.arguments.length === 3 && call.arguments[2]?.type !== 'ObjectExpression')
    throw error(CLI_WORDS.explicitOptions);
  const storage = property(options, 'storage');
  const local = imported('emdash/astro', 'local'), r2 = imported('@emdash-cms/cloudflare', 'r2');
  const storageType = local.some(item => called(storage, item.name)) ? 'local' : r2.some(item => called(storage, item.name)) ? 'r2' : null;
  if (!storageType) throw error(CLI_WORDS.explicitStorage);
  if (inspect || cpuLimitMs !== undefined) {
    if (cpuLimitMs !== undefined && (storageType !== 'r2' || ![10, 30000].includes(cpuLimitMs)))
      throw error(CLI_WORDS.workersChoice, CLI_WORDS.workersChoiceFix);
    if (inspect && storageType !== 'r2') return {storage: storageType, cpuLimitMs: null};
    const adapter = property(config, 'adapter'), cloudflare = imported('@astrojs/cloudflare', 'default');
    if (!cloudflare.some(item => called(adapter, item.name)) || adapter.arguments.length > 1 ||
        adapter.arguments.length === 1 && adapter.arguments[0].type !== 'ObjectExpression')
      throw error(CLI_WORDS.workersEnvironment, CLI_WORDS.workersEnvironmentFix);
    const checkAdapter = node => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'SpreadElement' || node.type === 'Property' &&
          (node.computed && propertyName(node) === null || ['config', 'configPath', 'wranglerConfig', 'environment', 'env'].includes(propertyName(node))))
        throw error(CLI_WORDS.workersEnvironment, CLI_WORDS.workersEnvironmentFix);
      for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(checkAdapter);
      else if (value && typeof value === 'object') checkAdapter(value);
    };
    adapter.arguments.forEach(checkAdapter);
    const host = already ? call.arguments[2] : null;
    if (host && host.properties.some(item => item.type !== 'Property' || item.method || item.kind !== 'init' ||
        item.computed && propertyName(item) === null)) throw error(CLI_WORDS.workersHost, CLI_WORDS.workersHostFix);
    const found = host?.properties.filter(item => propertyName(item) === 'cpuLimitMs') ?? [];
    if (found.length > 1 || found.length && (found[0].value.type !== 'Literal' || typeof found[0].value.value !== 'number'))
      throw error(CLI_WORDS.workersHost, CLI_WORDS.workersHostFix);
    if (inspect) return {storage: storageType, cpuLimitMs: found[0]?.value.value ?? null};
  }
  if (remove) {
    if (!already) return {source, changed: false, storage: storageType};
    const wrapper = wrappers.find(item => called(call, item.name)), paren = tokens.find(token => token.start >= call.callee.end && token.end <= call.end);
    const comma = tokens.find(token => token.start >= call.arguments[0].end && token.end <= options.start && token.type.label === ',');
    if (paren?.type.label !== '(' || !comma) throw error(CLI_WORDS.directWrapper);
    const edits = [{start: call.callee.start, end: call.callee.end, text: emdash.name},
      {start: paren.end, end: comma.end + Number(source[comma.end] === ' '), text: ''}];
    if (call.arguments.length === 3) {
      const separator = tokens.find(token => token.start >= options.end && token.end <= call.arguments[2].start && token.type.label === ',');
      const close = tokens.find(token => token.end === call.end && token.type.label === ')');
      if (!separator || !close) throw error(CLI_WORDS.directWrapper);
      edits.push({start: separator.start, end: close.start, text: ''});
    }
    const elsewhere = tokens.some(token => token.type.label === 'name' && token.value === wrapper.name &&
      !(token.start >= wrapper.node.start && token.end <= wrapper.node.end) &&
      !(token.start >= call.callee.start && token.end <= call.callee.end));
    if (!elsewhere) {
      const node = wrapper.node, specifiers = node.specifiers.filter(item => item.type === 'ImportSpecifier');
      const index = specifiers.findIndex(item => item.local.name === wrapper.name);
      if (node.specifiers.length === 1) {
        const newline = /^\r?\n/.exec(source.slice(node.end))?.[0] ?? '';
        edits.push({start: node.start, end: node.end + newline.length, text: ''});
      } else if (specifiers.length === 1) {
        const separator = tokens.find(token => token.start >= node.start && token.end <= specifiers[0].start && token.type.label === ',');
        const close = tokens.find(token => token.start >= specifiers[0].end && token.end <= node.source.start && token.type.label === '}');
        if (!separator || !close) throw error(CLI_WORDS.explicitWrapperImport);
        edits.push({start: separator.start, end: close.end, text: ''});
      } else if (index > 0) {
        const separator = tokens.find(token => token.start >= specifiers[index - 1].end && token.end <= specifiers[index].start && token.type.label === ',');
        if (!separator) throw error(CLI_WORDS.explicitWrapperImport);
        edits.push({start: separator.start, end: specifiers[index].end, text: ''});
      } else {
        const separator = tokens.find(token => token.start >= specifiers[index].end && token.end <= specifiers[index + 1].start && token.type.label === ',');
        if (!separator) throw error(CLI_WORDS.explicitWrapperImport);
        edits.push({start: specifiers[index].start, end: separator.end, text: ''});
      }
    }
    let output = source;
    for (const edit of edits.sort((a, b) => b.start - a.start)) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
    acorn.parse(output, {sourceType: 'module', ecmaVersion: 'latest'});
    return {source: output, changed: true, storage: storageType};
  }
  if (already && cpuLimitMs === undefined) return {source, changed: false, storage: storageType};

  const hostEdits = [];
  if (cpuLimitMs !== undefined) {
    const host = already ? call.arguments[2] : null;
    if (host) {
      const found = host.properties.find(item => propertyName(item) === 'cpuLimitMs');
      if (found && found.value.value !== cpuLimitMs) hostEdits.push({start: found.value.start, end: found.value.end, text: String(cpuLimitMs)});
      else if (!found) hostEdits.push(addObjectProperty(source, host, `cpuLimitMs: ${cpuLimitMs}`));
    } else {
      const close = tokens.find(token => token.end === call.end && token.type.label === ')');
      if (!close) throw error(CLI_WORDS.directWrapper);
      const prior = tokens[tokens.indexOf(close) - 1];
      hostEdits.push({start: close.start, end: close.start,
        text: `${prior?.type.label === ',' ? '' : ','} {cpuLimitMs: ${cpuLimitMs}}`});
    }
  }
  if (already) {
    const output = applyEdits(source, hostEdits);
    acorn.parse(output, {sourceType: 'module', ecmaVersion: 'latest'});
    return {source: output, changed: output !== source, storage: storageType};
  }

  const names = new Set(tokens.filter(token => token.type.label === 'name').map(token => token.value));
  let binding = wrappers[0]?.name ?? 'jxl', suffix = 1;
  if (!wrappers.length) while (names.has(binding)) { binding = suffix === 1 ? 'rapierJxl' : `rapierJxl${suffix}`; suffix++; }
  const paren = tokens.find(token => token.start >= call.callee.end && token.end <= call.end);
  if (paren?.type.label !== '(') throw error(CLI_WORDS.directEmdash);
  const edits = [...hostEdits, {start: call.callee.start, end: call.callee.end, text: binding},
    {start: paren.end, end: paren.end, text: `${emdash.name}, `}];
  if (!wrappers.length) {
    const quote = source[emdash.node.source.start] === '"' ? '"' : "'", newline = source.includes('\r\n') ? '\r\n' : '\n';
    edits.push({start: emdash.node.start, end: emdash.node.start,
      text: `import {jxl${binding === 'jxl' ? '' : ` as ${binding}`}} from ${quote}rapier-jxl/emdash${quote};${newline}`});
  }
  let output = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  acorn.parse(output, {sourceType: 'module', ecmaVersion: 'latest'});
  return {source: output, changed: true, storage: storageType};
}

function applyEdits(source, edits) {
  for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  return source;
}
function addObjectProperty(source, object, property) {
  const multiline = source.slice(object.start, object.end).includes('\n'), newline = source.includes('\r\n') ? '\r\n' : '\n';
  const first = object.properties[0], line = first ? source.slice(source.lastIndexOf('\n', first.start) + 1, first.start) : '';
  const indent = first && /^[\t ]*$/.test(line) ? line : source.includes('\t') ? '\t' : '  ';
  return {start: object.start + 1, end: object.start + 1,
    text: `${multiline ? newline + indent : ''}${property}${object.properties.length ? ',' : ''}${multiline ? '' : object.properties.length ? ' ' : ''}`};
}

function wranglerSyntax(source, filename) {
  let ast, tokens = [];
  try {
    if (filename.endsWith('.json')) JSON.parse(source.replace(/^\ufeff/, ''));
    ast = acorn.parse('(' + source + '\n)', {ecmaVersion: 'latest', onToken: tokens}).body[0]?.expression;
    const value = node => {
      if (node?.type === 'ObjectExpression') {
        const names = new Set();
        for (const item of node.properties) {
          if (item.type !== 'Property' || item.computed || item.method || item.shorthand || item.kind !== 'init' ||
              item.key.type !== 'Literal' || typeof item.key.value !== 'string') throw new TypeError();
          if (JSON.parse(('(' + source).slice(item.key.start, item.key.end)) !== item.key.value || names.has(item.key.value)) throw new TypeError();
          names.add(item.key.value); value(item.value);
        }
      } else if (node?.type === 'ArrayExpression') node.elements.forEach(value);
      else if (node?.type === 'Literal' || node?.type === 'UnaryExpression' && node.operator === '-' && node.argument.type === 'Literal') {
        const parsed = JSON.parse(('(' + source).slice(node.start, node.end));
        if (parsed !== null && !['number', 'boolean', 'string'].includes(typeof parsed) || typeof parsed === 'number' && !Number.isFinite(parsed))
          throw new TypeError();
      } else throw new TypeError();
    };
    if (ast?.type !== 'ObjectExpression') throw new TypeError();
    value(ast);
  } catch { throw error(CLI_WORDS.workersJson, CLI_WORDS.workersSourceFix); }
  const shift = node => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.start === 'number') { node.start--; node.end--; }
    for (const item of Object.values(node)) if (Array.isArray(item)) item.forEach(shift);
    else if (item && typeof item === 'object') shift(item);
  };
  shift(ast);
  tokens = tokens.filter(token => token.start > 0 && token.end <= source.length + 1)
    .map(token => ({...token, start: token.start - 1, end: token.end - 1}));
  return {ast, tokens};
}
export function planWranglerAllowance(source, {filename = 'wrangler.jsonc', cpuLimitMs} = {}) {
  if (!['wrangler.json', 'wrangler.jsonc'].includes(filename) || ![10, 30000].includes(cpuLimitMs))
    throw error(CLI_WORDS.workersSource, CLI_WORDS.workersSourceFix);
  const {ast, tokens} = wranglerSyntax(source, filename), field = (object, name) => object.properties.find(item => item.key.value === name);
  const environments = field(ast, 'env'), pages = field(ast, 'pages_build_output_dir');
  if (environments && (environments.value.type !== 'ObjectExpression' || environments.value.properties.length) || pages)
    throw error(CLI_WORDS.workersEnvironment, CLI_WORDS.workersEnvironmentFix);
  const limits = field(ast, 'limits');
  if (limits && limits.value.type !== 'ObjectExpression') throw error(CLI_WORDS.workersJson, CLI_WORDS.workersSourceFix);
  const cpu = limits && field(limits.value, 'cpu_ms');
  if (cpu && (cpu.value.type !== 'Literal' || typeof cpu.value.value !== 'number' || cpu.value.value <= 0))
    throw error(CLI_WORDS.workersJson, CLI_WORDS.workersSourceFix);
  const edits = [];
  if (cpuLimitMs === 30000) {
    if (cpu && cpu.value.value !== 30000) edits.push({start: cpu.value.start, end: cpu.value.end, text: '30000'});
    else if (!cpu && limits) edits.push(addObjectProperty(source, limits.value, '"cpu_ms": 30000'));
    else if (!limits) edits.push(addObjectProperty(source, ast, '"limits": {"cpu_ms": 30000}'));
  } else if (cpu) {
    const properties = limits.value.properties, index = properties.indexOf(cpu);
    const colon = tokens.find(token => token.type.label === ':' && token.start >= cpu.key.end && token.end <= cpu.value.start);
    if (!colon) throw error(CLI_WORDS.workersJson, CLI_WORDS.workersSourceFix);
    edits.push({start: cpu.key.start, end: cpu.key.end, text: ''}, {start: colon.start, end: colon.end, text: ''},
      {start: cpu.value.start, end: cpu.value.end, text: ''});
    if (index > 0) {
      const comma = tokens.find(token => token.type.label === ',' && token.start >= properties[index - 1].end && token.end <= cpu.start);
      if (!comma) throw error(CLI_WORDS.workersJson, CLI_WORDS.workersSourceFix);
      edits.push({start: comma.start, end: comma.end, text: ''});
    } else {
      const end = properties[1]?.start ?? limits.value.end - 1;
      const comma = tokens.find(token => token.type.label === ',' && token.start >= cpu.end && token.end <= end);
      if (comma) edits.push({start: comma.start, end: comma.end, text: ''});
    }
  }
  const output = applyEdits(source, edits);
  wranglerSyntax(output, filename);
  return {source: output, changed: output !== source, cpuLimitMs};
}
async function sourceWrangler(cwd, pkg, env) {
  if (env.CLOUDFLARE_ENV || env.WRANGLER_ENV || env.WRANGLER_CONFIG || env.WRANGLER_CONFIG_FILE ||
      Object.values(pkg.scripts ?? {}).some(command => typeof command === 'string' &&
        (/\bCLOUDFLARE_ENV\s*=/.test(command) || /\b(?:wrangler|astro|vite)\b/.test(command) &&
          /(?:--(?:env|config)(?:[=\s]|$)|(?:^|\s)-[ec](?:[=\s]|$))/.test(command))))
    throw error(CLI_WORDS.workersEnvironment, CLI_WORDS.workersEnvironmentFix);
  if (await lstat(join(cwd, 'cloudflare.config.ts')).catch(() => null))
    throw error(CLI_WORDS.workersSource, CLI_WORDS.workersSourceFix);
  const choices = [];
  for (const name of ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml']) {
    const path = join(cwd, name), info = await lstat(path).catch(cause => { if (cause.code === 'ENOENT') return null; throw cause; });
    if (info) choices.push({path, info, name});
  }
  if (choices.length !== 1 || choices[0].name === 'wrangler.toml' || !choices[0].info.isFile() ||
      choices[0].info.isSymbolicLink() || choices[0].info.nlink !== 1)
    throw error(CLI_WORDS.workersSource, CLI_WORDS.workersSourceFix);
  const found = choices[0], source = await readFile(found.path, 'utf8');
  planWranglerAllowance(source, {filename: found.name, cpuLimitMs: 10});
  return {...found, source};
}
async function askWorkersPaid(question, {env}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || env.CI)
    throw error(CLI_WORDS.workersChoice, CLI_WORDS.workersChoiceFix);
  const prompt = createInterface({input: process.stdin, output: process.stdout});
  try {
    const answer = (await prompt.question(question + ' [y/N] ')).trim().toLowerCase();
    if (['yes', 'y'].includes(answer)) return true;
    if (['no', 'n', ''].includes(answer)) return false;
    throw error(CLI_WORDS.workersAnswer, CLI_WORDS.workersChoiceFix);
  } finally { prompt.close(); }
}
async function unchangedFile({path, info, source}, worker = false) {
  const fresh = await lstat(path).catch(() => null);
  if (!fresh?.isFile() || fresh.isSymbolicLink() || fresh.nlink !== 1 || fresh.ino !== info.ino || fresh.dev !== info.dev ||
      fresh.mode !== info.mode || await readFile(path, 'utf8') !== source)
    throw worker ? error(CLI_WORDS.workersChanged, CLI_WORDS.workersChangedFix)
      : error(text('configChanged', {action: CLI_WORDS.setup}), CLI_WORDS.configChangedFix);
}

async function manifest(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (cause) { if (cause.code === 'ENOENT') return null; throw error(text('manifest', {file: basename(path), detail: cause.message}), CLI_WORDS.manifestFix); }
}

async function installed(cwd, name) {
  for (let directory = cwd; ; directory = dirname(directory)) {
    const root = join(directory, 'node_modules', name), pkg = await manifest(join(root, 'package.json'));
    if (pkg) return pkg.name === name ? {root:await realpath(root), pkg} : null;
    if (dirname(directory) === directory) return null;
  }
}

function importTarget(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  for (const [condition, target] of Object.entries(value)) if (['node', 'import', 'default'].includes(condition)) {
    const found = importTarget(target); if (found) return found;
  }
  return null;
}

async function hasEmdash(pkg) {
  const target = importTarget(pkg?.pkg.exports?.['./emdash']);
  return !!target && target.startsWith('./') && !target.split('/').includes('..') && (await stat(join(pkg.root, target)).catch(() => null))?.isFile() === true;
}

export async function emdashConnection({cwd, url, env = process.env, signal}) {
  let base;
  try { base = new URL(url ?? env.EMDASH_URL ?? 'http://localhost:4321'); }
  catch { throw error(CLI_WORDS.removalUrl, CLI_WORDS.removalUrlFix); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (base.username || base.password || base.pathname !== '/' || base.search || base.hash ||
      base.protocol !== 'https:' && !(local && base.protocol === 'http:'))
    throw error(CLI_WORDS.removalUrl, CLI_WORDS.removalUrlFix);
  const login = text('loginFix', {url: base.origin});
  let token = env.EMDASH_TOKEN, credential;
  if (!token) {
    const path = join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'emdash', 'auth.json');
    try {
      const stored = JSON.parse(await readFile(path, 'utf8'));
      credential = stored?.[local ? `path:${resolve(cwd)}` : base.origin];
    } catch (cause) {
      if (cause.code !== 'ENOENT') throw error(CLI_WORDS.credentials, login);
    }
    if (credential) {
      if (typeof credential.accessToken !== 'string' || !credential.accessToken || typeof credential.expiresAt !== 'string' ||
          !Number.isFinite(Date.parse(credential.expiresAt)) || Date.parse(credential.expiresAt) <= Date.now())
        throw error(CLI_WORDS.credentials, login);
      token = credential.accessToken;
    }
  }
  if (!token && !local || token !== undefined && typeof token !== 'string') throw error(CLI_WORDS.credentials, login);
  const host = await installed(cwd, 'emdash');
  const clientEntry = importTarget(host?.pkg.exports?.['./client']);
  const headersEntry = importTarget(host?.pkg.exports?.['./client/cf-access']);
  const safe = target => typeof target === 'string' && target.startsWith('./') && !target.split('/').includes('..');
  if (!host || !safe(clientEntry) || !safe(headersEntry)) throw error(CLI_WORDS.removalClient, CLI_WORDS.removalClientFix);
  let client, headerTools;
  try {
    client = await import(pathToFileURL(join(host.root, clientEntry)).href);
    headerTools = await import(pathToFileURL(join(host.root, headersEntry)).href);
  } catch { throw error(CLI_WORDS.removalClient, CLI_WORDS.removalClientFix); }
  if (['createTransport', 'csrfInterceptor', 'tokenInterceptor', 'devBypassInterceptor'].some(name => typeof client[name] !== 'function') ||
      typeof headerTools.parseHeaderStrings !== 'function') throw error(CLI_WORDS.removalClient, CLI_WORDS.removalClientFix);
  let customHeaders;
  try {
    if (credential?.customHeaders && (typeof credential.customHeaders !== 'object' || Array.isArray(credential.customHeaders) ||
      Object.values(credential.customHeaders).some(value => typeof value !== 'string'))) throw new TypeError();
    customHeaders = new Headers({...credential?.customHeaders, ...headerTools.parseHeaderStrings(String(env.EMDASH_HEADERS ?? '').split('\n'))});
  } catch { throw error(CLI_WORDS.credentialHeader, login); }
  const transport = client.createTransport({interceptors: [client.csrfInterceptor(),
    token ? client.tokenInterceptor(token) : client.devBypassInterceptor(base.origin)]});
  return {origin: base.origin, async request(path, body) {
    signal?.throwIfAborted();
    const headers = new Headers(customHeaders);
    headers.set('Accept', 'application/json'); headers.set('Content-Type', 'application/json'); headers.set('Origin', base.origin);
    const timeout = AbortSignal.timeout(30000), requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const target = new URL('/_emdash/api/plugins/rapier-media/' + path, base);
    let response;
    try { response = await transport.fetch(new Request(target, {method: body === undefined ? 'GET' : 'POST', headers,
      ...(body === undefined ? {} : {body: JSON.stringify(body)}), redirect: 'error', signal: requestSignal})); }
    catch { signal?.throwIfAborted(); throw error(text('requestFailed', {status: 'network'}), CLI_WORDS.removeFix); }
    if (!response.ok) throw error(text('requestFailed', {status: response.status}), [401, 403].includes(response.status) ? login : CLI_WORDS.removeFix);
    let payload;
    try { payload = await response.json(); } catch { throw error(CLI_WORDS.responseInvalid, CLI_WORDS.removeFix); }
    if (payload?.success === true && payload.data === null && path === 'removal-status') return null;
    if (payload?.success !== true || !payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data))
      throw error(CLI_WORDS.responseInvalid, CLI_WORDS.removeFix);
    return payload.data;
  }};
}

function atLeast(version, minimum) {
  const a = /^(\d+)\.(\d+)\.(\d+)(?:\+[^ ]+)?$/.exec(version ?? ''), b = minimum.split('.').map(Number);
  if (!a) return false;
  for (let i = 0; i < 3; i++) if (+a[i + 1] !== b[i]) return +a[i + 1] > b[i];
  return true;
}

async function packageSource(cwd, requested, env, version) {
  const candidates = requested ? [requested] : String(env.npm_config_package ?? '').split('\n\n').filter(Boolean);
  if (!requested && candidates.length > 1 && candidates.some(candidate => /\.tgz$/i.test(candidate)))
    throw error(CLI_WORDS.ambiguousPackage, CLI_WORDS.ambiguousPackageFix);
  const selected = candidates.length === 1 && /\.tgz$/i.test(candidates[0]) ? candidates[0] : null;
  if (requested && !selected) throw error(CLI_WORDS.localPackage, CLI_WORDS.localPackageFix);
  if (!selected) return {spec: `rapier-jxl@${version}`, local: null};
  const path = resolve(cwd, selected.replace(/^file:/, ''));
  let tar, pkg, digest;
  try {
    const bytes = await readFile(path);
    digest = createHash('sha512').update(bytes).digest('base64');
    tar = gunzipSync(bytes);
    for (let at = 0; at + 512 <= tar.length;) {
      const name = tar.toString('utf8', at, at + 100).replace(/\0.*$/, '');
      if (!name) break;
      const size = Number.parseInt(tar.toString('ascii', at + 124, at + 136).replace(/\0.*$/, '').trim(), 8);
      if (!Number.isSafeInteger(size) || size < 0 || at + 512 + size > tar.length) throw new Error('invalid tar header');
      if (name === 'package/package.json') { pkg = JSON.parse(tar.toString('utf8', at + 512, at + 512 + size)); break; }
      at += 512 + Math.ceil(size / 512) * 512;
    }
  } catch (cause) { throw error(text('packageRead', {detail: cause.message}), CLI_WORDS.packageReadFix); }
  if (pkg?.name !== 'rapier-jxl' || !importTarget(pkg.exports?.['./emdash']))
    throw error(CLI_WORDS.packageMissing, CLI_WORDS.packageMissingFix);
  return {spec: path, local: path, version: pkg.version, digest};
}

async function packageManager(cwd, pkg) {
  if (pkg.packageManager !== undefined && typeof pkg.packageManager !== 'string')
    throw error(CLI_WORDS.managerType, CLI_WORDS.managerTypeFix);
  const declared = pkg.packageManager?.split('@')[0];
  const found = new Set();
  for (const [file, manager] of [['package-lock.json', 'npm'], ['npm-shrinkwrap.json', 'npm'], ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun']])
    if (await stat(join(cwd, file)).catch(() => null)) found.add(manager);
  if (declared && !['npm', 'pnpm', 'yarn', 'bun'].includes(declared))
    throw error(text('managerUnsupported', {manager: declared}), CLI_WORDS.managerUnsupportedFix);
  if (found.size > 1 && !declared) throw error(CLI_WORDS.managerAmbiguous, CLI_WORDS.managerAmbiguousFix);
  return declared ?? [...found][0] ?? 'npm';
}

function install(cwd, manager, specs, env) {
  const args = manager === 'npm' ? ['install', '--save-prod', '--save-exact', '--no-audit', '--no-fund', ...specs]
    : manager === 'pnpm' ? ['add', '--save-prod', '--save-exact', ...specs]
      : ['add', '--exact', ...specs];
  const npm = manager === 'npm' && env.npm_execpath && /(?:^|[/\\])npm(?:-cli)?\.(?:c?js|mjs)$/.test(env.npm_execpath);
  return new Promise((accept, reject) => {
    const child = spawn(npm ? process.execPath : manager, npm ? [env.npm_execpath, ...args] : args, {cwd, env, stdio: 'inherit', shell: false});
    child.once('error', cause => reject(error(text('managerRun', {manager, detail: cause.message}), text('managerRunFix', {manager}))));
    child.once('exit', (code, signal) => code === 0 ? accept() : reject(error(text('managerExit', {manager,
      reason: signal ?? text('managerExitCode', {code})}), CLI_WORDS.managerExitFix)));
  });
}

export async function addEmdash({cwd, version, packagePath, workersPaid, confirmWorkersPaid = askWorkersPaid,
  stdout, env = process.env, installPackages = install}) {
  const path = join(cwd, 'astro.config.mjs'), info = await lstat(path).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1)
    throw error(CLI_WORDS.configFile, CLI_WORDS.configFileFix);
  const source = await readFile(path, 'utf8');
  let plan = planEmdashConfig(source), worker = null, cpuLimitMs;
  const pkg = await manifest(join(cwd, 'package.json'));
  const dependency = name => pkg?.dependencies?.[name] ?? pkg?.devDependencies?.[name] ?? pkg?.optionalDependencies?.[name];
  if (!pkg || !dependency('emdash') || !dependency('astro'))
    throw error(CLI_WORDS.siteMissing, CLI_WORDS.siteMissingFix);
  if (workersPaid !== undefined && typeof workersPaid !== 'boolean' ||
      plan.storage !== 'r2' && workersPaid !== undefined)
    throw error(CLI_WORDS.workersChoice, CLI_WORDS.workersChoiceFix);
  if (plan.storage === 'r2') {
    const recorded = planConfig(source, false, {inspect: true});
    if (recorded.cpuLimitMs === 30000 && workersPaid === false)
      throw error(CLI_WORDS.workersDowngrade, CLI_WORDS.workersDowngradeFix);
    worker = await sourceWrangler(cwd, pkg, env);
    if (workersPaid === undefined && [10, 30000].includes(recorded.cpuLimitMs)) workersPaid = recorded.cpuLimitMs === 30000;
    if (workersPaid === undefined) {
      if (typeof confirmWorkersPaid !== 'function') throw error(CLI_WORDS.workersChoice, CLI_WORDS.workersChoiceFix);
      workersPaid = await confirmWorkersPaid(CLI_WORDS.workersQuestion, {env});
      if (typeof workersPaid !== 'boolean') throw error(CLI_WORDS.workersAnswer, CLI_WORDS.workersChoiceFix);
    }
    cpuLimitMs = workersPaid ? 30000 : 10;
    plan = planEmdashConfig(source, {cpuLimitMs});
    worker.plan = planWranglerAllowance(worker.source, {filename: worker.name, cpuLimitMs});
    await unchangedFile({path, info, source}); await unchangedFile(worker, true);
  }
  const workerScripts = JSON.stringify(pkg.scripts ?? {});
  const unchangedWorkerTarget = async () => {
    if (!worker) return;
    const latest = await manifest(join(cwd, 'package.json'));
    if (!latest || JSON.stringify(latest.scripts ?? {}) !== workerScripts)
      throw error(CLI_WORDS.workersChanged, CLI_WORDS.workersChangedFix);
    const selected = await sourceWrangler(cwd, latest, env);
    if (selected.path !== worker.path) throw error(CLI_WORDS.workersChanged, CLI_WORDS.workersChangedFix);
    await unchangedFile(worker, true);
  };
  const selected = await packageSource(cwd, packagePath, env, version), current = await installed(cwd, 'rapier-jxl');
  const host = await installed(cwd, 'emdash');
  const admin = host && await installed(host.root, '@emdash-cms/admin');
  const hostKumo = admin && await installed(admin.root, '@cloudflare/kumo');
  if (!hostKumo || !atLeast(hostKumo.pkg.version, '2.6.0'))
    throw error(CLI_WORDS.adminMissing, CLI_WORDS.adminMissingFix);
  const siteKumo = await installed(cwd, '@cloudflare/kumo');
  if (pkg.dependencies?.['@cloudflare/kumo'] && siteKumo && siteKumo.pkg.version !== hostKumo.pkg.version)
    throw error(text('kumoMismatch', {siteVersion: siteKumo.pkg.version, hostVersion: hostKumo.pkg.version}), text('kumoMismatchFix', {hostVersion: hostKumo.pkg.version}));
  const requirements = [['emdash', '1.4.0'], ['astro', '6.0.0'], ['@astrojs/react', '5.0.0'], ['react', '18.0.0'], ['@cloudflare/kumo', '2.6.0'],
    ...(plan.storage === 'r2' ? [['@emdash-cms/cloudflare', '1.4.0']] : [])];
  const specs = [];
  if (selected.local || !pkg.dependencies?.['rapier-jxl'] || !await hasEmdash(current)) specs.push(selected.spec);
  if (!pkg.dependencies?.['@cloudflare/kumo'] || !siteKumo) specs.push(`@cloudflare/kumo@${hostKumo.pkg.version}`);
  for (const [name, minimum] of requirements) {
    const item = await installed(cwd, name);
    if (item && !atLeast(item.pkg.version, minimum))
      throw error(text('dependencyOld', {dependency: name, minimum, version: item.pkg.version}), text('dependencyOldFix', {dependency: name}));
    if (!item && !specs.length) specs.push(selected.spec);
  }
  if (specs.length) {
    const manager = await packageManager(cwd, pkg);
    stdout(text('installing', {packages: specs.map(spec => spec === selected.local ? CLI_WORDS.tarball : spec).join(CLI_WORDS.packageSeparator), manager}));
    await installPackages(cwd, manager, specs, env);
  }
  const ready = await installed(cwd, 'rapier-jxl');
  if (!await hasEmdash(ready))
    throw error(CLI_WORDS.installedMissing, CLI_WORDS.installedMissingFix);
  if (selected.local && (ready.pkg.version !== selected.version || createHash('sha512').update(await readFile(selected.local)).digest('base64') !== selected.digest))
    throw error(CLI_WORDS.packageChanged, CLI_WORDS.packageChangedFix);
  for (const [name, minimum] of requirements) {
    const item = await installed(cwd, name);
    if (!item || !atLeast(item.pkg.version, minimum))
      throw error(text('dependencyMissing', {dependency: name, minimum}), text('dependencyMissingFix', {dependency: name}));
  }
  if ((await installed(cwd, '@cloudflare/kumo'))?.pkg.version !== hostKumo.pkg.version)
    throw error(CLI_WORDS.kumoInstalledMismatch, text('kumoInstalledFix', {hostVersion: hostKumo.pkg.version}));
  const files = [...(worker ? [{...worker, worker: true}] : []), {path, info, source, plan, worker: false}];
  await unchangedWorkerTarget();
  for (const file of files) await unchangedFile(file, file.worker);
  if (files.some(file => file.plan.changed)) {
    const temporary = await mkdtemp(join(cwd, '.rapier-jxl-'));
    try {
      for (const file of files.filter(file => file.plan.changed)) {
        file.next = join(temporary, basename(file.path));
        await writeFile(file.next, file.plan.source, {mode: file.info.mode & 0o777});
        await chmod(file.next, file.info.mode & 0o777);
      }
      await unchangedWorkerTarget();
      for (const file of files) await unchangedFile(file, file.worker);
      for (const file of files.filter(file => file.plan.changed)) {
        await unchangedWorkerTarget();
        await unchangedFile(file, file.worker);
        await rename(file.next, file.path);
        if (file.worker) {
          worker.source = file.plan.source;
          worker.info = await lstat(file.path);
        }
      }
    } finally { await rm(temporary, {recursive: true, force: true}); }
  }
  if (worker?.plan.changed) stdout(text('updatedWrangler', {file: worker.name}));
  stdout(plan.changed ? CLI_WORDS.updated : text('alreadyAdded'));
  stdout(text('added', {setupAfter: WORDS.setupAfter}));
  stdout(CLI_WORDS.nativePage);
  return {changed: plan.changed || worker?.plan.changed === true, installed: specs.length > 0,
    ...(worker ? {cpuLimitMs} : {})};
}

const removalID = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
function removalState(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !removalID(value.id) || !removalID(value.siteId) ||
      typeof value.scope !== 'string' || !value.scope || !['draining', 'restoring', 'verifying', 'complete', 'blocked'].includes(value.phase) ||
      value.retirementDisabled !== true || ![0, 1].includes(value.activeWriters) ||
      value.remaining !== null && (!Number.isSafeInteger(value.remaining) || value.remaining < 0) ||
      !Number.isSafeInteger(value.restored) || value.restored < 0 ||
      value.error !== null && (!value.error || typeof value.error !== 'object' || Array.isArray(value.error) || typeof value.error.code !== 'string'))
    throw error(CLI_WORDS.responseInvalid, CLI_WORDS.removeFix);
  if (expected && ['id', 'siteId', 'scope'].some(key => expected[key] !== undefined && value[key] !== expected[key]))
    throw error(CLI_WORDS.restorationMismatch, CLI_WORDS.removeFix);
  if (value.phase === 'complete') {
    const proof = value.proof;
    if (value.remaining !== 0 || value.activeWriters !== 0 || value.error !== null ||
        !proof || typeof proof !== 'object' || Array.isArray(proof) || proof.kind !== 'originals-restored' ||
        ['id', 'siteId', 'scope'].some(key => proof[key] !== value[key]) ||
        !removalID(proof.revision) || proof.remaining !== 0 || proof.activeWriters !== 0 || proof.retirementDisabled !== true)
      throw error(CLI_WORDS.restorationFailed, CLI_WORDS.removeFix);
  } else if (value.proof !== null) throw error(CLI_WORDS.responseInvalid, CLI_WORDS.removeFix);
  return value;
}

export async function removeEmdash({cwd, url, stdout, env = process.env, signal, connect = emdashConnection}) {
  const path = join(cwd, 'astro.config.mjs'), info = await lstat(path).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw error(CLI_WORDS.configFile, CLI_WORDS.removeFix);
  const source = await readFile(path, 'utf8'), plan = planEmdashRemoval(source);
  if (!plan.changed) { stdout(text('alreadyRemoved')); return {changed: false}; }
  const pkg = await manifest(join(cwd, 'package.json'));
  const dependency = name => pkg?.dependencies?.[name] ?? pkg?.devDependencies?.[name] ?? pkg?.optionalDependencies?.[name];
  if (!pkg || !dependency('emdash') || !dependency('astro')) throw error(CLI_WORDS.siteMissing, CLI_WORDS.siteMissingFix);
  const connection = await connect({cwd, url, env, signal});
  let state = await connection.request('removal-status');
  if (state === null) {
    const id = randomUUID().replaceAll('-', '');
    state = removalState(await connection.request('removal-start', {id}), {id});
  } else state = removalState(state);
  const identity = {id: state.id, siteId: state.siteId, scope: state.scope};
  let restored = -1;
  while (state.phase !== 'complete') {
    signal?.throwIfAborted();
    if (state.phase === 'blocked' || state.error !== null) throw error(CLI_WORDS.restorationFailed, CLI_WORDS.removeFix);
    if (state.restored !== restored) { restored = state.restored; stdout(text('restoring', {count: restored})); }
    state = removalState(await connection.request('removal-advance', identity), identity);
    if (state.phase === 'draining' && state.activeWriters > 0) {
      await new Promise((accept, reject) => {
        const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); accept(); }, 250);
        signal?.addEventListener('abort', abort, {once: true});
        if (signal?.aborted) abort();
      });
    }
  }
  const completed = removalState(await connection.request('removal-status'), identity);
  if (completed.phase !== 'complete') throw error(CLI_WORDS.restorationFailed, CLI_WORDS.removeFix);
  signal?.throwIfAborted();
  const freshInfo = await lstat(path).catch(() => null);
  if (!freshInfo?.isFile() || freshInfo.isSymbolicLink() || freshInfo.nlink !== 1 || freshInfo.ino !== info.ino || freshInfo.dev !== info.dev || freshInfo.mode !== info.mode ||
      await readFile(path, 'utf8') !== source)
    throw error(text('configChanged', {action: CLI_WORDS.removal}), CLI_WORDS.configChangedFix);
  const temporary = await mkdtemp(join(cwd, '.rapier-jxl-'));
  try {
    const next = join(temporary, 'astro.config.mjs');
    await writeFile(next, plan.source, {mode: info.mode & 0o777});
    await chmod(next, info.mode & 0o777);
    await rename(next, path);
  } finally { await rm(temporary, {recursive: true, force: true}); }
  stdout(text('removed')); stdout(CLI_WORDS.restartRemoved);
  return {changed: true, origin: connection.origin, proof: completed.proof};
}
