// SPDX-License-Identifier: MIT
// node bench/capture/audit.mjs ROOT OUTPUT.json
import {readFileSync, writeFileSync, existsSync, statSync} from 'node:fs';
import {resolve, dirname, relative} from 'node:path';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';

const root = resolve(process.argv[2] || '.'), out = resolve(process.argv[3] || 'bench/capture/module-audit.json');
const json = file => JSON.parse(readFileSync(resolve(root, file), 'utf8'));
const pkg = json('package.json'), sizes = json('dist/sizes.json');
const hash = b => createHash('sha256').update(b).digest('hex');
const measure = file => { const b = readFileSync(file); return {bytes: b.length, gzip: gzipSync(b, {level: 9}).length, sha256: hash(b)}; };

const capabilities = {
  index: 'RGBA: exact Modular; lossy Squeeze or DCT8/XYB at effort 1; 8/10/12/16-bit and floating samples; alpha, ICC/HDR declarations. No deep screen or photo search.',
  capture: 'RGBA8 capture: exact Modular/LZ77; optional bounded RGB error with exact alpha and hidden RGB; sync and async CPU/WebGPU fallback.',
  effort: 'Core plus lossless predictor/RCT/palette/screen/patch searches and photographic effort 1–9.',
  wasm: 'Effort plus embedded optional scalar/SIMD kernels; identical format and modes.',
  photo: 'Photographic DCT/XYB and ANS search at effort 1–9; quality 100 exact; native precision Modular; exact alpha.',
  'photo-advanced': 'Photo plus explicit VarDCT transforms, progressive passes and coefficient orders.',
  'photo-plan': 'Reusable photographic transform plan with encode and target-byte-budget encode methods.',
  noise: 'Photographic coding with optional generated photon noise.',
  'photo-noise': 'Photographic coding with optional generated photon noise.',
  score: 'Encode to an explicit SSIMULACRA2/Butteraugli target with CPU/GPU candidate measurement and quality search.',
  hybrid: 'Mixed exact Modular regions and lossy photographic layers.',
  graphics: 'Exact delta palettes or bounded-error palette/undither graphics.',
  icc: 'ICC profile preparation and profile-bearing still encoding.',
  opsin: 'Opsin transform preparation/wrapping; not an independent RGBA encoder.',
  'delta-palette': 'Exact or explicitly configured delta-palette Modular coding.',
  splines: 'Spline frame coding and drawing primitives.',
  channels: 'Lossless native samples with named/typed extra channels.',
  layers: 'Lossless layer/frame composition and blend modes.',
  patches: 'Patch dictionaries, exact repeated regions and patch compositions.',
  jpeg: 'JPEG coefficient transcoding and byte-exact JPEG reconstruction; not RGBA encoding or general JXL decoding.',
  'jpeg-ans': 'JPEG transcoding/reconstruction with ANS entropy search.',
  'photo-ans': 'Photographic encoder with ANS entropy search.',
  animation: 'Animated JPEG XL frames, timing and pixel/photographic modes.',
  'animation-atlas': 'Animated frames with shared reference atlas and patches.',
  metadata: 'Read/write Exif/XMP/JUMBF/container metadata; not a pixel codec.',
  brotli: 'Brotli for metadata; not a pixel codec.',
  container: 'JXL container framing/streaming; not a pixel codec.',
  'container-stream': 'JXL container framing/streaming; not a pixel codec.',
  'container-advanced': 'Container inspection, frame index and gain-map boxes; not a pixel codec.',
  'progressive-container': 'Progressive codestream/container delivery; not a pixel codec.',
  delivery: 'Group order and region delivery layout; not a pixel codec.',
  writer: 'Low-level bit/format writer plus lossless, lossy Squeeze and JPEG/VarDCT encoding kernels; probe uses encodeLossless.',
  source: 'Input samples/color-source preparation; not an encoder.',
  kernels: 'Optional embedded WASM arithmetic kernels; not an encoder.',
  image: 'Browser source/worker client; requires an encoder worker or injected encoder.',
  rapier: 'Complete encoder/worker engine, including animation, metadata, native/HDR, JPEG and GPU helpers.',
  full: 'Complete shared encoder/worker engine, including capture, photo, animation, metadata, native/HDR and JPEG.',
  'rapier-worker': 'Complete worker engine; same encoder features as rapier.',
  'rapier-still-worker': 'Still-image worker engine; no animation/atlas payload.',
  'capture-worker': 'Capture encoder and stable worker protocol.',
  'photo-worker': 'Photographic encoder and stable worker protocol.',
  'full-worker': 'Complete encoder and stable worker protocol.',
  'gpu-core': 'Optional photographic GPU kernels; not a standalone encoder.',
};

