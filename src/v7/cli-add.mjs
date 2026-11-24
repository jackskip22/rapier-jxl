// SPDX-License-Identifier: MIT
import {readFile, access} from 'node:fs/promises';
import {readManifest, readIfAny} from './project-files.mjs';
import {writeProjectEdits, removeProjectEdits} from './project-edits.mjs';
import {dirname, join} from 'node:path';
import {createHash} from 'node:crypto';
import {installs, importsAs} from './package-name.mjs';
import {parseConfig, prologueEnd, spanEnd} from './config-parse.mjs';
import {COMMAND} from './package-name.mjs';
import {cliError as fail, cliArgs} from './cli-error.mjs';

export const ADD_HOSTS = ['vite', 'webpack', 'next', 'netlify', 'void'];
export const VITE_FRAMEWORKS = {sveltekit: 'SvelteKit', nuxt: 'Nuxt'};
const FRAMEWORK_PACKAGE = {sveltekit: '@sveltejs/kit', nuxt: 'nuxt'};
const HELP = {
  vite: `  rapier-jxl-vite.mjs     the plug-in (and its types with a tsconfig.json)
  vite.config.*           imports it and adds jxl() to plugins
Then import hero from './hero.jpg?jxl' gives a JPEG XL file's URL.`,
  webpack: `  rapier-jxl-webpack.mjs  the plug-in and its loader (webpack 5 and Rspack)
  webpack.config.*        imports it and adds jxl() to plugins (or rspack.config.*)
Then import hero from './hero.jpg?jxl' gives a JPEG XL file's URL.`,
  next: `  rapier-jxl-next.mjs     writes the JPEG XL files after next build (the postbuild script)
  rapier-jxl-next-proxy.mjs  answers next/image with them where the browser accepts JPEG XL
  proxy.js (Next 16) or middleware.js (Next 15)  uses it, unless the project has one
Then <Image> serves JPEG XL to browsers that show it, and Next's own image to the rest.`,
  netlify: `  netlify/plugins/rapier-jxl/  the build plug-in: a .jxl beside each JPEG and PNG it publishes
  netlify.toml            lists the plug-in
Then the site serves JPEG XL to browsers that send Accept: image/jxl, and the originals to the rest.`,
  void: `  routes/api/images/       POST stores a picture as JPEG XL in the app's storage, GET /api/images/<id> serves it
  src/jxl-upload.mjs      uploadImage(file): a JPEG is made JPEG XL in the page, without loss, before it is sent
Then <img src={url}> shows JPEG XL to browsers that accept it, and the exact original to the rest.`,
};
export const addHelp = (host, as = host) => `Usage: ${COMMAND} add ${as} [--dry-run] [--json]

Adds JPEG XL images to the ${VITE_FRAMEWORKS[as] ?? (host === 'next' ? 'Next.js' : host === 'netlify' ? 'Netlify' : host[0].toUpperCase() + host.slice(1))} project in this folder:
${as === 'nuxt' ? HELP.vite.replace('  vite.config.*           imports it and adds jxl() to plugins', '  nuxt.config.*           imports it and adds jxl() to vite.plugins') : HELP[host]}
Running it again changes nothing; a file you edited is left as it is.`;

const CORE = 'rapier-jxl-files.mjs', ACCEPT = 'rapier-jxl-accept.mjs';
const configs = (...bases) => bases.flatMap(base => ['js', 'mjs', 'cjs', 'ts', 'mts', 'cts'].map(ext => `${base}.config.${ext}`));
const KIND = {
  vite: {name: 'a Vite', packages: ['vite', 'vite-plus'], files: configs('vite')},
  webpack: {name: 'a webpack or Rspack', packages: ['webpack', '@rspack/core', '@rspack/cli'], files: configs('webpack', 'rspack')},
  next: {name: 'a Next.js', packages: ['next'], files: configs('next')},
  netlify: {name: 'a Netlify', packages: ['@netlify/build', 'netlify-cli'], files: ['netlify.toml']},
  void: {name: 'a Void', packages: ['void'], files: []},
};
const exists = path => access(path).then(() => true, () => false);
const sha = text => createHash('sha256').update(text).digest('hex');
const firstFound = async (cwd, names) => (await Promise.all(names.map(n => exists(join(cwd, n))))).map((f, i) => f && names[i]).find(Boolean);

