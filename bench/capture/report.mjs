// SPDX-License-Identifier: MIT
// Render the checked-in audit from the checked-in raw receipts.
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {resolve} from 'node:path';
const base = resolve('bench/capture'), read = name => JSON.parse(readFileSync(resolve(base, name)));
const before = read('baseline-audit.json'), after = read('final-audit.json'), probes = read('module-probes.json'),
  matches = read('module-matched.json'), results = read('results.json'), browser = read('browser-results.json'), fixture = read('fixtures/manifest.json'), tools = read('toolchain.json');
const scoreBefore = read('score-baseline.json').rows[0], scoreAfter = read('score-current.json').rows[0], scoreMatches = read('score-current-matched.json');
const number = n => Number.isFinite(n) ? n.toLocaleString('en-US', {maximumFractionDigits: 0}) : '—';
const score = n => Number.isFinite(n) ? n.toFixed(2) : '—';
const percent = n => (n >= 0 ? '+' : '') + n.toFixed(1) + '%';
const median = x => x?.length ? [...x].sort((a,b)=>a-b)[Math.floor(x.length/2)] : undefined;
const byCodec = new Map(probes.rows.map(row => [row.codec, row]));
const matchFor = (codec, effort) => matches.rows.find(row => row.comparedCodec === codec && row.effort === effort);
const rawLink = '../bench/capture/';
const map = {'index':'core','photo-noise':'noise','rapier-worker':'rapier','rapier-still-worker':'rapier-still'};
const modes = {
  index:'Exact Modular; lossy Squeeze or photographic effort 1; native/HDR/ICC/alpha', effort:'Core + effort 1–9, screen/palette/patch and photo searches', wasm:'Effort + embedded scalar/SIMD kernels',
  photo:'Photographic quality/entropy search; exact alpha; quality100 exact', 'photo-advanced':'Explicit transforms, progressive passes and coefficient orders', 'photo-ans':'Photographic ANS search',
  'photo-plan':'Retained transform plan; encode quality or target bytes', 'photo-noise':'Photo + optional grain estimation/synthesis', score:'Search candidate/quality against a perceptual target', hybrid:'Exact regions over a photographic base',
  graphics:'Exact or bounded-error palettes/undither', icc:'Profile/color metadata with exact/native samples', opsin:'Opsin header/transform composition', 'delta-palette':'Exact or authored delta palettes',
  splines:'Authored XYB curves over a photographic base', channels:'Planar native samples + typed extra channels', layers:'Layered sample/frame composition', patches:'Authored atlas and patch dictionaries',
  jpeg:'Reversible JPEG coefficient transcode/reconstruction', 'jpeg-ans':'Same JPEG custody with ANS search', animation:'Timed frames and changed rectangles', 'animation-atlas':'Animation with shared patch atlas',
  metadata:'Read/write metadata boxes', brotli:'Metadata compression', 'container-stream':'Container framing/streaming', 'container-advanced':'Container inspection, frame index and gain maps',
  'progressive-container':'Progressive container delivery', delivery:'Group order/region delivery', writer:'Low-level format writer and lossless/lossy/VarDCT kernels', source:'Source sample/color preparation', kernels:'Optional arithmetic kernels',
  image:'Input/worker adapter; an encoder is still required', rapier:'Complete still/animation/JPEG/metadata/GPU engine', 'rapier-worker':'Complete worker', 'rapier-still-worker':'Still/JPEG/metadata worker', 'gpu-core':'Optional photographic GPU kernels'
};
const nativeExact = effort => results.rows.find(r => r.input === 'photo-keong' && r.codec === `cjxl-e${effort}-lossless` && r.status === 'measured');
function comparison(module, row) {
  if (!row || row.status !== 'measured') return 'N/A';
  if (module === 'jpeg' || module === 'jpeg-ans') return probes.nativeJPEG.map(n => percent(100 * (row.bytes/n.bytes-1))).join(' / ') + ' (JPEG exact)';
  if (row.correctness?.ssimulacra2 === 100) return [7,9].map(e=>nativeExact(e) ? percent(100*(row.bytes/nativeExact(e).bytes-1)) : '—').join(' / ');
  return [7,9].map(e=> {const m = matchFor(row.codec,e); return !m ? '—' : `${number(m.chosen.bytes)} B @${score(m.chosen.ssimulacra2)}${m.matched?'':' †'}`;}).join(' / ');
}
const old = [...before.builds, ...before.exports.filter(e=>!e.minified&&e.entry!=='./package.json').map(e=>({module:e.entry.slice(2),file:e.measuredFile,gzip:e.entryBytes.gzip,closureGzip:e.closureGzip,sourceOnly:true}))];
const moduleRows = old.map(b=> {
  const row = byCodec.get(map[b.module] || b.module);
  const label = b.sourceOnly ? `${b.module} (source graph)` : b.module;
  const shipping = b.sourceOnly ? `${number(b.closureGzip)}*` : number(b.gzip)+(b.closureGzip!==b.gzip?` + ${number(b.closureGzip-b.gzip)} GPU`:'');
  const file = row?.status==='measured' ? `${number(row.bytes)} / ${score(row.correctness?.ssimulacra2)}` : 'N/A';
  const time = row?.status==='measured' ? `${b.module.endsWith('-worker')?'engine main: ':''}${number(row.coldMs)} / ${number(median(row.warmMs))}` : 'N/A';
  return `| ${label} | ${shipping} | ${modes[b.module]||b.modes} | ${file} | ${time} | ${comparison(b.module,row)} |`;
});
const beforeMap = new Map(old.map(x=>[x.module,x]));
const oldName = n => ({full:'rapier','full-worker':'rapier-worker'}[n]||n);
const deltaRows = after.builds.map(b=> {
  const a=beforeMap.get(oldName(b.module)), original=a?.closureGzip;
  return `| ${b.file.replace('dist/','')} | ${number(original)} | ${number(b.gzip)} | ${original===undefined?'new':number(b.gzip-original)} |`;
});
const get = (name, input='snapdom-opaque-1920x1080', execution='main') => results.rows.find(r=>r.input===input&&r.codec===name&&r.execution===execution);
const headlineCodecs = ['core-lossless','capture-lossless','jsquash-e7-lossless','vips-e3-lossless','vips-e7-lossless','cjxl-e7-lossless','cjxl-e9-lossless','webp-lossless','webp-q90','png-oxipng4'];
const headlineRows = [];
for(const input of ['snapdom-opaque-1920x1080','snapdom-opaque-3840x2160']) {
  for(const codec of headlineCodecs) {
    const execution=/^(cjxl|webp|png)/.test(codec)?'cli':'main', r=get(codec,input,execution), w=get(codec,input,'worker');
    if(!r)continue;
    headlineRows.push(`| ${input.includes('1920')?'FHD':'4K'} | ${codec} | ${number(r.bytes)} | ${number(r.coldMs)} / ${number(median(r.warmMs))} | ${w?`${number(w.coldMs)} / ${number(median(w.warmMs))}`:'—'} | ${number(r.memory?.peakRSSKiB/1024)}${w?` / ${number(w.memory?.peakRSSKiB/1024)}`:''} | ${r.status==='measured'?score(r.correctness?.ssimulacra2):'failed; see raw'} |`);
  }
  for(const codec of ['browser-png','browser-webp-q90']) {
    const r=fixture.encodes.find(r=>r.input===input&&r.codec===codec);
    headlineRows.push(`| ${input.includes('1920')?'FHD':'4K'} | ${codec} | ${number(r.bytes)} | ${number(r.coldMs)} / ${number(median(r.warmMs))} | — | unmeasured | ${codec==='browser-png'?'100 (exact samples)':'not scored here'} |`);
  }
}
const captureRows = browser.rows.filter(r=>r.mode==='exact').map(r=>`| ${r.input} | ${r.execution} | ${number(r.bytes)} | ${number(r.coldMs)} / ${number(median(r.warmMs))} | ${r.roundTrip?.rgbaEqual?'exact RGBA':r.roundTrip?.supported?'native decoded; alpha readback rounding':'not decoded'} |`);
const a = after.builds.find(r=>r.module==='capture-worker'), client=after.builds.find(r=>r.module==='image');
const scoreRows = scoreMatches.rows.map(r=>`| cjxl e${r.effort}, matched decoded pixels | ${number(r.chosen.bytes)} | ${score(r.chosen.ssimulacra2)} | ${number(r.chosen.ms)} |`);
const report = `# Capture encoder audit

**The capture worker and client ship ${number(a.gzip+client.gzip)} gzip bytes.** The snapdom adapter adds 400. No optional GPU download or WASM file is required. This is a different, capture-specific entry; the original native/HDR/photographic core and every advanced feature remain available.

On the opaque mixed DOM fixture, lossless capture produces **342,821 bytes at FHD** and **896,177 at 4K**, versus browser PNG's 804,840 and 2,404,437. PNG is much faster. WebP lossless and libjxl can produce smaller files. This is a small JavaScript encoder with explicit tradeoffs, not a universal compression or speed winner.

The original 28,920-byte core includes exact Modular, lossy Squeeze and effort 1 photographic coding, native samples/HDR/ICC/alpha. It excludes the expensive screen/photo searches. Its optional GPU import adds 6,080 bytes. On these exact captures it produces 513,838/1,490,811 bytes; the original effort 9 produces 275,041/692,029, costing about 60 seconds/342 seconds for the first encode on this host. The core is **86.8%/115.4% larger** than those best measured JavaScript lossless files. On the photo at the same decoded quality, core 30,112 bytes versus photo effort 7's 26,509 is **13.6% larger**.

## Measurement limits

Hosted Linux x86_64, AMD EPYC 9V74, Node 24 and Chrome 155. CPU quotas and exact versions are in the receipts. These are **not physical laptop or phone measurements**. Hardware latency/memory budgets remain unqualified. Product qualification targets are laptop FHD ≤1 s / 4K ≤3 s and phone FHD ≤2.5 s / 4K ≤8 s. These are targets, not hardware results or API guarantees. Browser GPU auto fell back to CPU because the default adapter was unavailable; software-GPU correctness is separate from hardware performance.

Cold JS includes module/worker initialization; warm is the median of recorded repeats. Native CLI timings also include process start, PNG decode and file write, and their repeats are fresh processes. Peak memory is whole-process RSS, including input/runtime/worker, not incremental codec allocation. Browser native/GPU peaks were not exposed and are left unmeasured. Some diagnostic/audit timings ran while other work shared the host; the headline Node codec run was serialized after build/browser work stopped. Inspect each row's run and timing field before comparing.

The photo is a pinned CC0 image, 500×500; all raw codecs receive the same sRGB samples. Native reference inputs strip source Exif/ICC/text metadata without changing RGBA. SSIMULACRA2 is measured on independently decoded 8-bit PNGs, so the comparison includes 8-bit output quantization. Alpha and RGB under zero alpha are included in exact native comparisons.

## Every original entry

6.1.1 at \`3d36f51c36843a7d2965af2f525504047aa2f8a3\`. Equivalent source/min aliases are grouped; [the machine inventory](${rawLink}baseline-audit.json) lists all 67 export mappings, files, hashes and dependency closures. The old size manifest says 6.1.0, but these are the actual 6.1.1 files.

File/score and timing use the common 500×500 photo. Exact rows compare native cjxl 0.12.0 e7/e9 at score 100. Lossy comparisons show actual cjxl bytes and achieved score; **† means no match within +0.15**, so no matched-quality win is claimed. The JPEG rows compare byte-exact JPEG reconstruction, not a fresh lossy encode. One-frame animation/one-layer/one identical patch/zero-amplitude spline probes measure API overhead, not compression benefits of those features. Old worker rows reuse their engine's main-thread probe; they do not claim measured worker startup. Current worker round trips are measured below. Utilities cannot independently encode this input: N/A is deliberate.

| Entry/build | Gzip shipped B | Modes | Output B / native score | Cold / warm ms | cjxl e7 / e9 comparison |
|---|---:|---|---:|---:|---|
${moduleRows.join('\n')}

*Source-only entries show separately-gzipped source dependencies, not a minified bundle. The score wrapper alone is 1,271 bytes but its complete source graph is 133,531; writer/source/kernels have the same accounting rule. The image wrapper's 1,184 bytes exclude its required encoder. Package JSON is metadata, not encoder code. The old manifest's hypothetical combined-all build was 215,724 gzip bytes, not a shipped entry.

### High quality and the score correction

The audit found an inflated internal SSIMULACRA2 result. At a target of 85 the original search returned ${number(scoreBefore.bytes)} bytes and reported ${scoreBefore.metadata.ssimulacra2.toFixed(5)}; native decoding scored 84.26455 directly from JXL and ${scoreBefore.correctness.ssimulacra2.toFixed(5)} after 8-bit PNG quantization. The metric now agrees with native libjxl on identical reference/distorted pixels, including alpha's two-background policy. Candidate choice compares completed stream lengths, and an unmet internal target is an explicit error.

The corrected target-85 search returns **${number(scoreAfter.bytes)} bytes**, internal ${scoreAfter.metadata.ssimulacra2.toFixed(5)}, native JXL ${scoreAfter.correctness.nativeStreamSsimulacra2.toFixed(5)}, and decoded 8-bit ${scoreAfter.correctness.ssimulacra2.toFixed(5)}. Direct JXL and 8-bit PNG are different measurement conventions; the table consistently matches the latter. This is a search over supported candidates, not proof of the global smallest possible file or an external-decoder quality guarantee. This one photo is evidence, not a general photo-corpus win.

| Current path / reference | File B | Native SSIMULACRA2, decoded 8-bit | Cold encode ms |
|---|---:|---:|---:|
| Photo target 85, corrected search | ${number(scoreAfter.bytes)} | ${score(scoreAfter.correctness.ssimulacra2)} | ${number(scoreAfter.coldMs)} |
${scoreRows.join('\n')}

The corrected result is 10.3%/9.3% smaller than those matched e7/e9 files, but the search takes about 61 seconds on this 500×500 fixture. The fixed-quality photo effort-9 path remains 26,074 bytes at 77.21, measured again after the search changes. Use the worker for photo work and measure the quality/speed tradeoff on the host's actual corpus.

## Size delta for every new build

Before is the old complete download closure, including optional GPU imports. After is one eager, self-contained bundle. This compares released files with the new reproducible esbuild/terser build; it is **not** a same-minifier attribution of source savings. Source-only entries compare their old unminified import graphs with the new bundle. The new photo entry includes score search, async input and GPU integration that were separate before. License notices are included in the measured bundles. Old \`rapier\` becomes \`full\`; the broad still worker is replaced by focused capture/photo workers while full retains its advanced features. No sum of the table is a normal integrator download.

| Build | Before gzip B | After gzip B | Delta B |
|---|---:|---:|---:|
${deltaRows.join('\n')}

## Full HD and 4K comparisons

Opaque real snapdom scene: text/table UI, gradients, shadows and an embedded CC0 photo. Native libjxl 0.12.0 and wasm-vips 0.0.19 are versioned explicitly; jSquash 1.3.0 uses its own bundled libjxl. The optimized PNG is native oxipng 9.1.5, not a claimed browser download. Browser PNG/WebP incur no extra encoder payload. Native WebP lossless uses \`-lossless -exact -z6\`; canvas does not expose an explicit lossless WebP setting.

| Input | Codec | File B | Main cold / warm ms | Worker cold / warm ms | Peak RSS MiB main / worker | Native score |
|---|---|---:|---:|---:|---:|---:|
${headlineRows.join('\n')}

Browser-format rows and Node rows are separate runtimes; use them as environment-specific observations, not a pure language comparison. wasm-vips uses one thread and Cache.max(0). The 4K effort 7 row has one warm repeat: a separate repeated-queue diagnostic failed on its third encode with JxlEncoderAddImageFrame, even after cached operation graphs were released. Cold/first-warm successes and that limitation are both retained.

Reference payload: jSquash single-thread factory+WASM **529,987 gzip bytes**. wasm-vips JXL side module **798,402**; browser JS+base WASM+JXL **2,853,610**. These exclude unrelated decoders/HEIF modules. Tarball hashes, actual file sizes and versions are in [toolchain.json](${rawLink}toolchain.json).

### Browser capture path

Fresh page, first encode plus three repeats. No hardware GPU speed claim. Exact opaque captures also round-trip byte-for-byte through Chrome's native JXL decoder. On alpha captures, the codec preserves all source samples in djxl; canvas's native decode/readback rounds RGB at partial alpha. Alpha, opaque RGB and fully transparent RGB remain exact in the browser diagnostic. Do not describe that readback as universal byte equality.

| Input | Execution | JXL B | Cold / warm ms | Browser decode |
|---|---|---:|---:|---|
${captureRows.join('\n')}

### Bounded loss is explicit

\`maxError:2\` keeps alpha and fully transparent RGB exact and bounds every other RGB sample's change to 2. On the mixed scene it produces 188,133/491,250 bytes, with native scores 81.69/80.98. That is **not a visually-lossless promise**. FHD cjxl e7 matched 81.70 in 88,803 bytes and e9 matched 81.74 in 93,068. Lossless remains the default.

## Evidence and reproduction

[Node/native results](${rawLink}results.json), [browser results](${rawLink}browser-results.json), [module probes](${rawLink}module-probes.json), [matched-quality probes](${rawLink}module-matched.json), [capture matches](${rawLink}capture-matched.json), [source fixtures](${rawLink}fixtures/manifest.json). Every delivered exact file checked by the harness matches all decoded RGBA samples. JPEG probes reconstruct the original JPEG byte-for-byte through djxl and the JavaScript reconstruction API.

\`\`\`sh
npm install --ignore-scripts --package-lock=false
npm run build
node bench/capture/setup.mjs /tmp/rapier-capture-tools
mkdir -p /tmp/rapier-before
git archive 3d36f51c36843a7d2965af2f525504047aa2f8a3 src dist package.json | tar -x -C /tmp/rapier-before
node bench/capture/run.mjs --tools /tmp/rapier-capture-tools --baseline /tmp/rapier-before --out /tmp/capture-results --timeout 900000
node bench/capture/module-probes.mjs --tools /tmp/rapier-capture-tools --baseline /tmp/rapier-before --out /tmp/module-probes
node bench/capture/match.mjs /tmp/module-probes/module-probes.json --tools /tmp/rapier-capture-tools --out /tmp/module-matched --all-modules
node bench/capture/browser.mjs
\`\`\`

The original effort 9 searches take minutes at 4K. Browser scripts use Playwright/Chromium; see the snapdom example README for local serving and fixture regeneration. Sources: [snapdom pinned API](https://github.com/zumerlab/snapdom/tree/f7bb642d83ece9f6efdca0825ab87bb7b2274650), [libjxl 0.12.0](https://github.com/libjxl/libjxl/releases/tag/v0.12.0), [wasm-vips 0.0.19](https://www.npmjs.com/package/wasm-vips/v/0.0.19), [jSquash 1.3.0](https://www.npmjs.com/package/@jsquash/jxl/v/1.3.0).
`;
writeFileSync(resolve('docs/CAPTURE-AUDIT.md'), report);
console.log('Wrote docs/CAPTURE-AUDIT.md');
