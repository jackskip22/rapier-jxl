// SPDX-License-Identifier: MIT
import {readFile, stat} from 'node:fs/promises';
import {readManifest, readIfAny} from './project-files.mjs';
import {writeProjectEdits, removeProjectEdits} from './project-edits.mjs';
import {createHash} from 'node:crypto';
import {join, relative} from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {parseConfig, prologueEnd, spanEnd} from './config-parse.mjs';
import {lockfileManagers, managerSpawn} from './package-manager.mjs';
import {installs, importsAs} from './package-name.mjs';
import {COMMAND} from './package-name.mjs';
import {cliError, cliArgs} from './cli-error.mjs';

export const ADD_ASTRO_HELP = `npx ${COMMAND} add astro [--dry-run] [--json]

Adds format="jxl" to Astro's <Image> and <Picture>, in the Astro site in this folder:
  installs ${COMMAND} (and sharp, where Astro has none), writes the image service into src/jxl/,
  imports it in astro.config, adds jxl() to integrations and, on @astrojs/cloudflare, imageService: 'custom'.
Safe to run again: it updates only files it wrote and nobody edited since.
  --dry-run   say what would change, change nothing
  --json      one JSON object on stdout`;

const CONFIGS = ['astro.config.mjs', 'astro.config.js', 'astro.config.ts', 'astro.config.mts', 'astro.config.cjs', 'astro.config.cts'];
const DIR = 'src/jxl', FILES = ['index.mjs', 'options.mjs', 'service.mjs', 'service-workers.mjs'], FROM = `./${DIR}/index.mjs`;
const BY_HAND = `add: import jxl from '${FROM}'; integrations: [jxl()] in astro.config`;
const digest = text => createHash('sha256').update(text).digest('hex').slice(0, 16);
export const HEADER = /^\/\/ Written by npx jpegxl add astro \(rapier-jxl [^,]+, ([0-9a-f]{16})\)\. [^\r\n]*\r?\n/;
const refuse = (message, fix = BY_HAND) => cliError('JXL_SETUP', message, fix);
const called = (node, name) => node?.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === name;
const key = property => property.type === 'Property' && !property.computed ? property.key.name ?? property.key.value : null;

export async function runAddAstro(args, {cwd, version, name, stdout, quiet = false}) {
  args = cliArgs(args);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { stdout(ADD_ASTRO_HELP); return; }
  const asJson = args.includes('--json');
  const unknown = args.filter(arg => !['--dry-run', '--json'].includes(arg));
  if (unknown.length) throw Object.assign(refuse(`unknown option: ${unknown[0]}`, `run: npx ${COMMAND} add astro --help`), {code: 'JXL_OPTIONS'});
  const result = await addAstro({cwd, version, name, dryRun: args.includes('--dry-run'), quiet: quiet || asJson});
  if (asJson) stdout(JSON.stringify({type: 'add', host: 'astro', ...result}));
  else if (!result.changes.length && !result.kept.length) stdout(`Nothing to change: ${COMMAND} is already set up.`);
  else for (const line of result.changes) stdout(`${result.dryRun ? 'Would change' : 'Changed'}: ${line}`);
  for (const file of result.kept) stdout(`Kept ${file}: edited since add astro wrote it. To take the new one, delete it and run add astro again.`);
}