function graph(entry, dynamic = true) {
  const files = new Set();
  const visit = file => {
    if (files.has(file) || !existsSync(file)) return;
    files.add(file);
    if (!/\.(m?js)$/.test(file)) return;
    const text = readFileSync(file, 'utf8');
    const patterns = [/(?:\bfrom\s*|\bimport\s*)(['"])(\.[^'"]+)\1/g];
    if (dynamic) patterns.push(/\bimport\s*\(\s*(['"])(\.[^'"]+)\1/g);
    for (const pattern of patterns) for (const m of text.matchAll(pattern)) visit(resolve(dirname(file), m[2]));
  };
  visit(resolve(root, entry));
  return [...files].sort();
}

const stem = file => file.split('/').at(-1).replace(/\.(d\.)?m?js$/, '').replace(/\.min$/, '');
const moduleOf = door => door.module || ({'photo-entry': 'photo'}[stem(door.source || door.file)] || stem(door.source || door.file));
const doors = sizes.doors || [], allBuilds = new Map(doors.filter(d => d.file).map(d => [d.file, moduleOf(d)]));
for (const [key, value] of Object.entries(sizes)) if (value && typeof value === 'object' && value.file) {
  allBuilds.set(value.file, key === 'rapierWorker' ? 'rapier-worker' : key === 'rapierStillWorker' ? 'rapier-still-worker' : key === 'gpuCore' ? 'gpu-core' : key);
}
const exportRows = Object.entries(pkg.exports).map(([entry, value]) => {
  const file = typeof value === 'string' ? value : value.default || value.import;
  if (!file) return {entry, status: 'no runtime target'};
  const sourceName = stem(file), baseEntry = entry.replace(/\/min$/, '');
  const door = doors.find(d => d.entry === baseEntry || d.aliases?.includes(baseEntry) || d.file === file.replace(/^\.\//, ''));
  const buildFile = door?.file || (/^\.\/dist\//.test(file) ? file.slice(2) :
    entry === './core' || entry === './core/min' || entry === './min' ? 'dist/rapier-jxl.min.mjs' : null);
  const measuredFile = buildFile || file;
  const closure = graph(measuredFile), staticClosure = graph(measuredFile, false);
  const name = door ? moduleOf(door) : sourceName === 'rapier-jxl' ? 'index' : sourceName;
  return {entry, target: file, measuredFile, minified: !!buildFile, modes: capabilities[name] || (entry === './package.json' ? 'Package metadata; no runtime code.' : 'See declared exports; specialized format primitive.'),
    entryBytes: measure(resolve(root, measuredFile)),
    staticClosureGzip: staticClosure.reduce((sum, f) => sum + measure(f).gzip, 0),
    closureGzip: closure.reduce((sum, f) => sum + measure(f).gzip, 0),
    files: closure.map(f => relative(root, f)),
    dependencyNote: name === 'image' ? 'Adapter only. Add the selected worker/encoder bytes; this is not a 1 KB JPEG XL encoder.' : null};
});
const builds = [...allBuilds].map(([file, module]) => ({file, module, modes: capabilities[module] || '', ...measure(resolve(root, file)),
  closureGzip: graph(file).reduce((sum, f) => sum + measure(f).gzip, 0)}));
const result = {version: pkg.version, recordedSizesVersion: sizes.version, node: process.version,
  method: 'Actual file bytes; Node gzip level 9. Closure sums separately compressed imported files (static and optional dynamic); not a concatenated or tree-shaken estimate. Source-only entries are explicitly not minified.',
  exportCount: exportRows.length, exports: exportRows, builds};
writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({output: out, entries: exportRows.length, builds: builds.length}));