async function shipped(path) {
  for (const url of [new URL('../examples/' + path, import.meta.url), new URL('./examples/' + path, import.meta.url)])
    try { return await readFile(url, 'utf8'); } catch {}
  throw fail('JXL_SETUP', 'package: incomplete', `reinstall: ${COMMAND}`);
}

function stamped(version, host, body) {
  return `// rapier-jxl ${version}. npx ${COMMAND} add ${host} updates this file while it is unchanged; edit it freely. sha256:${sha(body)}\n` + body;
}
function copyState(current, next) {
  if (current === null) return 'create';
  const norm = current.replace(/\r\n/g, '\n');
  if (norm === next) return 'unchanged';
  const [head, ...rest] = norm.split('\n'), mark = head.match(/sha256:([0-9a-f]{64})$/);
  return mark && sha(rest.join('\n')) === mark[1] ? 'update' : 'edited';
}

function factoryObject(factory, ast) {
  if (!['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(factory?.type) || factory.async || factory.generator) return null;
  const body = factory.body;
  let returned = body;
  const walk = (node, visit, parent = null, grandparent = null) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.type === 'string' && visit(node, parent, grandparent) === false) return;
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) { for (const child of value) walk(child, visit, node, parent); }
      else if (value && typeof value === 'object') walk(value, visit, node, parent);
    }
  };
  if (body.type === 'BlockStatement') {
    const returns = [];
    walk(body, node => {
      if (/^(?:ArrowFunctionExpression|FunctionExpression|FunctionDeclaration)$/.test(node.type)) return false;
      if (node.type === 'ReturnStatement') returns.push(node);
    });
    if (returns.length !== 1 || body.body.at(-1) !== returns[0]) return null;
    returned = returns[0].argument;
  }
  if (returned?.type === 'ObjectExpression') return returned;
  if (returned?.type !== 'Identifier') return null;
  const name = returned.name;
  const declarations = [...ast.body, ...(body.type === 'BlockStatement' ? body.body : [])]
    .filter(n => n.type === 'VariableDeclaration' && n.kind === 'const')
    .flatMap(n => n.declarations).filter(d => d.id.type === 'Identifier' && d.id.name === name && d.init?.type === 'ObjectExpression');
  if (declarations.length !== 1) return null;
  const declaration = declarations[0];
  let safe = true;
  walk(ast, (node, parent, grandparent) => {
    if (node === declaration.init) return false;
    if (node.type !== 'Identifier' || node.name !== name || node === declaration.id || node === returned) return;
    if (parent?.type === 'MemberExpression' && parent.object === node && !parent.computed && parent.property.name !== 'plugins'
        && grandparent?.type === 'AssignmentExpression' && grandparent.left === parent && grandparent.operator === '=') return;
    if (parent?.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand) return;
    safe = false;
  });
  return safe ? declaration.init : null;
}

