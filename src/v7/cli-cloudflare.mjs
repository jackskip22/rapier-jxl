// SPDX-License-Identifier: MIT
import {readFile, rm, rmdir, stat} from 'node:fs/promises';
import {dirname, join, basename, relative, isAbsolute} from 'node:path';
import {normalize} from 'node:path/posix';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {atomicWrite, insideProject, readManifest, jsonc, readIfAny, refuseReadOnly} from './project-files.mjs';
import {COMMAND, importsAs, installs, ownName} from './package-name.mjs';
import {readPackedSpaceSaver} from './space-saver-pack.mjs';
import {cliError as fail, cliArgs} from './cli-error.mjs';

const CONFIGS = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'], DATE = '2026-10-01', CPU_MS = 30000;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const matches = (bytes, digest) => bytes !== null && (sha(bytes) === digest ||
  !bytes.includes(0) && sha(Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')) === digest);
const eolOf = text => typeof text === 'string' && text.includes('\r\n') ? '\r\n' : '\n';
const badBucket = b => !isPlain(b) || ['binding', 'bucket_name'].some(key => b[key] !== undefined && typeof b[key] !== 'string');
const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const read = path => readIfAny(path);
const present = async path => (await stat(path).catch(() => null)) !== null;
const posix = path => path.split('\\').join('/');
const setup = (message, fix) => fail('JXL_SETUP', message, fix);
const json = (value, eol = '\n') => (JSON.stringify(value, null, 2) + '\n').replace(/\n/g, eol);
const same = (a, b) => JSON.stringify(a, null, 0) === JSON.stringify(b, null, 0);

const PLACES = {
  r2: {
    line: 'A Cloudflare R2 bucket: a JPEG XL beside every JPEG and PNG put in it, large ones as a Workflow, reads answered by Accept, with optional JPEG space saver.',
    looked: 'a wrangler config (wrangler.jsonc, wrangler.json or wrangler.toml), or wrangler in package.json',
    kind: 'a Cloudflare Worker',
    files: [['jxl-r2.mjs', 'r2/jxl-r2.mjs'], ['jxl-space-saver.mjs', '@space-saver']],
    usage: '[--bucket <name>] [--space-saver] [--dry-run] [--json]',
  },
  agents: {
    line: 'A Cloudflare Agents SDK project: JPEG XL tools for agents, as an MCP server and for an Agent class, keeping pictures in R2.',
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
and the dependency to package.json where that is safe. What it leaves to you it prints. Running it again changes nothing.
A file you edited is left as it is. remove deletes exactly what add wrote. Nothing is fetched.`;

async function examples() {
  for (const url of [new URL('./examples/', import.meta.url), new URL('../examples/', import.meta.url)])
    if (await present(join(fileURLToPath(url), 'r2'))) return fileURLToPath(url);
  throw setup('package: incomplete', `reinstall: ${COMMAND}`);
}

function flags(place, verb, args) {
  args = cliArgs(args);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return {help: true};
  const out = {dryRun: false, json: false, spaceSaver: false};
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--space-saver' && verb === 'add' && place === 'r2') out.spaceSaver = true;
    else if (arg === '--bucket' && verb === 'add' && out.bucket === undefined && args[i + 1] && !String(args[i + 1]).startsWith('-')) out.bucket = String(args[++i]);
    else throw fail('JXL_OPTIONS', `unknown option: ${arg}`, `run: npx ${COMMAND} ${verb} ${place} --help`);
  }
  if (out.bucket !== undefined && !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(out.bucket)) throw fail('JXL_OPTIONS', `bucket "${out.bucket}": 3-63 [a-z0-9-]`, 'use: 3-63 lowercase letters/digits/hyphens');
  return out;
}

async function configOf(cwd) {
  const file = (await Promise.all(CONFIGS.map(async name => await present(join(cwd, name)) && name))).find(Boolean);
  if (!file) return {file: null, config: null, seen: null, eol: '\n'};
  const rawText = await readFile(join(cwd, file), 'utf8'), text = rawText.replace(/^\ufeff/, ''), eol = eolOf(rawText);
  if (file === 'wrangler.toml') {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/#.*$/, '').trim();
      if (line.startsWith('[')) break;
      const m = line.match(/^main\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))$/);
      if (m) return {file, config: null, seen: {main: m[1] ?? m[2] ?? m[3]}, eol};
    }
    return {file, config: null, seen: {}, eol};
  }
  let config = null, seen = null;
  try { config = JSON.parse(text); } catch {
    try { seen = jsonc(text); } catch { throw setup(`${file} could not be read as JSON`, `fix ${file}, then run add again`); }
  }
  const read = config ?? seen;
  if (!isPlain(read)) throw setup(`${file} is not a JSON object`, `make ${file} one {...} object`);
  return {file, config, seen: read, eol};
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
const OPS = ['r2_buckets', 'queues.consumers', 'workflows', 'limits.cpu_ms', 'vars.JXL_SPACE_SAVER', 'compatibility_flags', 'main'];
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
  const {dryRun, json: asJson, spaceSaver} = given, spec = PLACES[place], loadedPkg = await readManifest(cwd, setup), manifest = loadedPkg?.manifest ?? null;
  const pkgEol = eolOf(loadedPkg?.text);
  for (const k of ['dependencies', 'devDependencies'])
    if (manifest?.[k] !== undefined && !isPlain(manifest[k])) throw setup(`package.json: ${k} is not an object`, 'fix package.json');
  own ??= await ownName();
  const {file: configFile, config, seen, eol: configEol} = await configOf(cwd), deps = {...manifest?.dependencies, ...manifest?.devDependencies};
  const found = place === 'agents' ? deps.agents && configFile : configFile || deps.wrangler;
  if (!found) throw setup(`${spec.kind}: need ${spec.looked}`, `run: npx ${COMMAND} add ${place} in the Worker folder`);

  const recordPath = `.rapier-jxl-${place}.json`, before = await recordOf(cwd, recordPath, place);
  const changes = [], writes = new Map(), files = {...before?.files}, next = [], ops = [...before?.config?.ops ?? []];
  if (seen?.main !== undefined && (typeof seen.main !== 'string' || !seen.main.trim()))
    throw setup(`main in ${configFile} is not a file path`, `set main to the Worker's entry file, or remove it`);
  const main = seen?.main === undefined ? null : normalize(posix(seen.main));
  if (main !== null && badRel(main)) throw setup(`main in ${configFile} is outside the project`, `set main to the Worker's entry file inside it`);
  const dir = place === 'agents' && main && dirname(main) !== '.' ? dirname(main) : '';
  const root = templates ? null : await examples();
  const project = (manifest?.name ?? basename(cwd)).toLowerCase().replace(/^@[^/]+\//, '').replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'site';

  for (const [name, source] of spec.files) {
    const raw = templates?.[name] ?? (source === '@space-saver'
      ? await readPackedSpaceSaver(own, root ? join(root, 'emdash') : null)
      : await readFile(join(root, source), 'utf8'));
    const path = posix(join(dir, name)), text = importsAs(raw, own), bytes = Buffer.from(text);
    const current = await read(join(cwd, path)), digest = sha(bytes), recorded = before?.files?.[path];
    if (current === null) { writes.set(path, bytes); files[path] = digest; changes.push({file: path, action: 'created'}); }
    else if (matches(current, digest)) { files[path] = digest; changes.push({file: path, action: 'unchanged'}); }
    else if (recorded && matches(current, recorded)) { writes.set(path, bytes); files[path] = digest; changes.push({file: path, action: 'updated'}); }
    else changes.push({file: path, action: recorded ? 'left (edited)' : 'left (already there)'});
  }

  const entry = posix(join(dir, spec.files[0][0]));
  if (seen?.r2_buckets !== undefined && (!Array.isArray(seen.r2_buckets) || seen.r2_buckets.some(badBucket)))
    throw setup(`r2_buckets in ${configFile} is invalid`, `make r2_buckets an array of objects in ${configFile}`);
  if (config) {
    if (place === 'r2') {
      if (config.queues !== undefined && !isPlain(config.queues))
        throw setup(`queues in ${configFile} is not an object`, `fix queues in ${configFile}`);
      if (config.queues?.consumers !== undefined && (!Array.isArray(config.queues.consumers) || config.queues.consumers.some(c => !isPlain(c))))
        throw setup(`queues.consumers in ${configFile} is invalid`, `make queues.consumers an array of objects in ${configFile}`);
      if (config.workflows !== undefined && (!Array.isArray(config.workflows) || config.workflows.some(w => !isPlain(w))))
        throw setup(`workflows in ${configFile} is invalid`, `make workflows an array of objects in ${configFile}`);
      if (config.limits !== undefined && !isPlain(config.limits))
        throw setup(`limits in ${configFile} is not an object`, `fix limits in ${configFile}`);
      if (config.vars !== undefined && !isPlain(config.vars))
        throw setup(`vars in ${configFile} is not an object`, `fix vars in ${configFile}`);
    } else if (config.compatibility_flags !== undefined && !Array.isArray(config.compatibility_flags)) {
      throw setup(`compatibility_flags in ${configFile} is not an array`, `fix compatibility_flags in ${configFile}`);
    }
  }
  const buckets = Array.isArray(seen?.r2_buckets) ? seen.r2_buckets : null;
  const bucket = given.bucket ?? buckets?.find(b => b?.binding === 'JXL_BUCKET')?.bucket_name ??
    (buckets?.length === 1 ? buckets[0]?.bucket_name : undefined) ?? `${project}-images`.slice(0, 63).replace(/-+$/, '');
  if (buckets?.length > 1 && !given.bucket && !buckets.some(b => b?.binding === 'JXL_BUCKET'))
    throw fail('JXL_OPTIONS', 'r2_buckets: --bucket required', 'use: --bucket <name>');
  const wanted = [{op: 'push', path: ['r2_buckets'], value: {binding: 'JXL_BUCKET', bucket_name: bucket}}];
  if (place === 'r2') {
    wanted.push(
      {op: 'push', path: ['queues', 'consumers'], value: {queue: `${bucket}-jxl`, max_batch_size: 1, max_retries: 3}},
      {op: 'push', path: ['workflows'], value: {name: `${project}-jxl`, binding: 'JXL_WORKFLOW', class_name: 'JxlWorkflow'}},
      {op: 'set', path: ['limits', 'cpu_ms'], value: CPU_MS});
    if (spaceSaver) wanted.push({op: 'set', path: ['vars', "JXL_SPACE_SAVER"], value: 'on'});
  } else wanted.push({op: 'push', path: ['compatibility_flags'], value: 'nodejs_compat'});
  const guide = `${bucket}: ${wanted.map(op => `${op.path.join('.')} ${JSON.stringify(op.value)}`).join(', ')}`;
  let created = null;
  if (!configFile) {
    const fresh = {name: `${project}-jxl`, main: entry, compatibility_date: DATE};
    for (const op of wanted) put(fresh, op);
    writes.set('wrangler.jsonc', Buffer.from(json(fresh))); files['wrangler.jsonc'] = sha(json(fresh)); created = 'wrangler.jsonc';
    changes.push({file: 'wrangler.jsonc', action: 'created'});
  } else if (!config) {
    next.push(`in ${configFile}, with bucket ${guide}${place === 'r2' && !main ? `, main = "${entry}"` : ''}`);
    if (place === 'r2' && main && main.replace(/^\.\//, '') !== entry)
      next.push(`in ${main}: import jxlR2, {JxlWorkflow} from '${(rel => rel.startsWith('.') ? rel : './' + rel)(posix(relative(dirname(main), entry)))}'; export {JxlWorkflow}; and answer fetch and queue with jxlR2.fetch and jxlR2.queue`);
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
      writes.set(configFile, Buffer.from(json(edited, configEol)));
      for (const op of done) if (!ops.some(old => old.op === op.op && same(old.path, op.path) && same(old.value, op.value))) ops.push(op);
      changes.push({file: configFile, action: `updated: ${done.map(op => op.path.join('.')).join(', ')}`});
    } else changes.push({file: configFile, action: 'unchanged'});
  }
  if (place === 'r2') {
    next.push(`npx wrangler r2 bucket create ${bucket}`, `npx wrangler queues create ${bucket}-jxl`,
      `npx wrangler r2 bucket notification create ${bucket} --event-type object-create --queue ${bucket}-jxl`);
    if (spaceSaver) next.push('to rebuild every removed original JPEG: call restoreOriginals(env) from ./jxl-r2.mjs or send {"action":"RestoreOriginals"} to the queue');
  } else {
    const from = file => (rel => rel.startsWith('.') ? rel : './' + rel)(posix(relative(main ? dirname(main) : '.', join(dir, file))));
    next.push(`in the Worker's fetch${main ? ` (${main})` : ''}: import {jxlMcp} from '${from('jxl-mcp.mjs')}'; and if (new URL(request.url).pathname === '/mcp') return jxlMcp(request, env, ctx)`,
      `in an AIChatAgent: import {jxlAgentTools} from its ${posix(join(dir, 'jxl-agent.mjs'))}, and pass tools: jxlAgentTools(this.env) to streamText`);
  }
  if (place === 'agents') {
    const missing = ['@modelcontextprotocol/server', 'zod', 'ai'].filter(dep => !deps[dep]);
    if (missing.length) next.unshift(`npm install ${missing.join(' ')}`);
    if (!config?.r2_buckets?.some(b => b.binding === 'JXL_BUCKET') && config) next.push(`npx wrangler r2 bucket create ${bucket} (if it does not exist)`);
  }

  let dependency = before?.dependency ?? false;
  const edited = manifest ? structuredClone(manifest) : {private: true, type: 'module'};
  if (!installs(edited, own)) {
    edited.dependencies = {...edited.dependencies, [own]: `^${version}`};
    writes.set('package.json', Buffer.from(json(edited, pkgEol))); dependency = true; next.unshift('npm install');
    changes.push({file: 'package.json', action: `updated: ${own} ^${version}`});
  } else changes.push({file: 'package.json', action: 'unchanged'});

  const originals = {};
  for (const path of [configFile, 'package.json']) {
    const kept = before?.originals?.[path], current = path && await read(join(cwd, path));
    if (!path || !current) continue;
    const after = writes.has(path) ? sha(writes.get(path)) : sha(current);
    if (kept && matches(current, kept.after)) originals[path] = {before: kept.before, after};
    else if (!kept && writes.has(path) && !before?.config && !before?.dependency) originals[path] = {before: current.toString('base64'), after};
  }
  const dirs = new Set(before?.dirs ?? []);
  for (const path of writes.keys()) for (let dir = dirname(path); dir !== '.'; dir = dirname(dir)) if (!await present(join(cwd, dir))) dirs.add(posix(dir));
  const ordered = [[recordPath, Buffer.from(json({place, version, files, ...ops.length && {config: {file: configFile ?? created, ops}}, dependency, ...created && {created},
    ...Object.keys(originals).length && {originals}, ...dirs.size && {dirs: [...dirs].sort()}}))], ...writes];
  const lands = await insideProject(cwd, ordered.map(([path]) => path), setup);
  for (const [i, [path]] of ordered.entries()) await refuseReadOnly(lands[i], path);
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
  if (!record) throw setup(`${place}: no record to remove`, 'nothing to remove (delete any files you added by hand)');
  own ??= await ownName();
  const changes = [], deletes = [], rewrites = new Map(), entries = Object.entries(record.files);
  const fileLands = await insideProject(cwd, entries.map(([path]) => path), setup);
  for (const [i, [path, digest]] of entries.entries()) {
    const current = await read(fileLands[i]);
    if (current === null) changes.push({file: path, action: 'already gone'});
    else if (matches(current, digest)) { deletes.push(path); changes.push({file: path, action: 'removed'}); }
    else changes.push({file: path, action: 'left (edited)'});
  }
  const restored = new Set();
  for (const [path, {before, after}] of Object.entries(record.originals ?? {})) {
    const current = await read((await insideProject(cwd, [path], setup))[0]);
    if (current && matches(current, after)) { rewrites.set(path, Buffer.from(before, 'base64')); restored.add(path); changes.push({file: path, action: 'restored'}); }
  }
  if (record.config && !record.created && !restored.has(record.config.file)) {
    const text = (await read((await insideProject(cwd, [record.config.file], setup))[0]))?.toString();
    const cfgEol = eolOf(text);
    let config = null; try { config = JSON.parse(text?.replace(/^\ufeff/, '')); } catch {}
    if (!isPlain(config)) changes.push({file: record.config.file, action: 'left (edited)'});
    else {
      let undone = 0; for (const op of [...record.config.ops].reverse()) if (unput(config, op)) undone++;
      if (undone === record.config.ops.length) { rewrites.set(record.config.file, Buffer.from(json(config, cfgEol))); changes.push({file: record.config.file, action: 'updated: lines removed'}); }
      else { if (undone) rewrites.set(record.config.file, Buffer.from(json(config, cfgEol))); changes.push({file: record.config.file, action: undone ? 'updated: lines removed, and changed lines stay' : 'left (edited)'}); }
    }
  }
  if (record.dependency && !restored.has('package.json')) {
    const loaded = await readManifest(cwd, setup), manifest = loaded?.manifest, pkgEol = eolOf(loaded?.text);
    if (isPlain(manifest?.dependencies) && manifest.dependencies[own] === `^${record.version}`) {
      delete manifest.dependencies[own]; if (!Object.keys(manifest.dependencies).length) delete manifest.dependencies;
      rewrites.set('package.json', Buffer.from(json(manifest, pkgEol))); changes.push({file: 'package.json', action: `updated: no longer depends on ${own}`});
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
