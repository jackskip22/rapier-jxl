// SPDX-License-Identifier: MIT
import {readFile, access} from 'node:fs/promises';
import {join, basename, dirname, relative, resolve, isAbsolute, sep} from 'node:path';
import {installs, importsAs, COMMAND} from './package-name.mjs';
import {readManifest, jsonc, insideProject, readIfAny, refuseLinks, refuseReadOnly} from './project-files.mjs';
import {writeProjectEdits, removeProjectEdits} from './project-edits.mjs';
import {parseConfig} from './config-parse.mjs';
import {readPackedSpaceSaver} from './space-saver-pack.mjs';
import {cliError as fail, cliArgs} from './cli-error.mjs';

export const ADD_WORKERS_HELP = `npx ${COMMAND} add workers [--paid] [--space-saver] [--route example.com/*] [--dry-run] [--json]

Serves the site's JPEGs and PNGs as JPEG XL to browsers that ask, from a Cloudflare Worker. On Workers Free it serves
the JPEG XL files made before and the original otherwise. Run npx ${COMMAND} <folder> --keep-extension to write
photo.jpg.jxl beside photo.jpg.
--paid (Workers Paid) also makes the missing ones in the Worker and keeps them in R2.
--space-saver (with --paid) stores JPEGs only as exact JPEG XL and rebuilds the original JPEG for browsers without
JPEG XL and for share previews, with Cache-Control and Vary: Accept. Other formats keep their originals.
In a Worker project's folder it adds jxl-worker.mjs and the dependency. In an empty folder, --route names the site and
a new wrangler.jsonc is written.`;

const WORKER = 'jxl-worker.mjs', SPACE_SAVER = 'jxl-space-saver.mjs';
const CONFIGS = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'];
const exists = path => access(path).then(() => true, () => false);
const badBucket = b => !isPlain(b) || ['binding', 'bucket_name'].some(key => b[key] !== undefined && typeof b[key] !== 'string');
const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const zoneOf = route => route.replace(/^https?:\/\//, '').split('/')[0].replace(/^\*\.?/, '');
const json = (value, eol = '\n') => (JSON.stringify(value, null, 2) + '\n').replace(/\n/g, eol);

function editJson(source, before, after, file) {
  let root;
  try { root = parseConfig('(' + source + '\n)').body[0].expression; }
  catch { throw fail('JXL_SETUP', `${file} cannot be edited safely`, `add the required fields to ${file} by hand`); }
  const edits = [], equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const visit = (node, was, value) => {
    if (equal(was, value)) return;
    if (node.type === 'ObjectExpression' && isPlain(was) && isPlain(value)
      && Object.keys(was).every(key => Object.hasOwn(value, key))) {
      const properties = new Map(node.properties.map(property => [property.key.value, property])), added = [];
      for (const [key, entry] of Object.entries(value)) {
        if (Object.hasOwn(was, key)) visit(properties.get(key).value, was[key], entry);
        else added.push(JSON.stringify(key) + ': ' + JSON.stringify(entry));
      }
      if (added.length) {
        const first = node.properties[0], gap = first ? source.slice(node.start, first.start - 1) : '';
        const at = first ? first.start - 1 : node.start, separator = gap || ' ';
        edits.push({start: at, end: at, text: added.join(',' + separator) + (first ? ',' + separator : '')});
      }
    } else if (node.type === 'ArrayExpression' && Array.isArray(was) && Array.isArray(value)
      && value.length >= was.length && was.every((entry, i) => equal(entry, value[i]))) {
      const first = node.elements[0], gap = first ? source.slice(node.start, first.start - 1) : ' ';
      const at = node.elements.length ? node.elements.at(-1).end - 1 : node.start;
      const added = value.slice(was.length).map(entry => JSON.stringify(entry)).join(',' + gap);
      if (added) edits.push({start: at, end: at, text: (was.length ? ',' + gap : '') + added});
    } else edits.push({start: node.start - 1, end: node.end - 1, text: JSON.stringify(value)});
  };
  visit(root, before, after);
  for (const {start, end, text} of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, start) + text + source.slice(end);
  return source;
}

export async function runAddWorkers(args, {cwd, version, name, stdout, template, spaceSaverTemplate}) {
  args = cliArgs(args);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { stdout(ADD_WORKERS_HELP); return; }
  let route, plan, spaceSaver = false, dryRun = false, asJson = false;
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    if (arg === '--route' && route === undefined && args[i + 1] && !String(args[i + 1]).startsWith('-')) route = String(args[++i]);
    else if ((arg === '--paid' || arg === '--free') && plan === undefined) plan = arg.slice(2);
    else if (arg === '--space-saver') spaceSaver = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--json') asJson = true;
    else throw fail('JXL_OPTIONS', `unknown option: ${arg}`, `run: npx ${COMMAND} add workers --help`);
  }
  if (spaceSaver && plan !== 'paid')
    throw fail('JXL_OPTIONS', '--space-saver requires --paid', `run: npx ${COMMAND} add workers --paid --space-saver`);
  const shipped = template === undefined;
  if (shipped) {
    for (const url of [new URL('../examples/workers/jxl-worker.mjs', import.meta.url), new URL('./examples/workers/jxl-worker.mjs', import.meta.url)])
      try { template = await readFile(url, 'utf8'); break; } catch {}
    if (template === undefined) throw fail('JXL_SETUP', 'The installed jpegxl package is incomplete', `reinstall ${COMMAND}`);
  }
  if ((shipped || spaceSaver) && spaceSaverTemplate === undefined)
    spaceSaverTemplate = await readPackedSpaceSaver(name ?? 'rapier-jxl');
  const report = await addWorkers({cwd, version, name, route, plan, spaceSaver, dryRun, template, spaceSaverTemplate});
  if (asJson) stdout(JSON.stringify({type: 'add', host: 'workers', dryRun, changed: report.changed ?? report['would change'] ?? [], kept: report.kept, next: report.next}));
  else for (const [what, list] of Object.entries(report)) for (const line of list) stdout(`${what}: ${line}`);
}

