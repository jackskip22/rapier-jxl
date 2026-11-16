// SPDX-License-Identifier: MIT
import {readFile, rm, rmdir, stat} from 'node:fs/promises';
import {dirname, join, basename, relative, isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {atomicWrite, insideProject, readManifest} from './project-files.mjs';
import {COMMAND, importsAs, installs, ownName} from './package-name.mjs';
import {cliError as fail, cliArgs} from './cli-error.mjs';

const CONFIGS = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'], DATE = '2026-10-01', CPU_MS = 30000;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => readFile(path).catch(error => { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; throw error; });
const present = async path => (await stat(path).catch(() => null)) !== null;
const posix = path => path.split('\\').join('/');
const setup = (message, fix) => fail('JXL_SETUP', message, fix);
const json = value => JSON.stringify(value, null, 2) + '\n';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const PLACES = {
  r2: {
    line: 'A Cloudflare R2 bucket: a JPEG XL beside every JPEG and PNG put in it, large ones as a Workflow, reads answered by Accept.',
    looked: 'a wrangler config (wrangler.jsonc, wrangler.json or wrangler.toml), or wrangler in package.json',
    kind: 'a Cloudflare Worker',
    files: [['jxl-r2.mjs', 'r2/jxl-r2.mjs']],
    usage: '[--bucket <name>] [--dry-run] [--json]',
  },
  agents: {
    line: 'A Cloudflare Agents SDK project: JPEG XL tools for agents, as an MCP server and for an Agent class; pictures stay in R2.',
    looked: 'package.json that depends on agents, and a wrangler config',
    kind: 'a Cloudflare Agents SDK',
    files: [['jxl-tools.mjs', 'agents/jxl-tools.mjs'], ['jxl-mcp.mjs', 'agents/jxl-mcp.mjs'], ['jxl-agent.mjs', 'agents/jxl-agent.mjs']],
    usage: '[--bucket <name>] [--dry-run] [--json]',
  },
};
export const CLOUDFLARE_PLACES = Object.keys(PLACES);
export const cloudflareLines = () => CLOUDFLARE_PLACES.map(name => ({name, line: PLACES[name].line}));

const HELP = place => `Usage: ${COMMAND} add ${place} ${PLACES[place].usage}
       ${COMMAND} remove ${place} [--dry-run] [--json]

${PLACES[place].line}
It looks for ${PLACES[place].looked}, writes ${PLACES[place].files.map(([name]) => name).join(', ')}, and adds its lines to the wrangler config
and the dependency to package.json where that is safe; what it leaves to you it prints. Running it again changes nothing;
a file you edited is left as it is. remove deletes exactly what add wrote. Nothing is fetched.`;

async function examples() {
  for (const url of [new URL('./examples/', import.meta.url), new URL('../examples/', import.meta.url)])
    if (await present(join(fileURLToPath(url), 'r2'))) return fileURLToPath(url);
  throw setup('The installed package is incomplete', `reinstall ${COMMAND}`);
}

function flags(place, verb, args) {
  args = cliArgs(args);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return {help: true};
  const out = {dryRun: false, json: false};
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--bucket' && verb === 'add' && out.bucket === undefined && args[i + 1] && !String(args[i + 1]).startsWith('-')) out.bucket = String(args[++i]);
    else throw fail('JXL_OPTIONS', `Unknown option ${arg}`, `run npx ${COMMAND} ${verb} ${place} --help`);
  }
  if (out.bucket !== undefined && !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(out.bucket)) throw fail('JXL_OPTIONS', `"${out.bucket}" is not a bucket name`, 'use 3 to 63 lowercase letters, digits and hyphens');
  return out;
}

