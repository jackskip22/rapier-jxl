// The plugin table from measure-<engine>.jsonl files: one row a page, engine and density, then N, the median of
// after/before bytes over the pages with text over a photograph (the control page excluded). Exit 1 on any wrong text
// sample after the patch.
//   node measure-summary.mjs <measure-*.jsonl>...
import {readFileSync} from 'node:fs';
const rows = process.argv.slice(2).flatMap(f => readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)));
const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
console.log('| engine | page | dpr | bytes before | bytes after | after/before | ms before | ms after | wrong text before | wrong text after | text samples | same files |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.engine} | ${r.page} | ${r.dpr} | ${r.before.bytes} | ${r.after.bytes} | ${r.ratio.toFixed(3)} | ${r.before.ms} | ${r.after.ms} | ${r.before.wrongText} | ${r.after.wrongText} | ${r.textSamples} | ${r.before.same && r.after.same ? 'yes' : 'NO'} |`);
const photo = rows.filter(r => !r.page.includes('control'));
for (const engine of [...new Set(rows.map(r => r.engine))]) {
  const e = photo.filter(r => r.engine === engine);
  console.log(`${engine}: median after/before ${median(e.map(r => r.ratio)).toFixed(3)}, time ${median(e.map(r => r.after.ms / r.before.ms)).toFixed(2)}x, over ${e.length} rows`);
}
const N = Math.round((1 - median(photo.map(r => r.ratio))) * 100);
const wrong = rows.reduce((n, r) => n + r.after.wrongText, 0), larger = rows.filter(r => r.after.bytes > r.before.bytes).length;
const control = rows.filter(r => r.page.includes('control'));
console.log(`N = ${N}% smaller (median over ${photo.length} rows with text over a photograph). Wrong text samples after: ${wrong}. Files larger after: ${larger}. Control page unchanged: ${control.every(r => r.after.bytes === r.before.bytes) ? 'yes' : 'NO'}.`);
process.exitCode = wrong ? 1 : 0;