export function planAstroConfig(source) {
  let ast;
  try { ast = parseConfig(source); }
  catch (cause) { throw refuse('astro.config: JS/TS parse failed'); }
  const imports = ast.body.filter(node => node.type === 'ImportDeclaration');
  const local = (from, name = 'default') => imports.flatMap(node => node.source.value === from ? node.specifiers.filter(s =>
    name === 'default' ? s.type === 'ImportDefaultSpecifier' : (s.imported?.name ?? s.imported?.value) === name).map(s => s.local.name) : [])[0];
  const exported = ast.body.find(node => node.type === 'ExportDefaultDeclaration')?.declaration;
  const define = local('astro/config', 'defineConfig');
  const config = exported?.type === 'ObjectExpression' ? exported : called(exported, define) && exported.arguments[0]?.type === 'ObjectExpression' ? exported.arguments[0] : null;
  if (!config) throw refuse('astro.config: object or defineConfig({...})');
  if (config.properties.some(p => p.type === 'SpreadElement' || p.computed)) throw refuse('astro.config: no spread/computed keys');
  const edits = [], changes = [];
  let name = local(FROM) ?? 'jxl', suffix = 1;
  if (!local(FROM)) {
    if (imports.some(node => node.specifiers.some(s => s.local.name === 'jxl'))) throw refuse('jxl: already imported');
    while (new RegExp(`\\b${name}\\b`).test(source)) { name = suffix === 1 ? 'rapierJxl' : `rapierJxl${suffix}`; suffix++; }
    const top = prologueEnd(source, ast);
    if (imports.length) edits.push({at: imports.at(-1).end, text: `\nimport ${name} from '${FROM}';`});
    else edits.push({at: top, text: `${top === source.length && top && !source.endsWith('\n') ? '\n' : ''}import ${name} from '${FROM}';\n`});
    changes.push(`import ${name} from '${FROM}'`);
  }
  const indent = (node, inner) => (source.slice(source.lastIndexOf('\n', node.start) + 1, node.start).match(/^\s*/)[0]) + (inner ? '  ' : '');
  const append = (object, text) => {
    const last = object.properties.at(-1);
    if (!last) return {at: object.start + 1, text};
    const {end, comma} = spanEnd(source, last.end, object.end - 1);
    const multi = source.slice(object.start, object.end).includes('\n');
    if (comma >= 0) return {at: comma + 1, text: multi ? `\n${indent(last)}${text},` : ` ${text}`};
    return {at: end, text: multi ? `,\n${indent(last)}${text}` : `, ${text}`};
  };
  const integrations = config.properties.find(p => key(p) === 'integrations');
  if (!integrations) { edits.push(append(config, `integrations: [${name}()]`)); changes.push(`integrations: [${name}()]`); }
  else if (integrations.value.type !== 'ArrayExpression' || integrations.value.elements.some(e => e?.type === 'SpreadElement'))
    throw refuse('integrations: array');
  else if (!integrations.value.elements.some(e => called(e, name))) {
    const list = integrations.value, last = list.elements.at(-1);
    if (last) {
      const {end, comma} = spanEnd(source, last.end, list.end - 1);
      edits.push(comma >= 0 ? {at: comma + 1, text: ` ${name}(),`} : {at: end, text: `, ${name}()`});
    } else edits.push(list.elements.length ? {at: list.end - 1, text: ` ${name}()`} : {at: list.start + 1, text: `${name}()`});
    changes.push(`${name}() in integrations`);
  }
  const cloudflare = local('@astrojs/cloudflare'), adapter = config.properties.find(p => key(p) === 'adapter')?.value;
  if (cloudflare && called(adapter, cloudflare)) {
    const options = adapter.arguments[0];
    if (!options) {
      edits.push({at: adapter.end - 1, text: `{imageService: 'custom'}`});
      changes.push(`imageService: 'custom' on the Cloudflare adapter`);
    } else if (options.type !== 'ObjectExpression' || adapter.arguments.length > 1) throw refuse('Cloudflare adapter: options object', `set: imageService: 'custom' manually`);
    else {
      const service = options.properties.find(p => key(p) === 'imageService');
      if (!service) { edits.push(append(options, `imageService: 'custom'`)); changes.push(`imageService: 'custom' on the Cloudflare adapter`); }
      else if (!(service.value.type === 'Literal' && service.value.value === 'custom'))
        throw refuse(`imageService: 'custom' required`, `set: imageService: 'custom' or format="jxl" on prerendered pages`);
    }
  }
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  for (const edit of edits.sort((a, b) => b.at - a.at)) source = source.slice(0, edit.at) + edit.text.replace(/\r?\n/g, eol) + source.slice(edit.at);
  try { parseConfig(source); } catch { throw refuse('The config could not be updated safely'); }
  return {source, changes};
}