async function configOf(cwd) {
  const file = (await Promise.all(CONFIGS.map(async name => await present(join(cwd, name)) && name))).find(Boolean);
  if (!file) return {file: null, config: null};
  let config = null;
  if (file !== 'wrangler.toml') try { config = JSON.parse(await readFile(join(cwd, file), 'utf8')); } catch {}
  return {file, config};
}
const dig = (object, path) => path.reduce((at, key) => at?.[key], object);
function put(config, op) {
  let at = config;
  for (const key of op.path.slice(0, -1)) at = at[key] ??= {};
  const last = op.path.at(-1);
  if (op.op === 'push') { const list = at[last] ??= []; if (!list.some(item => same(item, op.value))) list.push(op.value); }
  else if (at[last] === undefined) at[last] = op.value;
}
function unput(config, op) {
  const parents = [config];
  for (const key of op.path.slice(0, -1)) parents.push(parents.at(-1)?.[key]);
  const at = parents.at(-1), last = op.path.at(-1);
  if (!at || typeof at !== 'object') return false;
  if (op.op === 'push') {
    const list = at[last], i = Array.isArray(list) ? list.findIndex(item => same(item, op.value)) : -1;
    if (i < 0) return false;
    list.splice(i, 1);
    if (!list.length) delete at[last];
  } else if (same(at[last], op.value)) delete at[last]; else return false;
  for (let i = op.path.length - 2; i >= 0; i--) { const parent = parents[i]; if (parent[op.path[i]] && !Object.keys(parent[op.path[i]]).length) delete parent[op.path[i]]; else break; }
  return true;
}
const OPS = ['r2_buckets', 'queues.consumers', 'workflows', 'limits.cpu_ms', 'compatibility_flags', 'main'];
const badRel = p => typeof p !== 'string' || !p || p.includes('\0') || p.includes('\\') || isAbsolute(p) || p.split('/').some(s => !s || s === '.' || s === '..');
async function recordOf(cwd, recordPath, place) {
  const [land] = await insideProject(cwd, [recordPath], setup), raw = (await read(land))?.toString();
  if (raw === undefined || raw === null) return null;
  const bad = what => setup(`${recordPath} ${what}`, `fix or delete ${recordPath}`);
  let record; try { record = JSON.parse(raw); } catch { throw bad('is not JSON'); }
  if (!record || typeof record !== 'object' || Array.isArray(record) || record.place !== place) throw bad(`is not the record of add ${place}`);
  if (!record.files || typeof record.files !== 'object' || Array.isArray(record.files)) throw bad('has no files');
  const names = new Set(PLACES[place].files.map(([name]) => name));
  if (record.created !== undefined && record.created !== 'wrangler.jsonc') throw bad(`lists an unmanaged file (${record.created})`);
  for (const [path, digest] of Object.entries(record.files))
    if (badRel(path) || !(names.has(basename(path)) || path === record.created) || typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) throw bad(`lists an unmanaged file (${path})`);
  for (const [path, kept] of Object.entries(record.originals ?? {}))
    if (![record.config?.file, 'package.json'].includes(path) || typeof kept?.before !== 'string' || Buffer.from(kept.before, 'base64').toString('base64') !== kept.before ||
        typeof kept.after !== 'string' || !/^[0-9a-f]{64}$/.test(kept.after)) throw bad(`has an invalid original (${path})`);
  if (record.dirs !== undefined && (!Array.isArray(record.dirs) || record.dirs.some(dir => badRel(dir) || !Object.keys(record.files).some(path => path.startsWith(dir + '/')))))
    throw bad('lists an unmanaged folder');
  const config = record.config;
  if (config !== undefined && (!config || !CONFIGS.includes(config.file) || !Array.isArray(config.ops) ||
      !config.ops.every(op => ['push', 'set'].includes(op?.op) && Array.isArray(op.path) && OPS.includes(op.path.join('.'))))) throw bad('has an invalid config entry');
  return record;
}
const hasPush = (config, path, test) => dig(config, path)?.some?.(test);

