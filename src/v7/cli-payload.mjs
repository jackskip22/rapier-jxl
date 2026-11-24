// SPDX-License-Identifier: MIT
import {access, lstat, readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {dirname, join} from 'node:path';
import {cliError, cliArgs} from './cli-error.mjs';
import {COMMAND, importsAs, installs} from './package-name.mjs';
import {lockfileManagers, managerSpawn, PACKAGE_FILES} from './package-manager.mjs';
import {parseConfig, prologueEnd, spanEnd} from './config-parse.mjs';
import {insideProject, readIfAny, readManifest} from './project-files.mjs';
import {removeProjectEdits, writeProjectEdits} from './project-edits.mjs';

const EXTENSIONS = ['ts', 'mts', 'js', 'mjs', 'cjs', 'cts'];
export const PAYLOAD_CONFIGS = ['', 'src/'].flatMap(dir => EXTENSIONS.map(ext => `${dir}payload.config.${ext}`));

export const PAYLOAD_HELP = `Usage: ${COMMAND} add payload [--dry-run] [--json]
       ${COMMAND} remove payload [--dry-run] [--json]

Adds JPEG XL uploads and serving to the Payload CMS project in this folder:
  src/jxl/index.mjs       the jxl() Payload plug-in and restoreOriginals(payload)
  src/jxl/picture.mjs     Next.js <Picture> with <source type="image/jxl"> per size
  payload.config.*        imports jxl and adds jxl() to plugins
Running it again changes nothing, and a file you edited is left as it is.`;

const setup = (message, fix) => cliError('JXL_SETUP', message, fix);
const sha = text => createHash('sha256').update(text).digest('hex');
const exists = path => access(path).then(() => true, () => false);
const HEADER = /^\/\/ Written by npx (?:rapier-jxl|jpegxl) add payload \(rapier-jxl [^,]+, sha256:([a-f0-9]{64})\)\. Edit freely: add payload then keeps this file\.\n/;

function stamped(version, body) {
  return `// Written by npx ${COMMAND} add payload (rapier-jxl ${version}, sha256:${sha(body)}). Edit freely: add payload then keeps this file.\n${body}`;
}

function copyState(current, next) {
  if (current === null) return 'create';
  const norm = current.replace(/\r\n/g, '\n');
  if (norm === next) return 'unchanged';
  const mark = norm.match(HEADER);
  return mark && sha(norm.slice(mark[0].length)) === mark[1] ? 'update' : 'edited';
}

async function shipped(path) {
  for (const url of [new URL('../examples/' + path, import.meta.url), new URL('./examples/' + path, import.meta.url)]) {
    try { return await readFile(url, 'utf8'); } catch {}
  }
  throw setup('package: incomplete', `reinstall: ${COMMAND}`);
}

function resolveIdentifierObject(ident, ast) {
  if (ident?.type !== 'Identifier') return null;
  const name = ident.name;
  const declarations = ast.body
    .filter(n => n.type === 'VariableDeclaration' && n.kind === 'const')
    .flatMap(n => n.declarations)
    .filter(d => d.id.type === 'Identifier' && d.id.name === name && d.init?.type === 'ObjectExpression');
  if (declarations.length !== 1) return null;
  const decl = declarations[0];
  let safe = true;
  const walk = (node, parent, grandparent) => {
    if (!node || typeof node !== 'object') return;
    if (node === decl.init) return;
    if (node.type === 'Identifier' && node.name === name && node !== decl.id && node !== ident) {
      const okAssign = parent?.type === 'MemberExpression' && parent.object === node && !parent.computed &&
        parent.property.name !== 'plugins' && grandparent?.type === 'AssignmentExpression' &&
        grandparent.left === parent && grandparent.operator === '=';
      const okKey = parent?.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand;
      if (!okAssign && !okKey) { safe = false; return; }
    }
    for (const val of Object.values(node)) {
      if (Array.isArray(val)) for (const item of val) walk(item, node, parent);
      else if (val && typeof val === 'object') walk(val, node, parent);
    }
  };
  walk(ast, null, null);
  return safe ? decl.init : null;
}

function unwrapConfigObject(exported, ast) {
  let target = exported?.type === 'AwaitExpression' ? exported.argument : exported;
  if (target?.type === 'ObjectExpression') return target;
  if (target?.type === 'Identifier') return resolveIdentifierObject(target, ast);
  if (target?.type === 'CallExpression') {
    const calleeName = target.callee.type === 'Identifier'
      ? target.callee.name
      : target.callee.type === 'MemberExpression' && !target.callee.computed
        ? target.callee.property?.name
        : '';
    if (/^(?:buildConfig|defineConfig)$/.test(calleeName) && target.arguments.length === 1) {
      const arg = target.arguments[0];
      if (arg?.type === 'ObjectExpression') return arg;
      if (arg?.type === 'Identifier') return resolveIdentifierObject(arg, ast);
    }
  }
  return null;
}

export function planPayloadConfig(source, configName = 'payload.config.ts', {importPath = './jxl/index.mjs'} = {}) {
  const manual = `add: import {jxl} from '${importPath}' and jxl() in plugins`;
  let ast;
  try { ast = parseConfig(source); }
  catch {
    if (source.includes(importPath)) return {source, changed: false};
    throw setup(`${configName}: JS/TS parse failed`, manual);
  }

  const isRequire = n => n?.type === 'CallExpression' && n.callee.name === 'require' && n.arguments[0]?.value === importPath;
  const imports = ast.body.filter(n => n.type === 'ImportDeclaration' ||
    (n.type === 'VariableDeclaration' && n.declarations.some(d => d.init?.type === 'CallExpression' && d.init.callee.name === 'require')));
  const ours = ast.body.find(n => (n.type === 'ImportDeclaration' && n.source.value === importPath) ||
    (n.type === 'VariableDeclaration' && n.declarations.some(d => isRequire(d.init))));
  const reqId = ours?.type === 'VariableDeclaration' ? ours.declarations.find(d => isRequire(d.init))?.id : null;
  const local = ours?.type === 'ImportDeclaration'
    ? ours.specifiers.find(s => (s.type === 'ImportSpecifier' && (s.imported.name ?? s.imported.value) === 'jxl') || s.type === 'ImportDefaultSpecifier')?.local.name
    : reqId?.type === 'ObjectPattern'
      ? reqId.properties.find(p => p.type === 'Property' && !p.computed && (p.key.name ?? p.key.value) === 'jxl' && p.value.type === 'Identifier')?.value.name
      : undefined;

  const cjs = !ast.body.some(n => n.type === 'ImportDeclaration' || n.type === 'ExportDefaultDeclaration');
  const exported = cjs
    ? ast.body.find(n => n.type === 'ExpressionStatement' && n.expression.type === 'AssignmentExpression' &&
        n.expression.left.type === 'MemberExpression' && n.expression.left.object.name === 'module' &&
        n.expression.left.property.name === 'exports')?.expression.right
    : ast.body.find(n => n.type === 'ExportDefaultDeclaration')?.declaration;

  const object = unwrapConfigObject(exported, ast);
  if (!object && ours) return {source, changed: false};
  if (!object) throw setup(`${configName}: expected buildConfig({...}) or exported config object`, manual);

  const plugins = object.properties.filter(p => p.type === 'Property' && !p.computed && !p.method && p.kind === 'init' && (p.key.name ?? p.key.value) === 'plugins');
  if (!plugins.length && object.properties.some(p => p.type === 'SpreadElement' || p.computed)) {
    throw setup(`${configName}: plugins may come from a spread or computed key`, manual);
  }
  if (plugins.length > 1 || (plugins[0] && plugins[0].value.type !== 'ArrayExpression')) {
    throw setup(`plugins in ${configName}: expected one array`, manual);
  }
  if (plugins[0]) {
    const afterPlugins = object.properties.slice(object.properties.indexOf(plugins[0]) + 1);
    if (afterPlugins.some(p => p.type === 'SpreadElement' || (p.computed && (p.key.name ?? p.key.value) !== 'plugins'))) {
      throw setup(`${configName}: a spread or computed key after plugins may override it`, manual);
    }
  }

  const list = plugins[0]?.value;
  if (local && list?.elements.some(e => e?.type === 'CallExpression' && e.callee.type === 'Identifier' && e.callee.name === local)) {
    return {source, changed: false};
  }

  let binding = local ?? 'jxl', suffix = 1;
  if (!local) {
    while (new RegExp(`\\b${binding}\\b`).test(source)) {
      binding = suffix === 1 ? 'rapierJxl' : `rapierJxl${suffix}`;
      suffix++;
    }
  }

  const quote = imports.find(n => n.type === 'ImportDeclaration' && source[n.source.start] === '"') ? '"' : "'";
  const edits = [];
  if (!local) {
    const last = imports.at(-1);
    const line = cjs
      ? `const {${binding === 'jxl' ? 'jxl' : 'jxl: ' + binding}} = require(${quote}${importPath}${quote});`
      : `import {${binding === 'jxl' ? 'jxl' : 'jxl as ' + binding}} from ${quote}${importPath}${quote};`;
    const top = prologueEnd(source, ast);
    edits.push(last
      ? {at: last.end, text: '\n' + line}
      : {at: top, text: (top === source.length && top && !source.endsWith('\n') ? '\n' : '') + line + '\n'});
  }

  const call = `${binding}()`;
  if (!list) {
    const lastProp = object.properties.at(-1);
    if (!lastProp) {
      edits.push({at: object.start + 1, text: `\n  plugins: [${call}],\n`});
    } else {
      const {end, comma} = spanEnd(source, lastProp.end, object.end - 1);
      const multi = source.slice(object.start, object.end).includes('\n');
      const pad = (source.slice(source.lastIndexOf('\n', lastProp.start) + 1, lastProp.start).match(/^[ \t]*/)?.[0]) ?? '  ';
      edits.push(comma >= 0
        ? {at: comma + 1, text: multi ? `\n${pad}plugins: [${call}],` : ` plugins: [${call}]`}
        : {at: end, text: multi ? `,\n${pad}plugins: [${call}]` : `, plugins: [${call}]`});
    }
  } else if (list.elements.at(-1)) {
    const lastEl = list.elements.at(-1);
    const {end, comma} = spanEnd(source, lastEl.end, list.end - 1);
    const multi = source.slice(list.start, list.end).includes('\n');
    const pad = (source.slice(source.lastIndexOf('\n', lastEl.start) + 1, lastEl.start).match(/^[ \t]*/)?.[0]) ?? '    ';
    edits.push(comma >= 0
      ? {at: comma + 1, text: multi ? `\n${pad}${call},` : ` ${call},`}
      : {at: end, text: multi ? `,\n${pad}${call}` : `, ${call}`});
  } else if (list.elements.length) {
    edits.push({at: list.end - 1, text: ' ' + call});
  } else {
    const rawInside = source.slice(list.start + 1, list.end - 1);
    if (rawInside.includes('\n')) {
      const closeLineStart = source.lastIndexOf('\n', list.end - 1) + 1;
      const closePad = source.slice(closeLineStart, list.end - 1).match(/^[ \t]*/)?.[0] ?? '  ';
      const itemPad = closePad + (source.includes('\t') ? '\t' : '  ');
      edits.push({at: closeLineStart, text: `${itemPad}${call},\n`});
    } else {
      edits.push({at: list.start + 1, text: call});
    }
  }

  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const updated = edits
    .sort((a, b) => b.at - a.at)
    .reduce((text, edit) => text.slice(0, edit.at) + edit.text.replace(/\r?\n/g, eol) + text.slice(edit.at), source);
  try { parseConfig(updated); }
  catch { throw setup(`${configName} could not be updated safely, so it was not changed`, manual); }
  return {source: updated, changed: updated !== source};
}

async function resolvePackageManager(cwd, pkg) {
  if (pkg.packageManager !== undefined && typeof pkg.packageManager !== 'string') {
    throw setup('package.json: packageManager is not a string', 'fix packageManager in package.json');
  }
  const declared = pkg.packageManager?.split('@')[0];
  if (declared && !['npm', 'pnpm', 'yarn', 'bun'].includes(declared)) {
    throw setup(`Unsupported packageManager "${declared}" in package.json`, 'use npm, pnpm, yarn or bun');
  }
  const found = await lockfileManagers(cwd);
  if (!declared && found.length > 1) {
    throw setup(`Multiple lockfiles found (${found.join(', ')})`, 'keep one lockfile or set packageManager in package.json');
  }
  return declared ?? found[0] ?? 'npm';
}

function installMissing(cwd, manager, specs, quiet = false, env = process.env) {
  const args = manager === 'npm'
    ? ['install', '--save-prod', '--no-audit', '--no-fund', ...specs]
    : manager === 'pnpm'
      ? ['add', '--save-prod', ...specs]
      : ['add', ...specs];
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(...managerSpawn(manager, args, {cwd, env, quiet}));
    child.once('error', err => rejectPromise(setup(`${manager} failed to start: ${err.message}`, `install by hand: ${manager} ${args.join(' ')}`)));
    child.once('exit', (code, signal) => code === 0
      ? resolvePromise()
      : rejectPromise(setup(`${manager} exited with ${signal ?? code}`, `install by hand: ${manager} ${args.join(' ')}`)));
  });
}