export function configEdit(source, config, {importPath, name: wanted = 'jxl', define = /^define(Config)?$/, inside}) {
  const manual = `add: import {jxl} from '${importPath}'; ${inside ? inside + '.' : ''}plugins: [jxl()]`;
  let ast;
  try { ast = parseConfig(source); }
  catch { if (source.includes(importPath)) return null; throw fail('JXL_SETUP', `${config}: JS/TS parse failed`, manual); }
  const isRequire = n => n?.type === 'CallExpression' && n.callee.name === 'require' && n.arguments[0]?.value === importPath;
  const imports = ast.body.filter(n => n.type === 'ImportDeclaration' || n.type === 'VariableDeclaration' && n.declarations.some(d => d.init?.type === 'CallExpression' && d.init.callee.name === 'require'));
  const ours = ast.body.find(n => n.type === 'ImportDeclaration' && n.source.value === importPath || n.type === 'VariableDeclaration' && n.declarations.some(d => isRequire(d.init)));
  const reqId = ours?.type === 'VariableDeclaration' ? ours.declarations.find(d => isRequire(d.init))?.id : null;
  const local = ours?.type === 'ImportDeclaration' ? ours.specifiers.find(s => s.type === 'ImportSpecifier' && (s.imported.name ?? s.imported.value) === 'jxl' || s.type === 'ImportDefaultSpecifier')?.local.name
    : reqId?.type === 'ObjectPattern' ? reqId.properties.find(p => p.type === 'Property' && !p.computed && (p.key.name ?? p.key.value) === 'jxl' && p.value.type === 'Identifier')?.value.name : undefined;
  const cjs = !ast.body.some(n => n.type === 'ImportDeclaration' || n.type === 'ExportDefaultDeclaration');
  const exported = cjs ? ast.body.find(n => n.type === 'ExpressionStatement' && n.expression.type === 'AssignmentExpression' && n.expression.left.type === 'MemberExpression'
      && n.expression.left.object.name === 'module' && n.expression.left.property.name === 'exports')?.expression.right
    : ast.body.find(n => n.type === 'ExportDefaultDeclaration')?.declaration;
  let object = exported?.type === 'ObjectExpression' ? exported
    : exported?.type === 'CallExpression' && define.test(exported.callee.name ?? exported.callee.property?.name ?? '') && exported.arguments[0]?.type === 'ObjectExpression' ? exported.arguments[0]
    : factoryObject(exported, ast);
  if (!object && ours) return null;
  if (!object) throw fail('JXL_SETUP', `${config}: object, defineConfig({...}) or factory`, manual);
  let outer = null;
  if (inside) {
    const found = object.properties.filter(p => p.type === 'Property' && !p.computed && (p.key.name ?? p.key.value) === inside);
    if (!found.length && object.properties.some(p => p.type === 'SpreadElement' || p.computed))
      throw fail('JXL_SETUP', `${config}: ${inside} may come from a spread or a computed key`, manual);
    if (found.length > 1 || found[0] && found[0].value.type !== 'ObjectExpression') throw fail('JXL_SETUP', `${inside} in ${config}: one object`, manual);
    if (found[0]) object = found[0].value; else { outer = object; object = {properties: []}; }
  }
  const plugins = object.properties.filter(p => p.type === 'Property' && !p.computed && (p.key.name ?? p.key.value) === 'plugins');
  if (!plugins.length && object.properties.some(p => p.type === 'SpreadElement' || p.computed))
    throw fail('JXL_SETUP', `${config}: plugins may come from a spread or a computed key`, manual);
  if (plugins.length > 1 || plugins[0] && plugins[0].value.type !== 'ArrayExpression')
    throw fail('JXL_SETUP', `plugins in ${config}: array`, manual);
  const list = plugins[0]?.value;
  let name = local ?? wanted, suffix = 1;
  if (!local) while (new RegExp(`\\b${name}\\b`).test(source)) { name = suffix === 1 ? 'rapierJxl' : `rapierJxl${suffix}`; suffix++; }
  if (local && list?.elements.some(e => e?.type === 'CallExpression' && e.callee.name === local)) return null;
  const edits = [];
  if (!local) {
    const last = imports.pop();
    const line = cjs ? `const {${name === 'jxl' ? 'jxl' : 'jxl: ' + name}} = require('${importPath}');`
      : `import {${name === 'jxl' ? 'jxl' : 'jxl as ' + name}} from '${importPath}';`;
    const top = prologueEnd(source, ast);
    edits.push(last ? {at: last.end, text: '\n' + line} : {at: top, text: (top === source.length && top && !source.endsWith('\n') ? '\n' : '') + line + '\n'});
  }
  const call = name + '()';
  if (outer) edits.push({at: outer.start + 1, text: `\n  ${inside}: {plugins: [${call}]},`});
  else if (!list) {
    const lastProp = object.properties.at(-1);
    if (!lastProp) edits.push({at: object.start + 1, text: `\n  plugins: [${call}],`});
    else {
      const {end, comma} = spanEnd(source, lastProp.end, object.end - 1);
      const multi = source.slice(object.start, object.end).includes('\n');
      const pad = (source.slice(source.lastIndexOf('\n', lastProp.start) + 1, lastProp.start).match(/^\s*/)?.[0]) ?? '  ';
      edits.push(comma >= 0 ? {at: comma + 1, text: multi ? `\n${pad}plugins: [${call}],` : ` plugins: [${call}]`}
        : {at: end, text: multi ? `,\n${pad}plugins: [${call}]` : `, plugins: [${call}]`});
    }
  } else if (list.elements.at(-1)) {
    const {end, comma} = spanEnd(source, list.elements.at(-1).end, list.end - 1);
    edits.push(comma >= 0 ? {at: comma + 1, text: ' ' + call + ','} : {at: end, text: ', ' + call});
  } else if (list.elements.length) edits.push({at: list.end - 1, text: ' ' + call});
  else edits.push({at: list.start + 1, text: call});
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const updated = edits.sort((a, b) => b.at - a.at).reduce((text, e) => text.slice(0, e.at) + e.text.replace(/\r?\n/g, eol) + text.slice(e.at), source);
  try { parseConfig(updated); } catch { throw fail('JXL_SETUP', `${config} could not be updated safely, so it was not changed`, manual); }
  return updated;
}

