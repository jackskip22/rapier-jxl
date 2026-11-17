// SPDX-License-Identifier: MIT
import {readFile, writeFile} from 'node:fs/promises';
import os from 'node:os';
import {resolve, join} from 'node:path';
import {selftest} from './selftest.mjs';
import {hostGPU} from '../gpu-gate.mjs';
import {COMMAND} from './package-name.mjs';
import {cliError, cliArgs} from './cli-error.mjs';

const fixError = (what, fix) => cliError('JXL_OPTIONS', what, fix);

export const SELFTEST_HELP = `Usage: ${COMMAND} selftest [--out <file>] [--pictures <folder>]

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
  const gpu = hostGPU();
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
  argv = cliArgs(argv);
  const options = {out: null, pictures: null, help: false};
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i]), [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg];
    const value = () => {
      if (inline !== undefined) return inline;
      if (i + 1 >= argv.length || String(argv[i + 1]).startsWith('-')) throw fixError(`${flag}: value required`, `use ${flag} <${flag === '--pictures' ? 'folder' : 'file'}>`);
      return String(argv[++i]);
    };
    if (flag === '-h' || flag === '--help') options.help = true;
    else if (flag === '-o' || flag === '--out') options.out = value();
    else if (flag === '--pictures') options.pictures = value();
    else throw fixError(`unknown option: "${arg}"`, `run npx ${COMMAND} selftest --help`);
  }
  return options;
}

export async function runSelftest(argv, {version, cwd = process.cwd(), stdout = line => process.stdout.write(line + '\n'), modules}) {
  const options = parseSelftestArgs(argv);
  if (options.help) { stdout(SELFTEST_HELP.trimEnd()); return {exitCode: 0}; }
  const base = `https://cdn.jsdelivr.net/gh/jackskip22/rapier-jxl@v${version}/jobs/pictures/`;
  const pictureFix = options.pictures
    ? "check: --pictures file"
    : `--pictures: jobs/pictures ${version}`;
  const picture = async file => {
    try {
      if (options.pictures) return await readFile(join(resolve(cwd, options.pictures), file));
      const response = await fetch(base + file, {redirect: 'error'});
      if (!response.ok) throw cliError('JXL_IO', `picture "${file}": HTTP ${response.status}`, pictureFix);
      return new Uint8Array(await response.arrayBuffer());
    } catch (cause) {
      if (typeof cause?.code === 'string' && cause.code.startsWith('JXL_')) throw cause;
      throw Object.assign(cliError('JXL_IO', options.pictures ? 'pictures: unreadable'
        : 'pictures: download failed', pictureFix), {cause});
    }
  };
  let manifest;
  try { manifest = JSON.parse(new TextDecoder().decode(await picture('manifest.json'))); }
  catch (cause) {
    if (typeof cause?.code === 'string' && cause.code.startsWith('JXL_')) throw cause;
    throw Object.assign(cliError('JXL_INPUT', 'manifest.json: invalid JSON',
      `jobs/pictures: jpegxl ${version}`), {cause});
  }
  if (!manifest || !Array.isArray(manifest.pictures) || manifest.pictures.some(item =>
    !item || typeof item.file !== 'string' || typeof item.id !== 'string' ||
      typeof item.kind !== 'string' || typeof item.sha256 !== 'string'))
    throw cliError('JXL_INPUT', 'manifest.json: incomplete', `jobs/pictures: jpegxl ${version}`);
  if (manifest.version !== version) throw cliError('JXL_INPUT',
    `pictures: ${manifest.version}, need ${version}`,
    `jobs/pictures: jpegxl ${version}`);
  const [{encode}, {recompress, restore}, {decode}, verifier] = await Promise.all([modules.still(), modules.jpeg(), modules.decode(), modules.verify()]);
  verifier.configureDecoder?.(decode, restore);
  const facts = await machineFacts();
  const out = resolve(cwd, options.out || `rapier-jxl-selftest-${facts.runtime.name}.json`);
  stdout(`rapier-jxl ${version} selftest on ${facts.runtime.name} ${facts.runtime.version}, ${facts.os.platform} ${facts.os.arch}, ${facts.cpu.cores} cores`);
  const record = await selftest({modules: {encode, recompress, restore, decode, verify: verifier.verify}, manifest, picture, facts,
    onRow: row => stdout(`${row.status === 'pass' ? 'pass' : 'FAIL'}  ${row.id}  ${row.bytes ?? '-'} B  ${Math.round(row.encodeMs ?? 0)} ms${row.error ? '  ' + row.error.message : ''}`)});
  try { await writeFile(out, JSON.stringify(record, null, 2) + '\n'); }
  catch (cause) {
    throw Object.assign(cliError('JXL_IO', `results "${out}": unwritable`,
      '--out: writable path'), {cause});
  }
  stdout(`${record.summary.passed} of ${record.summary.rows} passed in ${(record.elapsedMs / 1000).toFixed(1)} s. Attach ${out} to your job's issue.`);
  return {exitCode: record.status === 'pass' ? 0 : 1, record, out};
}