export async function runAddCloudflare(place, args, {cwd, version, stdout, name: own, templates}) {
  const given = flags(place, 'add', args);
  if (given.help) { stdout(HELP(place)); return; }
  const {dryRun, json: asJson} = given, spec = PLACES[place], manifest = (await readManifest(cwd, setup))?.manifest ?? null;
  own ??= await ownName();
  const {file: configFile, config} = await configOf(cwd), deps = {...manifest?.dependencies, ...manifest?.devDependencies};
  const found = place === 'agents' ? deps.agents && configFile : configFile || deps.wrangler;
  if (!found) throw setup(`This folder is not ${spec.kind} project: looked for ${spec.looked}`, `run npx ${COMMAND} add ${place} in the project's folder`);

  const recordPath = `.rapier-jxl-${place}.json`, before = await recordOf(cwd, recordPath, place);
  const changes = [], writes = new Map(), files = {...before?.files}, next = [], ops = [...before?.config?.ops ?? []];
  if (config?.main !== undefined && (typeof config.main !== 'string' || !config.main.trim()))
    throw setup(`main in ${configFile} is not a file path`, `set main to the Worker's entry file, or remove it`);
  const dir = place === 'agents' && config?.main && dirname(config.main) !== '.' ? dirname(config.main) : '';
  const root = templates ? null : await examples();
  const project = (manifest?.name ?? basename(cwd)).toLowerCase().replace(/^@[^/]+\//, '').replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'site';

  for (const [name, source] of spec.files) {
    const path = posix(join(dir, name)), text = importsAs(templates?.[name] ?? await readFile(join(root, source), 'utf8'), own), bytes = Buffer.from(text);
    const current = await read(join(cwd, path)), digest = sha(bytes), recorded = before?.files?.[path];
    if (current === null) { writes.set(path, bytes); files[path] = digest; changes.push({file: path, action: 'created'}); }
    else if (sha(current) === digest) { files[path] = digest; changes.push({file: path, action: 'unchanged'}); }
    else if (recorded && sha(current) === recorded) { writes.set(path, bytes); files[path] = digest; changes.push({file: path, action: 'updated'}); }
    else changes.push({file: path, action: recorded ? 'left (edited)' : 'left (already there)'});
  }

  const entry = posix(join(dir, spec.files[0][0]));
  const bucket = given.bucket ?? config?.r2_buckets?.find(b => b.binding === 'JXL_BUCKET')?.bucket_name ??
    (config?.r2_buckets?.length === 1 ? config.r2_buckets[0].bucket_name : undefined) ?? `${project}-images`.slice(0, 63).replace(/-+$/, '');
  if (config?.r2_buckets?.length > 1 && !given.bucket && !config.r2_buckets.some(b => b.binding === 'JXL_BUCKET'))
    throw fail('JXL_OPTIONS', 'The config has several R2 buckets', 'name the one to use: --bucket <name>');
  const wanted = [{op: 'push', path: ['r2_buckets'], value: {binding: 'JXL_BUCKET', bucket_name: bucket}}];
  if (place === 'r2') wanted.push(
    {op: 'push', path: ['queues', 'consumers'], value: {queue: `${bucket}-jxl`, max_batch_size: 1, max_retries: 3}},
    {op: 'push', path: ['workflows'], value: {name: `${project}-jxl`, binding: 'JXL_WORKFLOW', class_name: 'JxlWorkflow'}},
    {op: 'set', path: ['limits', 'cpu_ms'], value: CPU_MS});
  else wanted.push({op: 'push', path: ['compatibility_flags'], value: 'nodejs_compat'});
  const guide = `${bucket}: ${wanted.map(op => `${op.path.join('.')} ${JSON.stringify(op.value)}`).join('; ')}`;
  let created = null;
  if (!configFile) {
    const fresh = {name: `${project}-jxl`, main: entry, compatibility_date: DATE};
    for (const op of wanted) put(fresh, op);
    writes.set('wrangler.jsonc', Buffer.from(json(fresh))); files['wrangler.jsonc'] = sha(json(fresh)); created = 'wrangler.jsonc';
    changes.push({file: 'wrangler.jsonc', action: 'created'});
  } else if (!config) {
    next.push(`in ${configFile}, with bucket ${guide}${place === 'r2' ? `; main = "${entry}"` : ''}`);
  } else {
    const edited = structuredClone(config), done = [];
    if (place === 'r2') {
      if (!edited.main) { edited.main = entry; done.push({op: 'set', path: ['main'], value: entry}); }
      else if (posix(edited.main).replace(/^\.\//, '') !== entry)
        next.push(`in ${edited.main}: import jxlR2, {JxlWorkflow} from '${(rel => rel.startsWith('.') ? rel : './' + rel)(posix(relative(dirname(edited.main), entry)))}'; export {JxlWorkflow}; and answer fetch and queue with jxlR2.fetch and jxlR2.queue (or call them from your own handlers)`);
    }
    for (const op of wanted) {
      const already = op.op === 'push' ? hasPush(edited, op.path, item => same(item, op.value)) : dig(edited, op.path) !== undefined;
      const named = op.op === 'push' && op.path[0] === 'r2_buckets' && edited.r2_buckets?.some(b => b.binding === 'JXL_BUCKET');
      if (!already && !named) { put(edited, op); done.push(op); }
    }
    if (done.length) {
      writes.set(configFile, Buffer.from(json(edited)));
      for (const op of done) if (!ops.some(old => old.op === op.op && same(old.path, op.path) && same(old.value, op.value))) ops.push(op);
      changes.push({file: configFile, action: `updated: ${done.map(op => op.path.join('.')).join(', ')}`});
    } else changes.push({file: configFile, action: 'unchanged'});
  }
  if (place === 'r2') next.push(`npx wrangler r2 bucket create ${bucket}`, `npx wrangler queues create ${bucket}-jxl`,
    `npx wrangler r2 bucket notification create ${bucket} --event-type object-create --queue ${bucket}-jxl`);
  else next.push("in the Worker's fetch: import {jxlMcp} from './jxl-mcp.mjs'; and if (new URL(request.url).pathname === '/mcp') return jxlMcp(request, env, ctx)",
    'in an AIChatAgent: import {jxlAgentTools} from its jxl-agent.mjs, and pass tools: jxlAgentTools(this.env) to streamText');
  if (place === 'agents') {
    const missing = ['@modelcontextprotocol/server', 'zod', 'ai'].filter(dep => !deps[dep]);
    if (missing.length) next.unshift(`npm install ${missing.join(' ')}`);
    if (!config?.r2_buckets?.some(b => b.binding === 'JXL_BUCKET') && config) next.push(`npx wrangler r2 bucket create ${bucket} (if it does not exist)`);
  }

  let dependency = before?.dependency ?? false;
  const edited = manifest ? structuredClone(manifest) : {private: true, type: 'module'};
  if (!installs(edited, own)) {
    edited.dependencies = {...edited.dependencies, [own]: `^${version}`};
    writes.set('package.json', Buffer.from(json(edited))); dependency = true; next.unshift('npm install');
    changes.push({file: 'package.json', action: `updated: ${own} ^${version}`});
  } else changes.push({file: 'package.json', action: 'unchanged'});

  const originals = {};
  for (const path of [configFile, 'package.json']) {
    const kept = before?.originals?.[path], current = path && await read(join(cwd, path));
    if (!path || !current) continue;
    const after = writes.has(path) ? sha(writes.get(path)) : sha(current);
    if (kept && sha(current) === kept.after) originals[path] = {before: kept.before, after};
    else if (!kept && writes.has(path) && !before?.config && !before?.dependency) originals[path] = {before: current.toString('base64'), after};
  }
  const dirs = new Set(before?.dirs ?? []);
  for (const path of writes.keys()) for (let dir = dirname(path); dir !== '.'; dir = dirname(dir)) if (!await present(join(cwd, dir))) dirs.add(posix(dir));
  const ordered = [[recordPath, Buffer.from(json({place, version, files, ...ops.length && {config: {file: configFile ?? created, ops}}, dependency, ...created && {created},
    ...Object.keys(originals).length && {originals}, ...dirs.size && {dirs: [...dirs].sort()}}))], ...writes];
  const lands = await insideProject(cwd, ordered.map(([path]) => path), setup);
  if (!dryRun) for (const [i, [, bytes]] of ordered.entries()) await atomicWrite(lands[i], bytes);
  if (asJson) { stdout(JSON.stringify({type: 'add', place, dryRun, changes, next})); return; }
  for (const c of changes) stdout(`${c.file}: ${dryRun && !/^(unchanged|left)/.test(c.action) ? 'would be ' : ''}${c.action}`);
  for (const n of next) stdout('next: ' + n);
}

export async function runRemoveCloudflare(place, args, {cwd, stdout, name: own}) {
  const given = flags(place, 'remove', args);
  if (given.help) { stdout(HELP(place)); return; }
  const {dryRun, json: asJson} = given, recordPath = `.rapier-jxl-${place}.json`;
  const record = await recordOf(cwd, recordPath, place);
  if (!record) throw setup(`There is nothing to remove: npx ${COMMAND} add ${place} has not written files here`, `delete the files yourself, or run npx ${COMMAND} add ${place} first`);
  own ??= await ownName();
  const changes = [], deletes = [], rewrites = new Map(), entries = Object.entries(record.files);
  const fileLands = await insideProject(cwd, entries.map(([path]) => path), setup);
  for (const [i, [path, digest]] of entries.entries()) {
    const current = await read(fileLands[i]);
    if (current === null) changes.push({file: path, action: 'already gone'});
    else if (sha(current) === digest) { deletes.push(path); changes.push({file: path, action: 'removed'}); }
    else changes.push({file: path, action: 'left (edited)'});
  }
  const restored = new Set();
  for (const [path, {before, after}] of Object.entries(record.originals ?? {})) {
    const current = await read((await insideProject(cwd, [path], setup))[0]);
    if (current && sha(current) === after) { rewrites.set(path, Buffer.from(before, 'base64')); restored.add(path); changes.push({file: path, action: 'restored'}); }
  }
  if (record.config && !record.created && !restored.has(record.config.file)) {
    const text = (await read((await insideProject(cwd, [record.config.file], setup))[0]))?.toString();
    let config = null; try { config = JSON.parse(text); } catch {}
    if (!config) changes.push({file: record.config.file, action: 'left (edited)'});
    else {
      let undone = 0; for (const op of [...record.config.ops].reverse()) if (unput(config, op)) undone++;
      if (undone === record.config.ops.length) { rewrites.set(record.config.file, Buffer.from(json(config))); changes.push({file: record.config.file, action: 'updated: lines removed'}); }
      else { if (undone) rewrites.set(record.config.file, Buffer.from(json(config))); changes.push({file: record.config.file, action: undone ? 'updated: lines removed; the rest were changed and stay' : 'left (edited)'}); }
    }
  }
  if (record.dependency && !restored.has('package.json')) {
    const loaded = await readManifest(cwd, setup), manifest = loaded?.manifest;
    if (manifest?.dependencies?.[own] === `^${record.version}`) {
      delete manifest.dependencies[own]; if (!Object.keys(manifest.dependencies).length) delete manifest.dependencies;
      rewrites.set('package.json', Buffer.from(json(manifest))); changes.push({file: 'package.json', action: `updated: no longer depends on ${own}`});
    } else changes.push({file: 'package.json', action: 'left (edited)'});
  }
  const lands = await insideProject(cwd, [...deletes, ...rewrites.keys(), recordPath], setup);
  if (!dryRun) {
    for (const land of lands.slice(0, deletes.length)) await rm(land, {force: true});
    for (const [i, bytes] of [...rewrites.values()].entries()) await atomicWrite(lands[deletes.length + i], bytes);
    if (!changes.some(c => c.action === 'left (edited)')) {
      await rm(lands.at(-1), {force: true});
      const dirLands = await insideProject(cwd, record.dirs ?? [], setup);
      for (const land of dirLands.sort((a, b) => b.length - a.length)) await rmdir(land).catch(() => {});
    }
  }
  if (asJson) { stdout(JSON.stringify({type: 'remove', place, dryRun, changes})); return; }
  for (const c of changes) stdout(`${c.file}: ${dryRun && /^(removed|updated|restored)/.test(c.action) ? 'would be ' : ''}${c.action}`);
}
