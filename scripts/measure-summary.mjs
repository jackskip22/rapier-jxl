// The plugin table from measure-<engine>.jsonl files, one file an engine, one run each: never merge a run and its
// rerun into one call. One row a page, engine and density, then N, the median of after/before bytes over the pages
// with text over a photograph (the control page excluded).
// A row is admitted only when its key is expected and there once, and both arms had the same fixture: the same
// canvas given to the encoder (digest), the same text-sample count, and that canvas equal to the reference drawing
// (canvasNotExport 0). Exit 1 on a missing, doubled or unknown key, an inadmissible row, wrong text after, a larger
// file, files that differ between exports, or a changed control page: each is its own line.
//   node measure-summary.mjs <measure-*.jsonl>...
import {readFileSync} from 'node:fs';
import {basename} from 'node:path';

const PAGES = ['hero-headline', 'caption-scrim', 'price-badge', 'small-gray', 'text-shadow', 'gradient-over-photo',
  'watermark', 'article (no photo, control)'];
const DPRS = [1, 2];
const CONTROL = 'article (no photo, control)';
const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const key = r => `${r.engine} | ${r.page} | dpr ${r.dpr}`;
const failures = [];

const rows = [];
if (process.argv.length < 3) failures.push('no measure file: the measure wrote no rows');
for (const file of process.argv.slice(2)) {
  const engine = basename(file).match(/^measure-(.+)\.jsonl$/)?.[1];
  if (!engine) { failures.push(`${file}: not a measure-<engine>.jsonl file`); continue; }
  const own = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  for (const r of own) if (r.engine !== engine) failures.push(`${file}: a row of ${r.engine}`);
  const count = new Map();
  for (const r of own) count.set(key(r), (count.get(key(r)) ?? 0) + 1);
  for (const page of PAGES) for (const dpr of DPRS) {
    const k = key({engine, page, dpr}), n = count.get(k) ?? 0;
    if (n !== 1) failures.push(`${k}: ${n ? `${n} rows` : 'missing'}`);
    count.delete(k);
  }
  for (const k of count.keys()) failures.push(`${k}: not an expected row`);
  rows.push(...own);
}
if (new Set(rows.map(r => r.engine)).size !== process.argv.length - 2) failures.push('two files of one engine');

const unfit = r => [
  r.before.fixture !== r.after.fixture && `fixture ${r.before.fixture} before, ${r.after.fixture} after`,
  (r.before.textSamples !== r.textSamples || r.after.textSamples !== r.textSamples) &&
    `text samples ${r.before.textSamples} before, ${r.after.textSamples} after, ${r.textSamples} in the row`,
  (r.before.canvasNotExport || r.after.canvasNotExport) &&
    `the encoder's canvas differs from the reference drawing in ${r.before.canvasNotExport} and ${r.after.canvasNotExport} samples`,
].filter(Boolean);
const admitted = [];
for (const r of rows) {
  const why = unfit(r);
  if (why.length) failures.push(`${key(r)}: not admitted: ${why.join('; ')}`);
  else admitted.push(r);
}

console.log('| engine | page | dpr | bytes before | bytes after | after/before | ms before | ms after | wrong text before | wrong text after | text samples | same files | admitted |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
// GitHub keeps ten notices a step: one a page (its densities and engines together), one for the summary.
for (const pageName of PAGES) console.log(`::notice title=plugin ${pageName}::` + rows.filter(r => r.page === pageName)
  .map(r => `${r.engine} dpr ${r.dpr}: ${r.before.bytes} -> ${r.after.bytes} B (${r.ratio.toFixed(3)}), ${r.before.ms} -> ${r.after.ms} ms, wrong text ${r.before.wrongText} -> ${r.after.wrongText} of ${r.textSamples}${admitted.includes(r) ? '' : ', NOT ADMITTED'}`).join(' ; ').slice(0, 900));
for (const r of rows) console.log(`| ${r.engine} | ${r.page} | ${r.dpr} | ${r.before.bytes} | ${r.after.bytes} | ${r.ratio.toFixed(3)} | ${r.before.ms} | ${r.after.ms} | ${r.before.wrongText} | ${r.after.wrongText} | ${r.textSamples} | ${r.before.same && r.after.same ? 'yes' : 'NO'} | ${admitted.includes(r) ? 'yes' : 'NO'} |`);

const lines = [];
const photo = admitted.filter(r => r.page !== CONTROL);
for (const engine of [...new Set(rows.map(r => r.engine))]) {
  const e = photo.filter(r => r.engine === engine);
  lines.push(`${engine}: median after/before ${e.length ? median(e.map(r => r.ratio)).toFixed(3) : '-'}, time ${e.length ? median(e.map(r => r.after.ms / r.before.ms)).toFixed(2) : '-'}x, over ${e.length} admitted rows`);
}
const wrong = admitted.filter(r => r.after.wrongText), larger = admitted.filter(r => r.after.bytes > r.before.bytes);
const drift = admitted.filter(r => !r.before.same || !r.after.same);
const control = admitted.filter(r => r.page === CONTROL), changed = control.filter(r => r.after.bytes !== r.before.bytes);
const named = rs => rs.map(key).join('; ');
if (wrong.length) failures.push(`wrong text after: ${named(wrong)}`);
if (larger.length) failures.push(`larger after: ${named(larger)}`);
if (drift.length) failures.push(`files differ between exports: ${named(drift)}`);
if (changed.length) failures.push(`control page changed: ${named(changed)}`);
lines.push(`Rows admitted: ${admitted.length} of ${rows.length} (expected ${PAGES.length * DPRS.length} an engine).`);
lines.push(`Wrong text samples after: ${admitted.reduce((n, r) => n + r.after.wrongText, 0)}${wrong.length ? ` (${named(wrong)})` : ''}.`);
lines.push(`Files larger after: ${larger.length}${larger.length ? ` (${named(larger)})` : ''}.`);
lines.push(`Same file from each arm's three exports: ${drift.length ? `NO (${named(drift)})` : 'yes'}.`);
lines.push(`Control page unchanged: ${control.length && control.length === new Set(rows.map(r => r.engine)).size * DPRS.length && !changed.length ? 'yes' : `NO (${control.length} admitted rows${changed.length ? `; changed: ${named(changed)}` : ''})`}.`);
lines.push(failures.length
  ? `N not read: ${failures.length} failure(s) above.`
  : `N = ${Math.round((1 - median(photo.map(r => r.ratio))) * 100)}% smaller (median over ${photo.length} rows with text over a photograph).`);
for (const f of failures) console.log(`::error title=plugin measure::${f}`.slice(0, 900));
for (const l of lines) console.log(l);
console.log(`::notice title=plugin N::${lines.slice(-6).join(' ')} ${lines.slice(0, -6).join(' ; ')}`.slice(0, 900));
process.exitCode = failures.length ? 1 : 0;
