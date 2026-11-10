// SPDX-License-Identifier: MIT
import {readFile, writeFile} from 'node:fs/promises';
import os from 'node:os';
import {resolve, join} from 'node:path';
import {selftest} from './selftest.mjs';

const fixError = (what, fix) => Object.assign(new Error(`${what} Fix: ${fix}`), {code: 'JXL_OPTIONS', fix});

export const SELFTEST_HELP = `Usage: rapier-jxl selftest [--out <file>] [--pictures <folder>]

Encodes, decodes and verifies fixed pictures, then writes one results file.
Attach the file to your job's issue (jobs/ in the rapier-jxl repository).

Options:
  -o, --out <file>         Results file (default: rapier-jxl-selftest-<runtime>.json)
      --pictures <folder>  Read the pictures from a folder instead of downloading them
`;

function runtimeName() {
  if (globalThis.Deno?.version) return {name: 'deno', version: globalThis.Deno.version.deno, v8: globalThis.Deno.version.v8};
  if (process.versions.bun) return {name: 'bun', version: process.versions.bun};
  return {name: 'node', version: process.versions.node, v8: process.versions.v8};
}

async function webgpu() {
  const gpu = globalThis.navigator?.gpu;
  if (!gpu) return null;
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return {available: false};
    const info = adapter.info || {};
    return {available: true, vendor: info.vendor || '', architecture: info.architecture || '', device: info.device || '',
      description: info.description || '', isFallbackAdapter: adapter.isFallbackAdapter ?? info.isFallbackAdapter ?? null};
  } catch (e) { return {available: false, error: String(e?.message || e)}; }
}

export async function machineFacts() {
  const cpus = os.cpus();
  return {runtime: runtimeName(), os: {platform: os.platform(), release: os.release(), version: os.version?.() || null, arch: os.arch()},
    cpu: {model: cpus[0]?.model?.trim() || null, cores: os.availableParallelism?.() ?? cpus.length},
    memoryBytes: os.totalmem(), webgpu: await webgpu()};
}

export function parseSelftestArgs(argv) {
  const options = {out: null, pictures: null, help: false};
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i]), [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg];
    const value = () => {
      if (inline !== undefined) return inline;
      if (i + 1 >= argv.length || String(argv[i + 1]).startsWith('-')) throw fixError(`${flag} needs a value.`, `write ${flag} <${flag === '--pictures' ? 'folder' : 'file'}>.`);
      return String(argv[++i]);
    };
    if (flag === '-h' || flag === '--help') options.help = true;
    else if (flag === '-o' || flag === '--out') options.out = value();
    else if (flag === '--pictures') options.pictures = value();
    else throw fixError(`Unknown selftest option "${arg}".`, 'run npx rapier-jxl selftest --help.');
  }
  return options;
}

export async function runSelftest(argv, {version, cwd = process.cwd(), stdout = line => process.stdout.write(line + '\n'), modules}) {
  const options = parseSelftestArgs(argv);
  if (options.help) { stdout(SELFTEST_HELP.trimEnd()); return {exitCode: 0}; }
  const base = `https://cdn.jsdelivr.net/gh/jackskip22/rapier-jxl@v${version}/jobs/pictures/`;
  const picture = options.pictures ? file => readFile(join(resolve(cwd, options.pictures), file))
    : async file => {
      const response = await fetch(base + file, {redirect: 'error'});
      if (!response.ok) throw new Error(`${base + file}: HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    };
  let manifest;
  try { manifest = JSON.parse(new TextDecoder().decode(await picture('manifest.json'))); }
  catch (e) {
    throw fixError(`The pictures could not be read (${e.message}).`, options.pictures ? 'pass the jobs/pictures folder of this release.'
      : 'check the connection, or pass --pictures <folder> with jobs/pictures from the repository.');
  }
  if (manifest.version !== version) throw fixError(`The pictures are for rapier-jxl ${manifest.version}, not ${version}.`, `use jobs/pictures from rapier-jxl ${version}.`);
  const [{encode}, {recompress, restore}, {decode}, verifier] = await Promise.all([modules.still(), modules.jpeg(), modules.decode(), modules.verify()]);
  verifier.configureDecoder?.(decode, restore);
  const facts = await machineFacts();
  const out = resolve(cwd, options.out || `rapier-jxl-selftest-${facts.runtime.name}.json`);
  stdout(`rapier-jxl ${version} selftest on ${facts.runtime.name} ${facts.runtime.version}, ${facts.os.platform} ${facts.os.arch}, ${facts.cpu.cores} cores`);
  const record = await selftest({modules: {encode, recompress, restore, decode, verify: verifier.verify}, manifest, picture, facts,
    onRow: row => stdout(`${row.status === 'pass' ? 'pass' : 'FAIL'}  ${row.id}  ${row.bytes ?? '-'} B  ${Math.round(row.encodeMs ?? 0)} ms${row.error ? '  ' + row.error.message : ''}`)});
  await writeFile(out, JSON.stringify(record, null, 2) + '\n');
  stdout(`${record.summary.passed} of ${record.summary.rows} passed in ${(record.elapsedMs / 1000).toFixed(1)} s. Attach ${out} to your job's issue.`);
  return {exitCode: record.status === 'pass' ? 0 : 1, record, out};
}
