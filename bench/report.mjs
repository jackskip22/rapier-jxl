#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Turn compare.mjs results into Markdown tables.
//
//   node bench/report.mjs RUN_DIR [--out report.md] [--per-image per-image.md] [--before OTHER_RUN_DIR]
//
// RUN_DIR holds results.jsonl, environment.json and failures.jsonl. With --before, a second table lists, for every
// Rapier setting both runs measured, whether the output bytes are identical and how encode time changed.
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';

const args = process.argv.slice(2), dir = resolve(args[0] || '.');
const option = name => { const at = args.indexOf(name); return at < 0 ? null : args[at + 1]; };
const load = d => existsSync(join(d, 'results.jsonl')) ? readFileSync(join(d, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const rows = load(dir), before = option('--before') ? load(resolve(option('--before'))) : null;
const read = (d, f) => existsSync(join(d, f)) ? JSON.parse(readFileSync(join(d, f), 'utf8')) : null;
const failures = existsSync(join(dir, 'failures.jsonl')) ? readFileSync(join(dir, 'failures.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];

const n = v => v === undefined || v === null || Number.isNaN(v) ? '' : Math.round(v).toLocaleString('en-US');
const f = (v, d = 2) => v === undefined || v === null || Number.isNaN(v) ? '' : Number(v).toFixed(d);
const sum = a => a.reduce((x, y) => x + y, 0);
const geomean = a => a.length ? Math.exp(sum(a.map(Math.log)) / a.length) : NaN;
const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : NaN; };
const time = r => r.cpuMs ?? r.ms;  // CPU time is steadier on a shared host; wall time is listed beside it per image
const key = r => r.image + '|' + r.tag;
const index = list => { const m = new Map(); for (const r of list) m.set(r.codec + '|' + key(r), r); return m; };
const GROUPS = ['kodak', 'large', 'rapier', 'ui', 'pixel', 'icons', 'alpha'];
const out = [];
const table = (head, body, align) => {
  out.push('| ' + head.join(' | ') + ' |', '| ' + head.map((_, i) => align?.[i] === 'l' || i === 0 ? '---' : '---:').join(' | ') + ' |');
  for (const row of body) out.push('| ' + row.join(' | ') + ' |');
  out.push('');
};

const environment = read(dir, 'environment.json');
out.push('# Rapier and libjxl: benchmark and conformance results', '');
if (environment) {
  out.push('## Environment', '');
  out.push(`- Run label: ${environment.label}; started ${environment.started}.`);
  out.push(`- Host: ${environment.cpu}, ${environment.cores} logical CPUs, ${environment.platform}/${environment.arch} ${environment.release}; Node ${environment.node}; CPU affinity ${environment.affinity}.`);
  out.push(`- Tools: ${environment.tools.cjxl}; ${environment.tools.djxl}; ${environment.tools.oxide}.`);
  out.push(`- Timing: ${environment.method}`, '');
}

// Conformance first: any failure is a bug in the encoder.
const rapierRows = rows.filter(r => r.codec === 'rapier'), checked = rapierRows.filter(r => r.djxl || r.oxide);
out.push('## Conformance', '');
out.push(`Rapier outputs decoded with both djxl and jxl-oxide: ${checked.filter(r => r.djxl?.ok && r.oxide?.ok).length} of ${checked.length}. Lossless outputs compared with the source RGBA, including colour under zero alpha: ${checked.filter(r => r.mode === 'lossless' && r.djxl?.ok && r.oxide?.ok).length} exact of ${checked.filter(r => r.mode === 'lossless').length}.`, '');
if (failures.length) {
  out.push(`**${failures.length} failures.**`, '');
  table(['Image', 'Setting', 'Check', 'Detail'], failures.map(x => [x.image, x.tag, x.what, '`' + String(x.detail).slice(0, 160).replace(/\|/g, '/') + '`']), ['l', 'l', 'l', 'l']);
} else out.push('No failures.', '');
const lossyChecked = checked.filter(r => r.mode === 'lossy' && r.betweenDecoders !== undefined);
if (lossyChecked.length) out.push(`Lossy outputs: the two decoders differ by at most ${Math.max(...lossyChecked.map(r => r.betweenDecoders))} level(s) across ${lossyChecked.length} streams.`, '');

// Lossless summary by group and effort.
const idx = index(rows);
const efforts = [...new Set(rows.filter(r => r.mode === 'lossless').map(r => r.effort))].sort((a, b) => a - b);
const losslessImages = g => [...new Set(rows.filter(r => r.mode === 'lossless' && r.group === g).map(r => r.image))];
out.push('## Lossless: Rapier against libjxl by group and effort', '');
const timedRows = rows.filter(r => r.mode === 'lossless' && r.quiet !== undefined), loud = timedRows.filter(r => r.quiet === false).length;
if (timedRows.length) out.push(loud ? `${loud} of ${timedRows.length} timed settings ran while the machine's one-minute load average was above the limit set for the run; their absolute times are unreliable, but Rapier and libjxl alternated within each setting, so their ratio is comparable.` : `All ${timedRows.length} timed settings ran at a one-minute load average within the limit set for the run.`, '');
out.push('Bytes are totals over the images of a group. Time covers the images that were timed: the total of per-image medians (CPU ms), and the geometric mean over those images of Rapier time divided by libjxl time. A size ratio below 1 means Rapier is smaller.', '');
const summaryRows = [];
for (const group of GROUPS) for (const effort of efforts) {
  const images = losslessImages(group).filter(i => idx.get('rapier|' + i + '|e' + effort) && idx.get('libjxl|' + i + '|e' + effort));
  if (!images.length) continue;
  const pairs = images.map(i => [idx.get('rapier|' + i + '|e' + effort), idx.get('libjxl|' + i + '|e' + effort)]);
  const timed = pairs.filter(p => p[0].reps > 0 && p[1].reps > 0);  // runs without repeats (--quick) carry bytes, not a time
  const rb = sum(pairs.map(p => p[0].bytes)), lb = sum(pairs.map(p => p[1].bytes)), rt = sum(timed.map(p => time(p[0]))), lt = sum(timed.map(p => time(p[1])));
  summaryRows.push([group, String(effort), String(images.length), n(rb), n(lb), f(rb / lb, 4), String(pairs.filter(p => p[0].bytes < p[1].bytes).length), String(timed.length), n(rt), n(lt), timed.length ? f(geomean(timed.map(p => time(p[0]) / time(p[1]))), 1) : '']);
}
table(['Group', 'Effort', 'Images', 'Rapier bytes', 'libjxl bytes', 'Size ratio', 'Rapier smaller', 'Timed images', 'Rapier ms', 'libjxl ms', 'Time ratio'], summaryRows);

// Per image.
const perImage = [];
perImage.push('# Per-image results', '', 'Lossless. Bytes, bits per pixel, median wall ms (CPU ms), number of timed runs; a trailing * marks a single cold call (a byte comparison, not a timing).', '');
const save = out.length;
for (const group of GROUPS) {
  const images = losslessImages(group); if (!images.length) continue;
  perImage.push(`## ${group}`, '');
  const head = ['Image', 'Pixels']; for (const e of efforts) head.push(`e${e} Rapier bytes / bpp / ms (cpu)`, `e${e} libjxl bytes / bpp / ms (cpu)`);
  perImage.push('| ' + head.join(' | ') + ' |', '| --- | ---: ' + efforts.map(() => '| ---: | ---: ').join('') + '|');
  for (const image of images) {
    const any = rows.find(r => r.image === image), cells = [image, n(any.width * any.height)];
    for (const e of efforts) for (const codec of ['rapier', 'libjxl']) {
      const r = idx.get(codec + '|' + image + '|e' + e);
      cells.push(r ? `${n(r.bytes)} / ${f(r.bpp, 3)} / ${f(r.ms, r.ms < 100 ? 1 : 0)} (${f(r.cpuMs ?? NaN, r.ms < 100 ? 1 : 0)})${r.reps > 0 ? '' : '*'}` : '');
    }
    perImage.push('| ' + cells.join(' | ') + ' |');
  }
  perImage.push('');
}

// Lossy.
const qualities = [...new Set(rows.filter(r => r.mode === 'lossy' && r.codec === 'rapier').map(r => r.quality))].sort((a, b) => b - a);
if (qualities.length) {
  out.push('## Lossy: Rapier photo path against libjxl', '');
  out.push('Opaque images only (scores are not computed when alpha is present). `ssim2` is ssimulacra2 (higher is better), `ba` is the butteraugli distance (lower is better), both measured on djxl output. libjxl at d is its distance for the same quality number at effort 7; "matched" is the libjxl effort 7 distance whose size is within 1% of Rapier\'s (or the closest found). Images whose lossy attempt returned the exact result are left out.', '');
  const lossyRows = [];
  for (const group of GROUPS) for (const q of qualities) {
    const images = [...new Set(rows.filter(r => r.mode === 'lossy' && r.group === group && r.tag === 'photo-q' + q && r.metrics && !r.exact).map(r => r.image))];
    const sets = images.map(i => ({r: idx.get('rapier|' + i + '|photo-q' + q), d: idx.get('libjxl|' + i + '|d-q' + q + '-e7'), m: idx.get('libjxl|' + i + '|match-q' + q + '-e7')})).filter(s => s.r?.metrics && s.d?.metrics && s.m?.metrics);
    if (!sets.length) continue;
    const mean = (pick) => f(sum(sets.map(pick)) / sets.length, 2);
    lossyRows.push([group, String(q), String(sets.length),
      n(sum(sets.map(s => s.r.bytes))), mean(s => s.r.metrics.ssimulacra2), mean(s => s.r.metrics.butteraugli), n(sum(sets.map(s => s.r.cpuMs ?? s.r.ms))),
      n(sum(sets.map(s => s.d.bytes))), mean(s => s.d.metrics.ssimulacra2), mean(s => s.d.metrics.butteraugli), n(sum(sets.map(s => s.d.cpuMs ?? s.d.ms))),
      n(sum(sets.map(s => s.m.bytes))), mean(s => s.m.metrics.ssimulacra2), mean(s => s.m.metrics.butteraugli)]);
  }
  table(['Group', 'Q', 'Images', 'Rapier bytes', 'ssim2', 'ba', 'ms', 'libjxl d bytes', 'ssim2', 'ba', 'ms', 'libjxl matched bytes', 'ssim2', 'ba'], lossyRows);
}

// Two Rapier builds measured in the same run: alternating timed runs give the same load to both.
const earlier = rows.filter(r => r.codec === 'rapier-before');
if (earlier.length) {
  out.push('## Earlier Rapier build against this one, same run', '');
  const pairs = earlier.map(b => [b, idx.get('rapier|' + key(b))]).filter(([, a]) => a);
  out.push(`${pairs.length} settings were encoded by both builds in alternation; ${pairs.filter(([b, a]) => b.sha256 === a.sha256).length} produce identical bytes. Time is CPU ms, median of the alternating runs.`, '');
  const body = [];
  for (const group of GROUPS) for (const effort of efforts) {
    const set = pairs.filter(([b]) => b.group === group && b.effort === effort);
    if (!set.length) continue;
    body.push([group, String(effort), String(set.length), String(set.filter(([b, a]) => b.sha256 === a.sha256).length), n(sum(set.map(([b]) => b.bytes))), n(sum(set.map(([, a]) => a.bytes))),
      n(sum(set.map(([b]) => time(b)))), n(sum(set.map(([, a]) => time(a)))), f(geomean(set.map(([b, a]) => time(b) / time(a))), 2) + 'x']);
  }
  table(['Group', 'Effort', 'Images', 'Identical', 'Bytes before', 'Bytes after', 'ms before', 'ms after', 'Speed-up (geometric mean)'], body);
}

// Before and after.
if (before) {
  const old = index(before);
  out.push('## Change against the earlier run', '');
  const compared = rapierRows.map(r => [r, old.get('rapier|' + key(r))]).filter(([, o]) => o);
  const identical = compared.filter(([r, o]) => r.sha256 === o.sha256).length;
  out.push(`${compared.length} Rapier settings appear in both runs; ${identical} produce identical bytes${identical === compared.length ? '' : ', ' + (compared.length - identical) + ' differ'}.`, '');
  const rowsDiff = [];
  for (const effort of efforts) {
    const set = compared.filter(([r]) => r.mode === 'lossless' && r.effort === effort);
    if (!set.length) continue;
    rowsDiff.push([String(effort), String(set.length), String(set.filter(([r, o]) => r.sha256 === o.sha256).length), n(sum(set.map(([, o]) => o.bytes))), n(sum(set.map(([r]) => r.bytes))),
      n(sum(set.map(([, o]) => time(o)))), n(sum(set.map(([r]) => time(r)))), f(geomean(set.map(([r, o]) => time(o) / time(r))), 2) + 'x']);
  }
  table(['Effort', 'Images', 'Identical', 'Bytes before', 'Bytes after', 'ms before', 'ms after', 'Speed-up (geometric mean)'], rowsDiff);
  const changed = compared.filter(([r, o]) => r.sha256 !== o.sha256);
  if (changed.length) table(['Image', 'Setting', 'Bytes before', 'Bytes after', 'Change'], changed.map(([r, o]) => [r.image, r.tag, n(o.bytes), n(r.bytes), f((r.bytes - o.bytes) / o.bytes * 100, 3) + '%']), ['l', 'l']);
}

writeFileSync(option('--out') || join(dir, 'report.md'), out.join('\n') + '\n');
writeFileSync(option('--per-image') || join(dir, 'per-image.md'), perImage.join('\n') + '\n');
console.log('Wrote ' + (option('--out') || join(dir, 'report.md')));