async function plan(host, cwd, pkg) {
  const ts = await exists(join(cwd, 'tsconfig.json'));
  if (host === 'vite') return {dir: '', files: [['rapier-jxl-vite.mjs', 'vite/index.mjs'],
    ...(ts ? [['rapier-jxl-vite.d.mts', 'vite/index.d.ts'], [(await exists(join(cwd, 'src')) ? 'src/' : '') + 'rapier-jxl-images.d.ts', 'vite/client.d.ts']] : [])]};
  if (host === 'webpack') return {dir: '', files: [['rapier-jxl-webpack.mjs', 'webpack/index.mjs'], ...(ts ? [['rapier-jxl-webpack.d.mts', 'webpack/index.d.ts']] : [])]};
  if (host === 'next') return {dir: '', files: [['rapier-jxl-next.mjs', 'next/index.mjs'], ['rapier-jxl-next-proxy.mjs', 'next/proxy.mjs'], ['rapier-jxl-next-loader.mjs', 'next/loader.mjs'], [ACCEPT, 'files/accept.mjs']]};
  if (host === 'void') return {dir: '', core: false, files: [['routes/api/images/_jxl.mjs', 'void/images.mjs'],
    ['routes/api/images/index.mjs', 'void/upload-route.mjs'], ['routes/api/images/[id].mjs', 'void/image-route.mjs'], ['src/jxl-upload.mjs', 'void/client.mjs']]};
  return {dir: 'netlify/plugins/rapier-jxl/', files: [['index.mjs', 'netlify/index.mjs'], ['edge.mjs', 'netlify/edge.mjs'], ['manifest.yml', 'netlify/manifest.yml'], ['package.json', 'netlify/package.json'], [ACCEPT, 'files/accept.mjs']]};
}