async function packageManager(cwd) {
  const found = await lockfileManagers(cwd);
  if (found.length > 1) throw refuse('lockfiles: keep one', `keep: active lockfile or install ${COMMAND}`);
  return found[0] ?? 'npm';
}

function install(cwd, manager, specs, quiet = false) {
  const args = manager === 'npm' ? ['install', '--save-exact', '--no-audit', '--no-fund', ...specs] : ['add', ...(manager === 'pnpm' ? ['--save-exact'] : ['--exact']), ...specs];
  return new Promise((accept, reject) => {
    const child = spawn(...managerSpawn(manager, args, {cwd, quiet}));
    child.once('error', cause => reject(refuse(`${manager}: startup failed`, `install: ${specs.join(' ')}`)));
    child.once('exit', code => code === 0 ? accept() : reject(refuse(`${manager}: exit ${code}`, `install: ${specs.join(' ')}`)));
  });
}

export async function addAstro({cwd, version, name: own = 'rapier-jxl', dryRun = false, quiet = false}) {
  const pkg = (await readManifest(cwd, refuse))?.manifest;
  if (!pkg) throw refuse('package.json: missing', 'run: Astro site folder');
  const deps = {...pkg.dependencies, ...pkg.devDependencies};
  if (!deps.astro) throw refuse('astro: dependency missing', 'run: Astro site folder');
  const found = (await Promise.all(CONFIGS.map(async name => await stat(join(cwd, name)).catch(() => null) && name))).filter(Boolean);
  if (found.length !== 1) throw refuse(found.length ? `astro.config: multiple (${found.join(', ')})` : 'astro.config: missing', found.length ? 'keep: one' : BY_HAND);
  const path = join(cwd, found[0]), before = await readFile(path, 'utf8');
  const {source, changes} = planAstroConfig(before);
  const require = createRequire(join(cwd, 'package.json'));
  const has = name => [name, `${name}/package.json`].some(spec => { try { return require.resolve(spec); } catch { return false; } });
  const specs = [...(installs(pkg, own) ? [] : [`${own}@${version}`]), ...(deps.sharp || has('sharp') ? [] : ['sharp'])];
  const manager = specs.length ? await packageManager(cwd) : null;
  const writes = [], kept = [];
  for (const file of FILES) {
    let rawBody;
    try { rawBody = await readFile(new URL(`${import.meta.url.includes('/dist/') ? '../' : './'}examples/astro/${file}`, import.meta.url), 'utf8'); }
    catch { throw refuse('package: incomplete', `reinstall: ${COMMAND}`); }
    const body = importsAs(rawBody, own);
    const text = `// Written by npx ${COMMAND} add astro (rapier-jxl ${version}, ${digest(body)}). Edit freely: add astro then keeps this file.\n${body}`;
    const target = join(cwd, DIR, file), now = await readIfAny(target, 'utf8', `${DIR}/${file}`);
    const norm = now?.replace(/\r\n/g, '\n') ?? null;
    if (norm === text) continue;
    const mark = norm?.match(HEADER);
    if (norm !== null && !(mark && digest(norm.slice(mark[0].length)) === mark[1])) { kept.push(`${DIR}/${file}`); continue; }
    writes.push({target, text, now, change: `${now === null ? 'write' : 'update'} ${DIR}/${file}`});
  }
  const result = {config: found[0], changes: [...(specs.length ? [`install ${specs.join(' ')} with ${manager}`] : []),
    ...writes.map(w => w.change), ...changes.map(c => `${found[0]}: ${c}`)], kept, dryRun};
  const planned = new Map(writes.map(({target, text}) => [relative(cwd, target).replaceAll('\\', '/'), text]));
  if (source !== before) planned.set(found[0], source);
  await writeProjectEdits(cwd, 'astro', version, planned, {dryRun, ...specs.length && {install: {
    files: ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock'],
    run: () => install(cwd, manager, specs, quiet),
  }}});
  return result;
}

export const runRemoveAstro = (args, context) => removeProjectEdits('astro', args, context);