async function findPayloadConfigs(cwd) {
  await insideProject(cwd, PAYLOAD_CONFIGS, setup);
  const found = [];
  for (const rel of PAYLOAD_CONFIGS) {
    const full = join(cwd, rel);
    const info = await lstat(full).catch(err => {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return null;
      throw err;
    });
    if (!info) continue;
    if (info.isDirectory()) throw cliError('JXL_IO', `${rel}: a folder, not a file`, 'fix the file, then run add again');
    found.push(rel);
  }
  return found;
}

export async function addPayload({
  cwd,
  version,
  name: own = 'rapier-jxl',
  dryRun = false,
  quiet = false,
  env = process.env,
  install = installMissing,
}) {
  const read = await readManifest(cwd, setup);
  if (!read) throw setup('package.json: missing', `run npx ${COMMAND} add payload in the Payload project folder`);
  const {manifest: pkg} = read;
  const found = await findPayloadConfigs(cwd);
  const hasPayloadDep = installs(pkg, 'payload') || installs(pkg, '@payloadcms/next');

  if (found.length === 0 && !hasPayloadDep) {
    throw setup(
      'This folder is not a Payload project: looked for payload in package.json or payload.config.*',
      `run npx ${COMMAND} add payload in the Payload project folder`,
    );
  }
  if (found.length === 0) {
    throw setup(
      'No Payload config found: looked for payload.config.ts or src/payload.config.ts',
      `create payload.config.ts, then run npx ${COMMAND} add payload`,
    );
  }
  if (found.length > 1) {
    throw setup(
      `Multiple Payload configs found (${found.join(', ')})`,
      'keep one Payload config file, then run add payload again',
    );
  }

  const configFile = found[0];
  const configDir = dirname(configFile);
  const jxlDir = configDir === '.' ? 'jxl' : `${configDir}/jxl`;
  const ts = /\.(ts|mts|cts)$/.test(configFile) || await exists(join(cwd, 'tsconfig.json'));

  const configSource = await readIfAny(join(cwd, configFile), 'utf8', configFile);
  if (configSource === null) throw setup(`${configFile}: missing`, `run npx ${COMMAND} add payload in the Payload project folder`);
  const configPlan = planPayloadConfig(configSource, configFile, {importPath: './jxl/index.mjs'});

  const specs = installs(pkg, own) ? [] : [`${own}@${version}`];
  const manager = specs.length ? await resolvePackageManager(cwd, pkg) : null;

  const copySpecs = [
    [`${jxlDir}/index.mjs`, 'payload/index.mjs'],
    [`${jxlDir}/picture.mjs`, 'payload/picture.mjs'],
    [`${jxlDir}/accept.mjs`, 'files/accept.mjs'],
    ...(ts ? [
      [`${jxlDir}/index.d.mts`, 'payload/index.d.ts'],
      [`${jxlDir}/picture.d.mts`, 'payload/picture.d.ts'],
    ] : []),
  ];

  const writes = new Map();
  const changes = [];
  if (specs.length) {
    changes.push({file: 'package.json', action: `install ${specs.join(' ')} with ${manager}`});
  }

  for (const [targetRel, fromExample] of copySpecs) {
    const raw = await shipped(fromExample);
    const rewritten = importsAs(raw.replaceAll("'../files/accept.mjs'", "'./accept.mjs'"), own);
    const fullText = stamped(version, rewritten);
    const current = await readIfAny(join(cwd, targetRel), 'utf8', targetRel);
    const state = copyState(current, fullText);
    if (state === 'create' || state === 'update') writes.set(targetRel, fullText);
    changes.push({
      file: targetRel,
      action: state === 'edited' ? 'left (edited)' : state === 'create' ? 'created' : state === 'update' ? 'updated' : 'unchanged',
    });
  }

  if (configPlan.changed) writes.set(configFile, configPlan.source);
  changes.push({
    file: configFile,
    action: configPlan.changed ? 'updated: imports jxl and adds jxl() to plugins' : 'unchanged',
  });

  await writeProjectEdits(cwd, 'payload', version, writes, {
    dryRun,
    ...(specs.length ? {
      install: {
        files: PACKAGE_FILES,
        run: () => install(cwd, manager, specs, quiet, env),
      },
    } : {}),
  });

  const next = [
    `render uploads in Next.js with <Picture doc={media} /> from ./${jxlDir}/picture.mjs`,
  ];
  return {
    type: 'add',
    host: 'payload',
    config: configFile,
    dryRun,
    installed: !dryRun && specs.length > 0,
    packages: specs,
    changes,
    next,
  };
}