export async function runAdd(host, args, {cwd, version, name = 'rapier-jxl', stdout, as = host}) {
  args = cliArgs(args);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { stdout(addHelp(host, as)); return; }
  const dryRun = args.includes('--dry-run'), json = args.includes('--json');
  const unknown = args.find(a => a !== '--dry-run' && a !== '--json');
  if (unknown) throw fail('JXL_OPTIONS', `add ${as}: unknown option ${unknown}`, `run: npx ${COMMAND} add ${as} --help`);
  const setup = (message, fix) => fail('JXL_SETUP', message, fix);
  const read = await readManifest(cwd, setup);
  if (!read) throw fail('JXL_SETUP', 'package.json: missing', `run: npx ${COMMAND} add ${as} in the project folder`);
  const {text: pkgText, manifest: pkg} = read, changes = [], next = [];
  const wanted = FRAMEWORK_PACKAGE[as], kind = KIND[host];
  if (wanted && !installs(pkg, wanted)) throw setup(`${VITE_FRAMEWORKS[as]}: missing ${wanted} in package.json`, `run: npx ${COMMAND} add ${as} in the ${VITE_FRAMEWORKS[as]} project folder`);
  if (!wanted && !kind.packages.some(p => installs(pkg, p)) && !await firstFound(cwd, kind.files))
    throw setup(`This folder is not ${kind.name} project: looked for ${[...kind.packages, ...kind.files].join(', ')}`, `run npx ${COMMAND} add ${as} in the project's folder`);
  const writes = new Map(), write = async (file, text) => { writes.set(file, text); };
  const copy = async (file, text) => {
    const current = await readIfAny(join(cwd, file), 'utf8', file), state = copyState(current, text);
    if (state === 'create' || state === 'update') await write(file, text);
    changes.push({file, action: state === 'edited' ? 'left (edited)' : state === 'create' ? 'created' : state === 'update' ? 'updated' : 'unchanged'});
  };
  const {dir, files, core = true} = await plan(host, cwd, pkg), own = name;
  for (const [file, from] of files) {
    const body = importsAs((await shipped(from)).replaceAll("'../files/index.mjs'", `'./${CORE}'`)
      .replaceAll("'../files/accept.mjs'", `'./${ACCEPT}'`), own);
    await copy(dir + file, /\.(json|yml)$/.test(file) ? body : stamped(version, as, body));
  }
  if (core) await copy(dir + CORE, stamped(version, as, importsAs(await shipped('files/index.mjs'), own)));
  await wire[as === 'nuxt' ? 'nuxt' : host](cwd, {pkg, pkgText, write, changes, next, as});
  if (!installs(pkg, name)) {
    const field = host === 'void' ? 'dependencies' : 'devDependencies';
    const text = writes.get('package.json') ?? pkgText, clean = text.replace(/^\ufeff/, ''), bom = text.startsWith('\ufeff') ? '\ufeff' : '';
    const eol = clean.includes('\r\n') ? '\r\n' : '\n', indent = clean.match(/^\{\r?\n([ \t]+)/)?.[1] ?? '  ', edited = JSON.parse(clean);
    edited[field] = {...edited[field], [name]: `^${version}`};
    await write('package.json', bom + (JSON.stringify(edited, null, indent) + (clean.endsWith('\n') ? '\n' : '')).replace(/\n/g, eol));
    const at = changes.findIndex(c => c.file === 'package.json'), action = `updated: ${field} has ${name} ^${version}`;
    if (at < 0) changes.push({file: 'package.json', action});
    else changes[at] = {file: 'package.json', action: changes[at].action === 'unchanged' ? action : `${changes[at].action}; ${field} has ${name} ^${version}`};
    next.unshift('npm install');
  }
  await writeProjectEdits(cwd, as, version, writes, {dryRun});
  if (json) { stdout(JSON.stringify({type: 'add', host: as, dryRun, changes, next})); return; }
  for (const c of changes) stdout(`${c.file}: ${dryRun && !/^(unchanged|left)/.test(c.action) ? 'would be ' : ''}${c.action}`);
  for (const n of next) stdout('next: ' + n);
}

export const runRemove = (host, args, context) => removeProjectEdits(context.as ?? host, args, context);

async function wireConfig(cwd, names, fallback, importPath, {pkg, write, changes}, {edit, fresh} = {}) {
  const config = await firstFound(cwd, names);
  if (!config) {
    const file = fallback(pkg);
    await write(file, fresh ? fresh(file) : file.endsWith('.js') && pkg.type !== 'module'
      ? `const {jxl} = require('${importPath}');\n\nmodule.exports = {\n  plugins: [jxl()],\n};\n`
      : `import {jxl} from '${importPath}';\n\nexport default {\n  plugins: [jxl()],\n};\n`);
    changes.push({file, action: 'created'});
    return;
  }
  const source = await readFile(join(cwd, config), 'utf8'), edited = configEdit(source, config, {importPath, ...edit});
  if (edited !== null) await write(config, edited);
  changes.push({file: config, action: edited === null ? 'unchanged' : `updated: imports the plug-in, adds jxl() to ${edit?.inside ? edit.inside + '.' : ''}plugins`});
}

const wire = {
  async vite(cwd, ctx) {
    const config = await firstFound(cwd, configs('vite'));
    if (!config) {
      const file = ctx.pkg.type === 'module' ? 'vite.config.js' : 'vite.config.mjs';
      const from = !installs(ctx.pkg, 'vite') && installs(ctx.pkg, 'vite-plus') ? 'vite-plus' : 'vite';
      await ctx.write(file, `import {defineConfig} from '${from}';\nimport {jxl} from './rapier-jxl-vite.mjs';\n\nexport default defineConfig({\n  plugins: [jxl()],\n});\n`);
      ctx.changes.push({file, action: 'created'});
    } else await wireConfig(cwd, [config], null, './rapier-jxl-vite.mjs', ctx);
    ctx.next.push((ctx.as === 'sveltekit' ? 'in a .svelte file: ' : '') + "import hero, {original} from './hero.jpg?jxl'; then <picture><source srcset={hero} type=\"image/jxl\"><img src={original}></picture>");
  },
  async nuxt(cwd, ctx) {
    const edit = {define: /^defineNuxtConfig$/, inside: 'vite'};
    await wireConfig(cwd, configs('nuxt'), () => 'nuxt.config.ts', './rapier-jxl-vite.mjs', ctx, {edit,
      fresh: () => `import {jxl} from './rapier-jxl-vite.mjs';\n\nexport default defineNuxtConfig({\n  vite: {plugins: [jxl()]},\n});\n`});
    ctx.next.push("import hero, {original} from './hero.jpg?jxl'; then <picture><source :srcset=\"hero\" type=\"image/jxl\"><img :src=\"original\"></picture>");
  },
  async webpack(cwd, ctx) {
    const names = configs('webpack', 'rspack');
    const rspack = !!(ctx.pkg.dependencies?.['@rspack/core'] || ctx.pkg.devDependencies?.['@rspack/core'] || ctx.pkg.devDependencies?.['@rspack/cli']);
    await wireConfig(cwd, names, pkg => (rspack ? 'rspack' : 'webpack') + (pkg.type === 'module' ? '.config.js' : '.config.mjs'), './rapier-jxl-webpack.mjs', ctx);
    ctx.next.push("import hero, {original} from './hero.jpg?jxl'; then <picture><source srcset={hero} type=\"image/jxl\"><img src={original}></picture>");
    ctx.next.push('jxl({beside: true}) also writes a .jxl beside every JPEG and PNG the build emits, for a server that picks by Accept.');
  },
  async next(cwd, {pkg, pkgText, write, changes, next}) {
    const step = 'node rapier-jxl-next.mjs';
    const postbuild = pkg.scripts?.postbuild;
    if (postbuild !== undefined && typeof postbuild !== 'string')
      throw fail('JXL_SETUP', 'package.json: scripts.postbuild is not a string', 'fix scripts.postbuild in package.json');
    if (postbuild?.includes(step)) changes.push({file: 'package.json', action: 'unchanged'});
    else if (postbuild) {
      changes.push({file: 'package.json', action: 'left (has a postbuild script)'});
      next.push(`add  && ${step}  to the end of the postbuild script in package.json.`);
    } else {
      const cleanPkg = pkgText.replace(/^\ufeff/, ''), bom = pkgText.startsWith('\ufeff') ? '\ufeff' : '';
      const eol = cleanPkg.includes('\r\n') ? '\r\n' : '\n';
      const edited = JSON.parse(cleanPkg);
      edited.scripts = {...edited.scripts, postbuild: step};
      const indent = cleanPkg.match(/^\{\r?\n([ \t]+)/)?.[1] ?? '  ';
      await write('package.json', bom + (JSON.stringify(edited, null, indent) + (cleanPkg.endsWith('\n') ? '\n' : '')).replace(/\n/g, eol));
      changes.push({file: 'package.json', action: `updated: postbuild runs ${step}`});
    }
    const rawNext = pkg.dependencies?.next ?? pkg.devDependencies?.next;
    let major = Number((typeof rawNext === 'string' ? rawNext : '').match(/(\d+)/)?.[1]) || 16;
    for (let dir = cwd; ; dir = dirname(dir)) {
      try { major = Number(JSON.parse(await readFile(join(dir, 'node_modules', 'next', 'package.json'), 'utf8')).version.split('.')[0]) || major; break; }
      catch { if (dirname(dir) === dir) break; }
    }
    const src = await exists(join(cwd, 'src', 'app')) || await exists(join(cwd, 'src', 'pages')) ? 'src/' : '';
    const existing = await firstFound(cwd, ['src/', ''].flatMap(dir => ['proxy', 'middleware'].flatMap(n => ['js', 'mjs', 'ts', 'mts', 'cjs', 'cts'].map(e => dir + n + '.' + e))));
    const config = await firstFound(cwd, configs('next'));
    const stripJsComments = t => t.replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/[^\n]*/g, '');
    const exported = config && /output\s*:\s*['"]export['"]/.test(stripJsComments(await readFile(join(cwd, config), 'utf8')));
    const importPath = (src ? '../' : './') + 'rapier-jxl-next-proxy.mjs';
    if (exported) next.push("a static export has no server to choose by Accept: use rapier-jxl-next-loader.mjs as a <picture>'s <source type=\"image/jxl\">, as its first lines show, or serve out/ from a host that picks by Accept.");
    else if (existing && (await readFile(join(cwd, existing), 'utf8')).includes('rapier-jxl-next-proxy.mjs')) changes.push({file: existing, action: 'unchanged'});
    else if (existing) {
      changes.push({file: existing, action: 'left (the project has its own)'});
      next.push(`in ${existing}, return jxlProxy(request) first when it gives a response: import {jxlProxy} from '${existing.startsWith('src/') ? '../' : './'}rapier-jxl-next-proxy.mjs'; and add '/_next/image' to its matcher.`);
    } else {
      const file = src + (major >= 16 ? 'proxy.js' : 'middleware.js');
      await write(file, `export {jxlProxy as ${major >= 16 ? 'proxy' : 'middleware'}} from '${importPath}';\nexport const config = {matcher: '/_next/image'};\n`);
      changes.push({file, action: 'created'});
    }
    const ignore = await readIfAny(join(cwd, '.gitignore'), 'utf8', '.gitignore');
    if (ignore?.split(/\r?\n/).some(line => /^\/?public\/_jxl\/?$/.test(line.trim()))) changes.push({file: '.gitignore', action: 'unchanged'});
    else {
      const ignoreEol = ignore?.includes('\r\n') ? '\r\n' : '\n';
      await write('.gitignore', (ignore === null ? '' : ignore.replace(/(?:\r?\n)*$/, ignoreEol)) + '/public/_jxl/' + ignoreEol);
      changes.push({file: '.gitignore', action: ignore === null ? 'created' : 'updated: ignores public/_jxl/'});
    }
    next.push('npm run build: the postbuild step lists the pictures it wrote; npx next start serves them.');
  },
  async netlify(cwd, {write, changes, next}) {
    const file = 'netlify.toml', entry = 'package = "./netlify/plugins/rapier-jxl"';
    const current = await readIfAny(join(cwd, file), 'utf8', file);
    const uncommentedToml = current?.split(/\r?\n/).some(line => line.replace(/#.*$/, '').includes(entry));
    if (uncommentedToml) changes.push({file, action: 'unchanged'});
    else {
      const tomlEol = current?.includes('\r\n') ? '\r\n' : '\n';
      await write(file, (current === null ? '' : current.replace(/(?:\r?\n)*$/, tomlEol + tomlEol)) + `[[plugins]]${tomlEol}  ${entry}${tomlEol}`);
      changes.push({file, action: current === null ? 'created' : 'updated: lists the plug-in'});
    }
    next.push('netlify build (or a deploy) writes a .jxl beside each published JPEG and PNG and the edge function that serves them.');
  },
  async void(cwd, {next}) {
    next.push("in a page: import {uploadImage} from '<path to>/src/jxl-upload.mjs'; const {url} = await uploadImage(file); then <img src={url}>");
  },
};