export async function addWorkers({cwd, version, name: own = 'rapier-jxl', route, plan = 'free', spaceSaver = false, dryRun = false, template, spaceSaverTemplate}) {
  if (spaceSaver && plan !== 'paid')
    throw fail('JXL_OPTIONS', '--space-saver requires --paid', `run: npx ${COMMAND} add workers --paid --space-saver`);
  const changed = [], kept = [], next = [], writes = [];
  const setup = (message, fix) => fail('JXL_SETUP', message, fix);
  await refuseLinks(cwd, ['package.json', ...CONFIGS, WORKER, SPACE_SAVER], setup);
  const loadedPkg = await readManifest(cwd, setup), site = loadedPkg?.manifest ?? null;
  if (loadedPkg) await refuseReadOnly(join(cwd, 'package.json'), 'package.json');
  for (const k of ['dependencies', 'devDependencies'])
    if (site?.[k] !== undefined && !isPlain(site[k])) throw setup(`package.json: ${k} is not an object`, 'fix package.json');
  template = importsAs(template, own);
  const cpuMs = 30000, paid = plan === 'paid';

  const workerPath = join(cwd, WORKER);
  if (!await exists(workerPath)) { writes.push([workerPath, template]); changed.push(`${WORKER} written`); }
  else if ((await readFile(workerPath, 'utf8')).replace(/\r\n/g, '\n') === template) kept.push(`${WORKER} unchanged`);
  else kept.push(`${WORKER} has your edits and stays as it is (current template: examples/workers/jxl-worker.mjs in jpegxl)`);

  if (spaceSaver || spaceSaverTemplate !== undefined) {
    const saverText = importsAs(spaceSaverTemplate ?? await readPackedSpaceSaver(own), own);
    const saverPath = join(cwd, SPACE_SAVER);
    if (!await exists(saverPath)) { writes.push([saverPath, saverText]); changed.push(`${SPACE_SAVER} written`); }
    else if ((await readFile(saverPath, 'utf8')).replace(/\r\n/g, '\n') === saverText) kept.push(`${SPACE_SAVER} unchanged`);
    else kept.push(`${SPACE_SAVER} has your edits and stays as it is`);
  }

  const found = (await Promise.all(CONFIGS.map(async name => await exists(join(cwd, name)) && name))).find(Boolean);
  const name = basename(cwd).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'site';
  const bucket = `${name}-jxl`.slice(0, 63);
  const paidVars = {JXL_CONVERT: 'on', JXL_CPU_MS: String(cpuMs), ...(spaceSaver && {JXL_SPACE_SAVER: 'on'})};
  if (!found) {
    if (!route) throw fail('JXL_OPTIONS', 'wrangler: config or --route required',
      'use: --route example.com/* or Worker project');
    writes.push([join(cwd, 'wrangler.jsonc'), json({name: `${name}-jxl`, main: WORKER, compatibility_date: '2026-10-01',
      routes: [{pattern: route, zone_name: zoneOf(route)}], ...paid && {r2_buckets: [{binding: 'JXL', bucket_name: bucket}],
        vars: paidVars, limits: {cpu_ms: cpuMs}}})]);
    changed.push(`wrangler.jsonc written for ${route}`);
    if (paid) next.push(`npx wrangler r2 bucket create ${bucket}`);
  } else {
    let config = null, rawCfg, commented = false;
    await refuseReadOnly(join(cwd, found), found);
    if (found !== 'wrangler.toml') {
      const [at] = await insideProject(cwd, [found], setup);
      rawCfg = await readIfAny(at, 'utf8', found);
      if (rawCfg === null) throw setup(`${found} disappeared while add ran`, 'run add again');
      let parsed, isJson = false;
      try { parsed = JSON.parse(rawCfg.replace(/^\ufeff/, '')); isJson = true; } catch {
        try { parsed = jsonc(rawCfg); isJson = commented = true; } catch { throw setup(`${found} could not be read as JSON`, `fix ${found}, then run add again`); }
      }
      if (isJson) {
        if (!isPlain(parsed)) throw setup(`${found} is not a JSON object`, `make ${found} one {...} object`);
        config = parsed;
      }
    }
    const wanted = {main: WORKER, r2: {binding: 'JXL', bucket_name: bucket}, vars: paidVars};
    if (!config) {
      const varsDesc = spaceSaver
        ? `vars JXL_CONVERT = "on", JXL_CPU_MS = "${cpuMs}" and JXL_SPACE_SAVER = "on"`
        : `vars JXL_CONVERT = "on" and JXL_CPU_MS = "${cpuMs}"`;
      next.push(`in ${found}: main = "${WORKER}" (or wrap an existing handler: import {jxl} from './${WORKER}'; export default jxl(handler))` +
        (route ? `, routes = [{pattern = "${route}", zone_name = "${zoneOf(route)}"}]` : '') +
        (paid ? `, an R2 binding JXL (bucket ${bucket}), ${varsDesc}, limits.cpu_ms = ${cpuMs}` : '') +
        `, and with static assets set assets.binding = "ASSETS" and run_worker_first = true`);
    } else {
      if (config.main !== undefined && (typeof config.main !== 'string' || !config.main.trim()))
        throw setup(`main in ${found} is not a file path`, `set main in ${found} to the Worker's entry file, or remove it`);
      if (config.assets !== undefined && !isPlain(config.assets))
        throw setup(`assets in ${found} is not an object`, `fix assets in ${found}`);
      if (paid) {
        if (config.r2_buckets !== undefined && (!Array.isArray(config.r2_buckets) || config.r2_buckets.some(badBucket)))
          throw setup(`r2_buckets in ${found} is invalid`, `make r2_buckets an array of objects in ${found}`);
        if (config.vars !== undefined && !isPlain(config.vars))
          throw setup(`vars in ${found} is not an object`, `fix vars in ${found}`);
        if (config.limits !== undefined && !isPlain(config.limits))
          throw setup(`limits in ${found} is not an object`, `fix limits in ${found}`);
      }
      const before = JSON.stringify(config), what = [];
      const main = typeof config.main === 'string' && config.main ? relative(cwd, resolve(cwd, config.main)) : null;
      if (main !== null && (main === '' || main === '..' || main.startsWith('..' + sep) || isAbsolute(main)))
        throw setup(`main in ${found} is outside this folder (${config.main})`, `run add workers in the folder that holds ${config.main}`);
      if (config.main && main.split(sep).join('/') !== WORKER) {
        const from = relative(dirname(resolve(cwd, main)), resolve(cwd, WORKER)).replace(/\\/g, '/');
        next.push(`in ${config.main}: import {jxl} from '${from.startsWith('.') ? from : './' + from}'; and export default jxl(<the existing handler>)`);
      } else if (config.main !== WORKER) config.main = WORKER, what.push('main');
      if (config.assets && config.main === WORKER) {
        if ((config.assets.binding ?? 'ASSETS') !== 'ASSETS')
          next.push(`the assets binding is ${config.assets.binding}: rename it ASSETS, which ${WORKER} reads`);
        else if (config.assets.binding !== 'ASSETS' || config.assets.run_worker_first === undefined)
          config.assets.binding = 'ASSETS', config.assets.run_worker_first ??= true, what.push('the ASSETS binding');
      }
      if (route) {
        if (config.routes !== undefined && !Array.isArray(config.routes)) throw setup(`routes in ${found} is not an array`, `fix routes in ${found}`);
        if (!(config.routes ?? []).some(r => (typeof r === 'string' ? r : r?.pattern) === route))
          config.routes = [...config.routes ?? [], {pattern: route, zone_name: zoneOf(route)}], what.push(`the route ${route}`);
      }
      if (paid) {
        const buckets = config.r2_buckets ??= [];
        if (!buckets.some(b => b.binding === 'JXL'))
          buckets.push(wanted.r2), what.push('R2 binding JXL'), next.push(`npx wrangler r2 bucket create ${bucket}`);
        const missingConvert = config.vars?.JXL_CONVERT === undefined || config.vars?.JXL_CPU_MS === undefined;
        const missingSaver = spaceSaver && config.vars?.JXL_SPACE_SAVER === undefined;
        if (missingConvert || missingSaver) {
          config.vars = {...wanted.vars, ...config.vars};
          if (missingConvert) what.push('JXL_CONVERT and JXL_CPU_MS');
          if (missingSaver) what.push("JXL_SPACE_SAVER");
        }
        if (config.limits?.cpu_ms === undefined) config.limits = {...config.limits, cpu_ms: cpuMs}, what.push('limits.cpu_ms');
      }
      if (JSON.stringify(config) === before) kept.push(`${found} unchanged`);
      else if (commented) {
        const was = JSON.parse(before), lines = Object.keys(config).filter(key => JSON.stringify(config[key]) !== JSON.stringify(was[key]))
          .map(key => `"${key}": ${JSON.stringify(config[key])}`);
        kept.push(`${found} has comments and stays as it is`);
        next.push(`in ${found}, set ${lines.join(', ')}`);
      } else { writes.push([join(cwd, found), editJson(rawCfg, JSON.parse(before), config, found)]); changed.push(`${found}: ${what.join(', ')}`); }
    }
  }

  const packagePath = join(cwd, 'package.json');
  const manifest = site ? structuredClone(site) : {private: true, type: 'module'};
  if (installs(manifest, own)) kept.push('package.json unchanged');
  else {
    manifest.dependencies = {...manifest.dependencies, [own]: `^${version}`};
    writes.push([packagePath, loadedPkg ? editJson(loadedPkg.text, site, manifest, 'package.json') : json(manifest)]);
    changed.push(`package.json: ${own} ^${version}`); next.unshift('npm install');
  }
  if (!paid) next.push(`npx ${COMMAND} <the site's pictures folder> --keep-extension: a .jxl beside each original, deployed with the site`);
  else if (spaceSaver) next.push(`node ${SPACE_SAVER} <the site's pictures folder> (and node ${SPACE_SAVER} --restore <folder> to rebuild originals)`);
  next.push('npx wrangler deploy');
  await writeProjectEdits(cwd, 'workers', version, new Map(writes.map(([path, text]) => [relative(cwd, path).split('\\').join('/'), text])), {dryRun});
  return {[dryRun ? 'would change' : 'changed']: changed, kept, next};
}

export const runRemoveWorkers = (args, context) => removeProjectEdits('workers', args, context);