export async function runAddPayload(args, {cwd, version, name = 'rapier-jxl', quiet = false, stdout, env, install}) {
  args = cliArgs(args);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    stdout(PAYLOAD_HELP);
    return;
  }
  const dryRun = args.includes('--dry-run');
  const json = args.includes('--json');
  const unknown = args.find(arg => arg !== '--dry-run' && arg !== '--json');
  if (unknown) {
    throw cliError('JXL_OPTIONS', `add payload: unknown option ${unknown}`, `run: npx ${COMMAND} add payload --help`);
  }
  const result = await addPayload({cwd, version, name, dryRun, quiet: quiet || json, env, ...(install ? {install} : {})});
  if (json) {
    stdout(JSON.stringify(result));
    return result;
  }
  for (const c of result.changes) {
    const prefix = dryRun && !/^(unchanged|left)/.test(c.action) ? 'would be ' : '';
    stdout(`${c.file}: ${prefix}${c.action}`);
  }
  for (const line of result.next) stdout(`next: ${line}`);
  return result;
}

function stripJsComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/[^\n]*/g, '');
}

export async function runRemovePayload(args, context) {
  const cleanArgs = cliArgs(args);
  if (cleanArgs.length === 1 && ['--help', '-h'].includes(cleanArgs[0])) {
    context.stdout(PAYLOAD_HELP);
    return;
  }
  const found = await findPayloadConfigs(context.cwd);
  for (const rel of found) {
    const text = await readIfAny(join(context.cwd, rel), 'utf8', rel);
    if (text && /\bspaceSaver\s*:\s*true\b/.test(stripJsComments(text))) {
      throw setup(
        `${rel} has spaceSaver: true, so removed original JPEGs may still rely on jxl() to restore on the server`,
        'run restoreOriginals(payload) first, remove spaceSaver: true from the config, then run remove payload',
      );
    }
  }
  return removeProjectEdits('payload', cleanArgs, context);
}
