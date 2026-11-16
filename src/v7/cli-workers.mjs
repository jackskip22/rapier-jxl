// SPDX-License-Identifier: MIT
import {readFile, access} from 'node:fs/promises';
import {join, basename, dirname, relative} from 'node:path';
import {installs, importsAs} from './package-name.mjs';
import {readManifest} from './project-files.mjs';
import {writeProjectEdits, removeProjectEdits} from './project-edits.mjs';
import {COMMAND} from './package-name.mjs';
import {cliError as fail, cliArgs} from './cli-error.mjs';

export const ADD_WORKERS_HELP = `npx ${COMMAND} add workers [--paid] [--route example.com/*] [--dry-run] [--json]

Serves the site's JPEGs and PNGs as JPEG XL to browsers that ask, from a Cloudflare Worker. On Workers Free it serves
the JPEG XL files made before (npx ${COMMAND} <folder> writes photo.jxl beside photo.jpg) and the original otherwise.
--paid (Workers Paid) also makes the missing ones in the Worker and keeps them in R2.
In a Worker project's folder it adds jxl-worker.mjs and the dependency; in an empty folder, --route names the site and
a new wrangler.jsonc is written.`;

const WORKER = 'jxl-worker.mjs', CONFIGS = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'];
const exists = path => access(path).then(() => true, () => false);
const json = value => JSON.stringify(value, null, 2) + '\n';

export async function runAddWorkers(args, {cwd, version, name, stdout, template}) {
  args = cliArgs(args);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { stdout(ADD_WORKERS_HELP); return; }
  let route, plan, dryRun = false, asJson = false;
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    if (arg === '--route' && route === undefined && args[i + 1] && !String(args[i + 1]).startsWith('-')) route = String(args[++i]);
    else if ((arg === '--paid' || arg === '--free') && plan === undefined) plan = arg.slice(2);
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--json') asJson = true;
    else throw fail('JXL_OPTIONS', `Unknown option ${arg}`, `run npx ${COMMAND} add workers --help`);
  }
  if (template === undefined) {
    for (const url of [new URL('../examples/workers/jxl-worker.mjs', import.meta.url), new URL('./examples/workers/jxl-worker.mjs', import.meta.url)])
      try { template = await readFile(url, 'utf8'); break; } catch {}
    if (template === undefined) throw fail('JXL_SETUP', 'The installed rapier-jxl package is incomplete', `reinstall ${COMMAND}`);
  }
  const report = await addWorkers({cwd, version, name, route, plan, dryRun, template});
  if (asJson) stdout(JSON.stringify({type: 'add', host: 'workers', dryRun, changed: report.changed ?? report['would change'] ?? [], kept: report.kept, next: report.next}));
  else for (const [what, list] of Object.entries(report)) for (const line of list) stdout(`${what}: ${line}`);
}

