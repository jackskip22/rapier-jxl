// SPDX-License-Identifier: MIT
// The README's numbers, from v6-proof.mjs results: node v6-wins.mjs <out.json> <proof.json>...
// Bytes at equal score: each picture's log(bytes) is interpolated linearly in the score between its two nearest measured
// points (a target outside a picture's measured range leaves that picture out of the pair, and the count says so); the
// figure is total bytes against total bytes over the pictures both encoders reach. Times are medians per megapixel of
// single-threaded encodes. Every JPEG XL file in the inputs decoded as promised, or this refuses.
import {readFileSync, writeFileSync} from 'node:fs';
import {audit, libjxlNotes} from './v6-proof.mjs';

export const TARGETS = {ssimulacra2: [60, 70, 80, 85, 90], ba3: [2.0, 1.5, 1.0, 0.7]};

export function bytesAt(points, key, target) {
  const sorted = [...points].sort((a, b) => a[key] - b[key]);
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i], b = sorted[i + 1];
    if (target >= a[key] && target <= b[key] && b[key] > a[key]) {
      const t = (target - a[key]) / (b[key] - a[key]);
      return Math.exp(Math.log(a.bytes) + t * (Math.log(b.bytes) - Math.log(a.bytes)));
    }
  }
  return null;
}

// Candidate bytes against baseline bytes at one target over the pictures both reach: {ratio, images, of}.
export function pair(corpus, cand, base, key, target) {
  let c = 0, b = 0, n = 0, of = 0;
  for (const image of Object.values(corpus.images)) {
    if (!image[cand] || !image[base]) continue;
    of++;
    const y = bytesAt(image[cand], key, target), x = bytesAt(image[base], key, target);
    if (y === null || x === null) continue;
    c += y; b += x; n++;
  }
  return n ? {ratio: +(c / b).toFixed(4), images: n, of} : {ratio: null, images: 0, of};
}

