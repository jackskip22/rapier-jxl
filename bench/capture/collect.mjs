// SPDX-License-Identifier: MIT
// Consolidate reproducible runs. Later runs replace the same input/codec/execution key.
// node bench/capture/collect.mjs RUN_DIR... --out bench/capture/results.json
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {resolve, basename} from 'node:path';
import {createHash} from 'node:crypto';
const args = process.argv.slice(2), at = args.indexOf('--out');
const files = (at < 0 ? args : args.slice(0, at)).map(dir => resolve(dir, 'results.json'));
const out = resolve(at < 0 ? 'bench/capture/results.json' : args[at + 1]);
const hash = data => createHash('sha256').update(data).digest('hex');
const rows = new Map(), inputs = new Map(), runs = []; let first;
for (const file of files) {
  const bytes = readFileSync(file), result = JSON.parse(bytes); first ||= result;
  runs.push({name: basename(resolve(file, '..')), sha256: hash(bytes), date: result.date, rows: result.rows.length});
  for (const input of result.inputs) inputs.set(input.name, {...inputs.get(input.name), ...input});
  for (const row of result.rows) rows.set(row.key, {...row, run: runs.at(-1).name});
}
const report = {...first, runs, inputs: [...inputs.values()], rows: [...rows.values()],
  scope: 'One hosted EPYC Linux instance, Node24 and Chrome155. Not a physical midrange laptop/phone qualification. All input/output byte and correctness facts are reproducible; latency is machine/load-specific. Native CLI repeats include startup and PNG decode, JS timings exclude input decode. Explicitly inspect each row timing and memoryMethod.',
  finalCaptureSource: Object.fromEntries(['capture-codec', 'capture-gpu', 'capture', 'screen', 'screen-lz77', 'screen-local', 'lossless', 'image', 'encode-worker'].map(name => {
    const file = resolve('src', name + '.mjs'); return [name, existsSync(file) ? hash(readFileSync(file)) : null];
  }))};
writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({output: out, rows: report.rows.length, measured: report.rows.filter(r => r.status === 'measured').length, failures: report.rows.filter(r => r.status !== 'measured').map(r => r.key)}));