export async function addWorkers({cwd, version, name: own = 'rapier-jxl', route, plan = 'free', dryRun = false, template}) {
  const changed = [], kept = [], next = [], writes = [];
  const setup = (message, fix) => fail('JXL_SETUP', message, fix), site = (await readManifest(cwd, setup))?.manifest ?? null;
  template = importsAs(template, own);
  const cpuMs = 30000, paid = plan === 'paid';

  const workerPath = join(cwd, WORKER);
  if (!await exists(workerPath)) { writes.push([workerPath, template]); changed.push(`${WORKER} written`); }
  else if (await readFile(workerPath, 'utf8') === template) kept.push(`${WORKER} unchanged`);
  else kept.push(`${WORKER} has your edits and stays as it is; the current template is examples/workers/jxl-worker.mjs in rapier-jxl`);

  const found = (await Promise.all(CONFIGS.map(async name => await exists(join(cwd, name)) && name))).find(Boolean);
  const name = basename(cwd).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'site';
  const bucket = `${name}-jxl`.slice(0, 63);
  if (!found) {
    if (!route) throw fail('JXL_OPTIONS', 'No wrangler config here, and no site named',
      'pass --route example.com/* with the site\'s address, or run this in the folder of the site\'s Worker project');
    const zone = route.replace(/^https?:\/\//, '').split('/')[0].replace(/^\*\.?/, '');
    writes.push([join(cwd, 'wrangler.jsonc'), json({name: `${name}-jxl`, main: WORKER, compatibility_date: '2026-10-01',
      routes: [{pattern: route, zone_name: zone}], ...paid && {r2_buckets: [{binding: 'JXL', bucket_name: bucket}],
        vars: {JXL_CONVERT: 'on', JXL_CPU_MS: String(cpuMs)}, limits: {cpu_ms: cpuMs}}})]);
    changed.push(`wrangler.jsonc written for ${route}`);
    if (paid) next.push(`npx wrangler r2 bucket create ${bucket}`);
  } else {
    let config = null;
    if (found !== 'wrangler.toml') try {
      const parsed = JSON.parse((await readFile(join(cwd, found), 'utf8')).replace(/^\ufeff/, ''));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed;
    } catch {}
    const wanted = {main: WORKER, r2: {binding: 'JXL', bucket_name: bucket}, vars: {JXL_CONVERT: 'on', JXL_CPU_MS: String(cpuMs)}};
    if (!config) {
      next.push(`in ${found}: main = "${WORKER}" (or wrap an existing handler: import {jxl} from './${WORKER}'; export default jxl(handler))` +
        (paid ? `, an R2 binding JXL (bucket ${bucket}), vars JXL_CONVERT = "on" and JXL_CPU_MS = "${cpuMs}", limits.cpu_ms = ${cpuMs}` : '') +
        `; with static assets, assets.binding = "ASSETS" and run_worker_first = true`);
    } else {
      const before = JSON.stringify(config), what = [];
      if (config.main && config.main.replace(/^\.\//, '') !== WORKER) {
        const from = relative(dirname(config.main), WORKER).replace(/\\/g, '/');
        next.push(`in ${config.main}: import {jxl} from '${from.startsWith('.') ? from : './' + from}'; and export default jxl(<the existing handler>)`);
      } else if (config.main !== WORKER) config.main = WORKER, what.push('main');
      if (config.assets && config.main === WORKER) {
        if ((config.assets.binding ?? 'ASSETS') !== 'ASSETS')
          next.push(`the assets binding is ${config.assets.binding}: rename it ASSETS, which ${WORKER} reads`);
        else if (config.assets.binding !== 'ASSETS' || config.assets.run_worker_first === undefined)
          config.assets.binding = 'ASSETS', config.assets.run_worker_first ??= true, what.push('the ASSETS binding');
      }
      if (paid) {
        const buckets = config.r2_buckets ??= [];
        if (!buckets.some(b => b.binding === 'JXL'))
          buckets.push(wanted.r2), what.push(`R2 binding JXL`), next.push(`npx wrangler r2 bucket create ${bucket}`);
        if (config.vars?.JXL_CONVERT === undefined || config.vars?.JXL_CPU_MS === undefined)
          config.vars = {...wanted.vars, ...config.vars}, what.push('JXL_CONVERT and JXL_CPU_MS');
        if (config.limits?.cpu_ms === undefined) config.limits = {...config.limits, cpu_ms: cpuMs}, what.push('limits.cpu_ms');
      }
      if (JSON.stringify(config) === before) kept.push(`${found} unchanged`);
      else { writes.push([join(cwd, found), json(config)]); changed.push(`${found}: ${what.join(', ')}`); }
    }
  }

  const packagePath = join(cwd, 'package.json');
  const manifest = site ? structuredClone(site) : {private: true, type: 'module'};
  if (installs(manifest, own)) kept.push('package.json unchanged');
  else {
    manifest.dependencies = {...manifest.dependencies, [own]: `^${version}`};
    writes.push([packagePath, json(manifest)]); changed.push(`package.json: ${own} ^${version}`); next.unshift('npm install');
  }
  if (!paid) next.push(`npx ${COMMAND} <the site's pictures folder>: a photo.jxl beside each photo.jpg and PNG, deployed with the site`);
  next.push('npx wrangler deploy');
  await writeProjectEdits(cwd, 'workers', version, new Map(writes.map(([path, text]) => [relative(cwd, path).split('\\').join('/'), text])), {dryRun});
  return {[dryRun ? 'would change' : 'changed']: changed, kept, next};
}

export const runRemoveWorkers = (args, context) => removeProjectEdits('workers', args, context);