const median = values => { const s = [...values].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

export function wins(reports) {
  const problems = reports.flatMap(audit);
  if (problems.length) throw new Error('decoders disagree:\n' + problems.join('\n'));
  const out = {corpora: {}, jpeg: {}, tools: reports[0].tools, chrome: reports.map(r => r.chrome?.version).find(Boolean) || null,
    libjxlDecoderNotes: reports.flatMap(libjxlNotes)};
  // Merge corpora of the same name (the phone half runs as several requests).
  const corpora = {}, jpegs = {};
  for (const r of reports) {
    for (const [name, c] of Object.entries(r.corpora || {})) Object.assign((corpora[name] ||= {images: {}}).images, Object.fromEntries(Object.entries(c.images).map(([k, row]) => [k, Object.fromEntries(Object.entries(row).map(([e, ps]) => [e, ps.filter(p => !p.error)]))])));
    for (const [name, c] of Object.entries(r.jpeg || {})) Object.assign((jpegs[name] ||= {images: {}}).images, c.images);
  }
  // Every corpus together as "photos": each pair then counts the pictures both of its encoders ran on.
  if (Object.keys(corpora).length > 1) corpora.photos = {images: Object.fromEntries(Object.entries(corpora).flatMap(([name, c]) =>
    Object.entries(c.images).map(([image, row]) => [name + '/' + image, row])))};
  for (const [name, corpus] of Object.entries(corpora)) {
    const encoders = [...new Set(Object.values(corpus.images).flatMap(i => Object.keys(i)))].sort();
    const v6 = encoders.filter(e => e.startsWith('v6:')), score = encoders.filter(e => e.startsWith('score:')), cjxl = encoders.filter(e => e.startsWith('cjxl:')), others = encoders.filter(e => !/^(v6|cjxl|score):/.test(e));
    const result = out.corpora[name] = {images: Object.keys(corpus.images).length, encoders, vsLibjxl: {}, vsOthers: {}, score: {}, time: {}};
    // Encode to a score: each file against cjxl's bytes at the score libjxl's own tool gives that file.
    const toolKey = {ssimulacra2: 'ssimulacra2', butteraugli3: 'ba3', butteraugli: 'butteraugli'};
    for (const s of score) for (const b of cjxl) {
      const key = toolKey[s.split(':')[1].split('=')[0]];
      let c = 0, x = 0, n = 0, of = 0, met = 0;
      for (const image of Object.values(corpus.images)) {
        const p = image[s]?.[0]; if (!p || !image[b]) continue;
        of++;
        const target = Number(s.split('=')[1]);
        if (key === 'ssimulacra2' ? p[key] >= target - 1 : p[key] <= target * 1.02) met++;
        const y = bytesAt(image[b], key, p[key]); if (y === null) continue;
        c += p.bytes; x += y; n++;
      }
      result.score[s + ' vs ' + b] = n ? {ratio: +(c / x).toFixed(4), images: n, of, metWithinToolTolerance: met} : {ratio: null, images: 0, of};
    }
    for (const c of v6) for (const b of cjxl) {
      const row = result.vsLibjxl[c + ' vs ' + b] = {};
      for (const [key, targets] of Object.entries(TARGETS)) for (const t of targets) row[key + '@' + t] = pair(corpus, c, b, key, t);
    }
    // JPEG XL against the formats people use today, at equal SSIMULACRA2: the other format's bytes over v6's.
    const jxl = v6.includes('v6:7') ? 'v6:7' : v6[0];
    for (const o of others) {
      const row = result.vsOthers[o] = {};
      for (const t of TARGETS.ssimulacra2) row['ssimulacra2@' + t] = pair(corpus, jxl, o, 'ssimulacra2', t);
    }
    for (const e of encoders) {
      const per = Object.values(corpus.images).flatMap(i => (i[e] || []).map(p => p.ms));
      result.time[e] = {medianMs: median(per), encodes: per.length};
    }
  }
  for (const [name, corpus] of Object.entries(jpegs)) {
    const rows = Object.values(corpus.images), result = out.jpeg[name] = {images: rows.length, encoders: {}};
    const original = rows.reduce((s, r) => s + r.bytes, 0);
    for (const e of ['v6:1', 'v6:7', 'v6:9', 'cjxl:7', 'cjxl:9']) {
      const have = rows.filter(r => r[e]);
      if (!have.length) continue;
      result.encoders[e] = {images: have.length, exact: have.filter(r => r[e].djxlExact && r[e].rapierExact !== false).length,
        bytes: have.reduce((s, r) => s + r[e].bytes, 0), original: have.reduce((s, r) => s + r.bytes, 0), medianMs: median(have.map(r => r[e].ms))};
      result.encoders[e].ratio = +(result.encoders[e].bytes / result.encoders[e].original).toFixed(4);
    }
    result.original = original;
  }
  return out;
}

// The README's and the comparison page's words, each number from the proof. A claim that is not a win refuses.
const whole = ratio => Math.floor((1 - ratio) * 100);
export function range(rows, label) {
  const values = rows.map(r => r?.ratio);
  if (values.some(v => !(v < 1))) throw new Error(label + ' is not a win at every target: ' + values.join(', '));
  const low = Math.min(...values.map(whole)), high = Math.max(...values.map(whole));
  return low === high ? high + '%' : low + '–' + high + '%';
}
const pctCell = r => r?.ratio == null ? '–' : (r.ratio < 1 ? '−' : '+') + Math.abs((r.ratio - 1) * 100).toFixed(1) + '%';
const targetName = t => t.startsWith('ssimulacra2@') ? 'SSIMULACRA2 ' + t.split('@')[1] : 'Butteraugli 3-norm ' + t.split('@')[1];
export function tables(w) {
  const out = [];
  for (const [name, c] of Object.entries(w.corpora)) {
    if (name === 'photos') continue;
    const cols = [['v6:7', 'cjxl:7'], ['v6:7', 'cjxl:9'], ['v6:9', 'cjxl:9']].filter(([a, b]) => c.vsLibjxl[a + ' vs ' + b]);
    const scoreCols = Object.keys(c.score).filter(k => k.endsWith('vs cjxl:9'));
    out.push(`**${name === 'kodak' ? 'Kodak 24' : name === 'phone' ? 'Phone Photos 24 (12 MP)' : name}**: bytes against libjxl at the same score (below 0 is smaller).`, '',
      ...(cols.length ? ['| Score | ' + cols.map(([a, b]) => `Effort ${a.split(':')[1]} vs \`cjxl -e ${b.split(':')[1]}\``).join(' | ') + ' |',
      '| --- | ' + cols.map(() => '---:').join(' | ') + ' |'] : []));
    if (cols.length) for (const t of Object.keys(c.vsLibjxl[cols[0].join(' vs ')])) out.push(`| ${targetName(t)} | ` + cols.map(([a, b]) => pctCell(c.vsLibjxl[a + ' vs ' + b][t])).join(' | ') + ' |');
    out.push('');
    if (scoreCols.length) {
      out.push('Encode to a score, against `cjxl -e 9` at the score libjxl\'s tool gives each file:', '', '| Target | Bytes | Pictures |', '| --- | ---: | ---: |');
      for (const k of scoreCols) { const [key, v] = k.split(' ')[0].slice(6).split('='); out.push(`| ${key === 'ssimulacra2' ? 'SSIMULACRA2' : 'Butteraugli 3-norm'} ${v} | ${pctCell(c.score[k])} | ${c.score[k].images} |`); }
      out.push('');
    }
    const others = Object.keys(c.vsOthers);
    if (others.length) {
      const label = {mozjpeg: 'JPEG (mozjpeg)', webp: 'WebP', avif: 'AVIF'};
      out.push('JPEG XL (effort 7) against other formats at the same SSIMULACRA2:', '', '| SSIMULACRA2 | ' + others.map(o => label[o] || o).join(' | ') + ' |', '| --- | ' + others.map(() => '---:').join(' | ') + ' |');
      for (const t of TARGETS.ssimulacra2) out.push(`| ${t} | ` + others.map(o => pctCell(c.vsOthers[o]['ssimulacra2@' + t])).join(' | ') + ' |');
      out.push('');
    }
  }
  return out.join('\n');
}

// The README's fills. Each claim is stated over the widest photo set where every one of its targets wins (all photos, else
// Kodak, else the phones) and names that set; a claim that wins on no set refuses the stage.
const SETS = [['photos', 'on Kodak and 24 phone photos'], ['kodak', 'on the 24 Kodak photos'], ['phone', 'on 24 phone photos']];
function claim(w, label, rowsOf) {
  const tried = [];
  for (const [name, words] of SETS) {
    const c = w.corpora[name]; if (!c) continue;
    const rows = rowsOf(c);
    if (!rows.length || rows.some(r => !r || !r.images)) continue;
    try { return {value: range(rows, label), set: words, images: Math.min(...rows.map(r => r.images))}; } catch (e) { tried.push(name + ': ' + e.message); }
  }
  throw new Error(label + ' wins on no photo set' + (tried.length ? ' (' + tried.join('; ') + ')' : ''));
}
export function readme(w) {
  const at = (c, pairKey, key, targets) => targets.map(t => c.vsLibjxl[pairKey]?.[key + '@' + t] ?? c.vsOthers[pairKey]?.[key + '@' + t]);
  const fill = {}, put = (value, set, key) => { fill[key] = value.value; fill[set] = value.set; };
  put(claim(w, 'v6 effort 7 vs cjxl e9 at SSIMULACRA2', c => at(c, 'v6:7 vs cjxl:9', 'ssimulacra2', TARGETS.ssimulacra2)), 'LIBJXL_SET', 'LIBJXL_SSIM_WIN');
  // JPEG, WebP and AVIF: one set for the three, the widest where all three win.
  const others = ['mozjpeg', 'webp', 'avif'].map(o => claim(w, 'JPEG XL vs ' + o, c => at(c, o, 'ssimulacra2', TARGETS.ssimulacra2)));
  const widest = SETS.findIndex(([, words]) => others.every(o => SETS.findIndex(([, x]) => x === o.set) <= SETS.findIndex(([, x]) => x === words)));
  const formats = ['mozjpeg', 'webp', 'avif'].map(o => claim({corpora: {[SETS[widest][0]]: w.corpora[SETS[widest][0]]}}, 'JPEG XL vs ' + o, c => at(c, o, 'ssimulacra2', TARGETS.ssimulacra2)));
  [fill.JPEG_WIN, fill.WEBP_WIN, fill.AVIF_WIN] = formats.map(f => f.value); fill.FORMATS_SET = formats[0].set;
  // Encode to a score against cjxl e9 at the scores libjxl's tools give each file: a range at SSIMULACRA2 (every target
  // must win), then the Butteraugli targets that win on the same set, named.
  const score = (c, metric) => Object.entries(c.score).filter(([k]) => k.startsWith('score:' + metric + '=') && k.endsWith(' vs cjxl:9'))
    .sort(([a], [b]) => parseFloat(a.split('=')[1]) - parseFloat(b.split('=')[1]));
  const ssim = claim(w, 'encode to a SSIMULACRA2 score', c => score(c, 'ssimulacra2').map(([, r]) => r));
  fill.SCORE_SSIM_WIN = ssim.value; fill.SCORE_SET = ssim.set;
  const scored = w.corpora[SETS.find(([, words]) => words === ssim.set)[0]];
  const ba = score(scored, 'butteraugli3').filter(([, r]) => r.ratio < 1).map(([k]) => Number(k.split('=')[1].split(' ')[0]).toFixed(1)).reverse();
  if (!ba.length) throw new Error('encode to a Butteraugli score wins at no target');
  fill.SCORE_BA_TARGETS = ba.join(', ').replace(/, ([^,]*)$/, ' and $1');
  // Exact JPEG: every file of every set restored by djxl and reconstructJPEG.
  const j = Object.values(w.jpeg).map(x => x.encoders['v6:7']).filter(Boolean);
  if (!j.length) throw new Error('no exact JPEG rows');
  const images = j.reduce((s, e) => s + e.images, 0), exact = j.reduce((s, e) => s + e.exact, 0);
  if (exact !== images) throw new Error('an exact JPEG did not restore');
  fill.EXACT_JPEG_COUNT = `${exact} of ${images}`;
  fill.EXACT_JPEG_WIN = whole(j.reduce((s, e) => s + e.bytes, 0) / j.reduce((s, e) => s + e.original, 0)) + '%';
  // Effort 9 where it adds what effort 7 does not: a win against cjxl e9 at every Butteraugli target (every target is
  // checked, then the best is stated), and the exact JPEG transcode with every file restored.
  const ba9 = claim(w, 'v6 effort 9 vs cjxl e9 at Butteraugli', c => at(c, 'v6:9 vs cjxl:9', 'ba3', TARGETS.ba3));
  fill.LIBJXL_BA_WIN_9 = 'up to ' + ba9.value.split('–').pop(); fill.LIBJXL_BA_SET_9 = ba9.set;
  const j9 = Object.values(w.jpeg).map(x => x.encoders['v6:9']).filter(Boolean);
  if (!j9.length) throw new Error('no exact JPEG rows at effort 9');
  const images9 = j9.reduce((s, e) => s + e.images, 0), exact9 = j9.reduce((s, e) => s + e.exact, 0);
  if (exact9 !== images9) throw new Error('an exact JPEG did not restore at effort 9');
  fill.EXACT_JPEG_COUNT_9 = `${exact9} of ${images9}`;
  fill.EXACT_JPEG_WIN_9 = whole(j9.reduce((s, e) => s + e.bytes, 0) / j9.reduce((s, e) => s + e.original, 0)) + '%';
  fill.PROOF_TABLES = tables(w);
  return fill;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [outPath, ...inputs] = process.argv.slice(2);
  const result = wins(inputs.map(p => JSON.parse(readFileSync(p))));
  writeFileSync(outPath, JSON.stringify(result, null, 1) + '\n');
  const pct = r => r?.ratio == null ? '   -   ' : ((r.ratio - 1) * 100).toFixed(1).padStart(6) + '%';
  for (const [name, c] of Object.entries(result.corpora)) {
    console.log(`\n${name} (${c.images} pictures)`);
    for (const [k, row] of Object.entries(c.vsLibjxl)) console.log(k.padEnd(18), Object.entries(row).map(([t, r]) => t.replace('ssimulacra2', 'S').replace('ba3', 'B') + pct(r) + (r.images < r.of ? `(${r.images})` : '')).join(' '));
    for (const [k, row] of Object.entries(c.vsOthers)) console.log(('v6 vs ' + k).padEnd(18), Object.entries(row).map(([t, r]) => t.replace('ssimulacra2', 'S') + pct(r) + (r.images < r.of ? `(${r.images})` : '')).join(' '));
    for (const [k, r] of Object.entries(c.score)) console.log(k.padEnd(34), pct(r), `${r.images}/${r.of}`, 'met', r.metWithinToolTolerance);
    console.log('median ms', Object.entries(c.time).map(([e, t]) => e + ' ' + t.medianMs).join(', '));
  }
  for (const [name, j] of Object.entries(result.jpeg)) console.log(`\n${name} JPEG`, JSON.stringify(j.encoders));
  try { const {PROOF_TABLES, ...rest} = readme(result); console.log('\nREADME fills', rest); } catch (e) { console.log('\nREADME refuses:', e.message); }
}
