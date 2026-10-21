# Reproducible complete-encoder measurements

This protocol measures the complete `createEncoder().encode()` API in pinned
Node and Chrome, and the public libjxl encoder at several efforts. It records
encoded bytes, time per megapixel, exactness, SSIMULACRA2, and Butteraugli. A
numeric Rapier quality is never treated as a libjxl quality or distance.

`ideal.mjs` writes machine-readable observations and actual quality-match
brackets. It does not turn missing observations into estimated benchmark rows.
Run the commands below against an immutable source directory for each release
or candidate. The harness also snapshots and hashes the complete local module
graph before importing it; edits made after that point cannot enter a run.
`--encoder` names the directory containing `rapier.mjs`, normally `src/` in
the published npm package. Timings cover that complete source-module API in
real Workers. Bundled distribution-worker startup can differ and should be
measured separately when choosing a deployment's helper threshold.

For a release comparison, obtain the actual npm tarball and verify its
registry integrity before extracting it. A matching version string in a
private source tree is not release-identity evidence. Preserve the tarball
URL, integrity value, digest, and module graph hashes with the measurements.

## Corpus and scope

`ideal-corpus-sources.json` pins every original URL, source SHA-256, prepared
sample SHA-256, dimensions, license, and color declaration. `ideal-corpus.mjs`
downloads and checks those originals, then prepares canonical raw buffers and
reference PNGs without using the encoder under test.

| Group | Inputs | Purpose |
| --- | --- | --- |
| Phone photograph | `phone-flower`, 2268 × 1512 | Google Pixel 6 photograph at the resolution distributed in the source corpus; full-image throughput and detail. |
| Phone crop | `phone-flower-crop`, 1024 × 1024 | Exact centered crop for iteration; shares the photograph above. |
| Photographs | `photo-keong`, `photo-ria`, `photo-bliznaca`, each 500 × 500 | Three different CC0 photographs distributed by libjxl's testdata project. |
| Application screenshots | `ui-gd-paint`, `ui-editor` | Real paint/editor screenshots, text, flat color, and mixed content. |
| Alpha graphics | `alpha-globe`, `alpha-isotiles` | Emoji and game tiles with straight alpha, including RGB beneath zero alpha. |
| Alpha photograph | `alpha-flower` | A derivative of the phone photograph with an alpha channel. |
| Line art | `graphics-splines`, 2048 × 2048 | Large sparse colored curves. |
| Scan | `scan-tenniel`, 2143 × 1760 | A real scanned public-domain engraving with fine lines and paper texture. |
| HDR | `hdr-room`, 676 × 449 | Native 16-bit Rec.2020 HLG samples and their color declaration. |

There are 13 inputs and 20,663,447 pixels. The phone crop and alpha photograph
are useful workloads, but are **not independent photographs**. There are four
independent photographic originals, two application screenshots, two alpha
graphics, one line-art image, one scan, and one HDR original. This is a compact
diagnostic corpus, not a representative estimate of all phone cameras, UI
designs, scans, or HDR content. Report per-image results and category results;
do not hide a regression behind a single pooled score. No input is enlarged or
generated synthetically.

SDR preparation preserves source sRGB sample values as straight RGBA8. No
resampling, premultiplication, hidden-RGB cleanup, orientation change, or
metadata-dependent color conversion occurs. Canonical PNGs intentionally omit
unrelated metadata. HDR preparation preserves RGBA16 samples as little-endian
integers and retains the source color chunks. Its descriptor is Rec.2020,
HLG, intensity target 1000. Do not score that image using the SDR metrics path
or pool it with SDR. The current HDR comparison is lossless sample exactness,
bytes, and time; a future perceptual HDR comparison needs an explicit display
and light-mapping protocol.

```sh
node bench/ideal-corpus.mjs --dir /tmp/jxl-ideal-corpus
# A later run can require the already verified cached downloads:
node bench/ideal-corpus.mjs --dir /tmp/jxl-ideal-corpus --offline
```

The helper supports `--ids id,id` to prepare a subset. A complete preparation
writes `manifest.json`, `downloads/`, `pixels/`, and `png/`. Use the manifest,
not an unrelated directory glob, as the input list.

## Pinned programs

Use Node **22.23.3**, Chrome for Testing **155.0.8059.39**, libjxl **0.12.0**,
and jxl-oxide-cli **0.12.6**. The harness rejects different Node, Chrome, and
decoder version strings and records the SHA-256 of every native program it
uses. Playwright is a launcher/transport only; point `--playwright` to its
`index.mjs` if it is not installed as a local dependency.

The measured Linux x86-64 libjxl tools come from the project's official static
release archive:

<https://github.com/libjxl/libjxl/releases/download/v0.12.0/jxl-linux-x86_64-static.tar.lz>

Archive SHA-256:
`5318a1ea40adad76d023e0c17a03d4627f8282f83cb2b575e69be8e74f1ff456`.
Extract it with a lzip-capable tar. The needed programs are `cjxl`, `djxl`,
`ssimulacra2`, and `butteraugli_main` in `tools/`. They report libjxl 0.12.0,
revision `4128790`, with AVX2/SSE4/SSE2 support. The independent Rust decoder
can be built reproducibly from its locked crate dependencies:

```sh
cargo +1.90.0 install jxl-oxide-cli --version 0.12.6 --locked --root /tmp/oxide
```

The repository's existing wasm decoder remains useful for its own checks.
This harness deliberately runs the native independent decoder as well as
libjxl. No result is admitted after merely round-tripping through Rapier's
own code.

## Runtime and timing rules

Run one heavy job at a time, with the machine idle as far as practical. On a
shared Linux host, wrap each invocation in
`flock /tmp/rapier-jxl-ideal-heavy.lock timeout 1800 ...`. Record the hardware,
OS, CPU affinity, source identity, exact command, and raw samples. The harness
writes these to `environment-*.json`, `plans.jsonl`, and `results.jsonl`.
Report medians together with the samples or their range; one timing sample is
exploratory evidence, not a stable speed claim.

The default is one unreported warm-up followed by three timed encodes for
each input/setting. Warm-up measurements are nevertheless saved. Each timed
Rapier encode uses a fresh input copy, prepared before the clock starts, in a
persistent coordinator Worker. Timing spans the complete awaited encode. It
includes the option handling, all selected transforms/search, output assembly,
and any helper startup, module import, copies, messages, and teardown performed
by the encoder. It excludes file loading, the initial coordinator import,
input preparation, output hashing, independent decoding, and perceptual
metrics. Coordinator startup/import is reported separately. Helpers are
started and stopped by the encoder on each job: this measures the actual API,
not an artificially persistent helper pool.

`--workers 0` permits no helper workers. `--workers 3` gives Rapier a budget of
three helpers plus its coordinator. Both use a real Worker in Chrome or
`worker_threads` in Node. The runtime reports helpers actually started, tasks
dispatched, and errors. A small job or a code path with no parallel
implementation can legitimately start zero helpers; label this as a request
that stayed serial. Never infer a parallel speedup from the flag alone. Node
CPU time includes the process's threads; Chrome CPU time is not claimed.

Libjxl is invoked as a fresh process for each warm-up and sample, with
`--num_reps=1`, `--num_threads=0` for serial or `--num_threads=4` for the parallel
budget, `--alpha_distance=0`, and `--keep_invisible=1`. Two timing fields are
saved:

* `ms` / `msPerMP`: encode time inferred from cjxl's reported, rounded MP/s.
  This is the closest available CLI measure of encoder work and carries that
  rounding limit.
* `processWallMs`: process launch, PNG input, encoding, and output writing.
  It must not be presented as an in-memory encode time.

The main Rapier/libjxl speed comparison must state that the timing boundaries
differ. Keep the process-wall observation available so an integration can
also evaluate the command-line workflow. Do not subtract an invented startup
constant. The output must repeat byte-for-byte across warm-ups and samples;
otherwise the harness stops.

## Exactness and perceptual quality

Every distinct result is decoded by `djxl` and `jxl-oxide`. Lossless rows
require all four source channels to match exactly, including RGB under zero
alpha and all 16 bits of the HDR samples. Lossy rows still require an exact
alpha channel and independent decoder samples within one level. Each row records each decoder's changed sample count, maximum
RGB difference, alpha changes, hidden-RGB changes, and the maximum difference
between the independent decoders.

For opaque SDR, SSIMULACRA2 and Butteraugli compare the source canonical PNG
with djxl's RGBA8 output. Higher SSIMULACRA2 is better; lower Butteraugli is
better. Alpha inputs are composited in **linear sRGB**, independently over
black and white, then converted back to sRGB8 for both tools. Both scores are
saved, and the worse score for each metric is used for matching. This prevents
invisible RGB from dominating a perceptual comparison while the separate
exactness check still protects alpha and lossless hidden RGB. No output is
resized, aligned, cropped, or filtered to improve its metric score.

Lossless rows use exactness rather than redundant perfect perceptual scores.
The harness does not establish JPEG reconstruction correctness: run the
package's independent JPEG reconstruction witnesses separately for any change
that can affect that path. An output hash is evidence about one complete
stream, not proof of general image fidelity.

## Quality curves and matching

The full Rapier matrix is qualities 60, 75, 85, 90, and 95 at efforts 1, 3, 7,
and 9. Photographic inputs explicitly set `photo: true`; other inputs exercise
the ordinary graphics route. The full lossless matrix uses efforts 1, 3, 7,
and 9 on every input, including HDR. A bounded run may select a subset, but
must publish the exact selected image IDs, efforts, qualities, runtimes,
worker budgets, and repeat count. Do not imply that unrun matrix cells passed.

Libjxl starts with measured distances 0.25, 0.5, 1, 2, 4, 8, 16, and 25 at
each requested effort. `--match path/to/rapier/results.jsonl` adds measured
points to match each reference row separately by SSIMULACRA2 and by
Butteraugli. For each metric the harness:

1. Finds two actual measured distances straddling the target.
2. Interpolates in log distance only to choose the next setting to encode.
3. Encodes, independently decodes, and scores that new setting.
4. Repeats until an actual observation is within 0.25 SSIMULACRA2 points, or
   within max(0.02, 2% of target) Butteraugli units, up to `--matchSteps`.

The result stores the actual nearest row and actual bracket endpoints.
`matched` means an observation met the tolerance; `bracketed` means the target
has measured bounds but the tolerance was not reached; `outside-measured-range`
means no valid measured bracket was found. Only `matched` rows justify a
matched-quality byte comparison. No size or time is obtained by interpolating
unmeasured encodes. Nonmonotonic curves are exposed by the saved points rather
than silently sorted by score.

The two metrics can prefer different distances. The report therefore needs
two matched-quality comparisons. `jointAtLeast` additionally records the
smallest *measured* libjxl output that meets both reference targets within
their tolerances. This is a discrete observed candidate, not proof of the
global optimum or a simultaneous exact match. Its `rapierByteRatio` is Rapier
bytes divided by those libjxl bytes. Equal numeric settings across encoders
have no matched-quality meaning.

## Commands

The examples assume the pinned executables are on `PATH`; replace directories
with local absolute paths. Run from the staged package root. Use separate
output directories per runtime/worker budget to make the reference selection
unambiguous.

```sh
node bench/ideal.mjs \
  --corpus /tmp/jxl-ideal-corpus --out /tmp/baseline-node \
  --encoder /tmp/release-4.2.1/src --label release-4.2.1 \
  --tools /tmp/libjxl-0.12.0/tools --oxide /tmp/oxide/bin/jxl-oxide \
  --runtime node --workers 0 --modes lossy \
  --ids phone-flower,phone-flower-crop,photo-keong,photo-ria,photo-bliznaca \
  --efforts 1,3,7,9 --qualities 60,75,85,90,95 --warmups 1 --repeats 3

node bench/ideal.mjs \
  --corpus /tmp/jxl-ideal-corpus --out /tmp/baseline-chrome-workers \
  --encoder /tmp/release-4.2.1/src --label release-4.2.1 \
  --tools /tmp/libjxl-0.12.0/tools --oxide /tmp/oxide/bin/jxl-oxide \
  --runtime chrome --chrome /tmp/chrome-linux64/chrome \
  --playwright /absolute/node_modules/playwright/index.mjs --workers 3 \
  --modes lossless --efforts 1,3,7,9 --warmups 1 --repeats 3

node bench/ideal.mjs \
  --corpus /tmp/jxl-ideal-corpus --out /tmp/libjxl-serial \
  --label libjxl-0.12.0 --tools /tmp/libjxl-0.12.0/tools \
  --oxide /tmp/oxide/bin/jxl-oxide --runtime libjxl --workers 0 \
  --modes lossy --ids phone-flower-crop,photo-keong,photo-ria,photo-bliznaca \
  --efforts 1,3,7,9 --distances 0.25,0.5,1,2,4,8,16,25 \
  --match /tmp/baseline-node/results.jsonl --matchSteps 7 \
  --warmups 1 --repeats 3
```

Repeat the same planned matrix for the candidate source directory and both
worker budgets. Re-run libjxl matching against the candidate reference rows if
output quality changes. If bytes remain identical, their existing measured
quality is still applicable, but timing must be measured on the changed
implementation. Compare hashes before making that claim.

`--options /path/options.json` adds explicit encoder options, for example
`{"filter":"off"}` for a controlled comparison. Those options become part of
the measurement identity. They cannot override matrix settings or source
sample/color descriptors. Record the options alongside any size or speed
claim.

## Results, resumption, and review

`results.jsonl` appends one complete observation only after both independent
decodes and the applicable quality checks succeed. `matches.jsonl` contains
measured quality matches. Encoded files, decoder PNGs, and alpha composites
are retained for inspection. Environment files identify source module hashes,
native binary hashes, harness hashes, runtime versions, hardware, and timing
boundaries. The exact harness files are also retained under `protocol/`.
Plan files preserve every invocation, including partial runs.

The row key includes the complete measurement identity, input ID, requested
settings, warm-up count, and repeat count. Repeating an identical command
resumes completed rows. Source changes, tool changes, or harness changes
produce a new identity and cannot reuse incompatible rows. Distinct identities
can coexist in one JSONL file; filter by identity when reporting. Preserve
raw evidence with every published summary. `complete-*.json` describes the
last completed invocation for that identity, not certification that every
possible protocol matrix cell was run.

Before changing a byte pin, inspect the new stream with both independent
decoders and run the relevant package/app witnesses. The benchmark supports
that review; it does not waive painting-save, recovery, Undo, JPEG
reconstruction, package staging, or worker-size checks.

`ideal-report.mjs DATASETS.json OUTPUT_DIRECTORY` generates `summary.json`
and a Markdown summary directly from completed rows. A minimal dataset file
is:

```json
{
  "datasets": {
    "release-node": "/tmp/baseline-node",
    "candidate-node": "/tmp/candidate-node",
    "libjxl": "/tmp/libjxl-serial"
  },
  "comparisons": [
    {"name": "Node serial", "before": "release-node", "after": "candidate-node"}
  ],
  "native": ["libjxl"],
  "referenceEffort": 7,
  "matchedImages": ["phone-flower-crop", "photo-keong", "photo-ria", "photo-bliznaca"]
}
```

Relative dataset paths resolve against that JSON file. A dataset containing
multiple measurement identities requires an explicit object
`{"path":"...","identityHash":"..."}`. Optional `workerComparisons` entries
name a `serial` and `parallel` dataset. The generator retains individual
before/after samples, output hashes through their row keys, actual worker
counts, metric changes, quality brackets, and coverage counts. Bracketed
targets never acquire a matched-quality size ratio. The main photographic
before/after aggregate excludes the phone crop so its original is not counted
twice; the full per-input observations remain available.

## Paired helper and distribution-worker measurements

Use `ideal-paired.mjs CONFIG.json OUTPUT_DIRECTORY` when choosing the helper
threshold. It alternates forward and reverse variant order, includes three
warmups and nine timed rounds by default, and records every sample. A fresh
coordinator starts for each image; helpers keep their production per-job
lifetime. It can compare complete source modules with the actual built classic
worker, whose import and startup costs differ. It snapshots both before running.

```json
{
  "corpus": "/tmp/jxl-ideal-corpus",
  "chrome": "/tmp/chrome-linux64/chrome",
  "playwright": "/absolute/node_modules/playwright-core/index.mjs",
  "images": ["phone-flower-crop", "phone-flower"],
  "efforts": [1, 7],
  "qualities": [85],
  "warmups": 3,
  "repeats": 9,
  "runtimes": ["node", "chrome"],
  "variants": [
    {"name": "source-serial", "source": "/tmp/candidate/src", "helpers": 0, "equalGroup": "candidate"},
    {"name": "source-helpers", "source": "/tmp/candidate/src", "helpers": 3, "equalGroup": "candidate"},
    {"name": "worker-serial", "worker": "/tmp/candidate/worker.js", "helpers": 0, "equalGroup": "candidate"},
    {"name": "worker-helpers", "worker": "/tmp/candidate/worker.js", "helpers": 3, "equalGroup": "candidate"}
  ]
}
```

Variant names must be unique. Add an immutable release source as a separate
variant for a paired before/after speed observation. `equalGroup` requires
identical complete output across its members, repeats, and runtimes; omit it
between versions that deliberately change reconstruction. Actual helper starts,
tasks, and errors are recorded. A requested helper budget that starts no helpers
remains a serial observation. No timing threshold is asserted by this runner.

Source timing spans the awaited complete encode API. Built-worker timing spans
its request handler through the final reply. Both include production helper
startup, messages, and teardown calls, and exclude the coordinator's initial
import, external transfer, hashing, and file work. Saved streams must still pass
the independent-decoder and native-browser checks; this timing runner does not
replace them. Keep the shared heavy-job lock and report the source and worker
results separately when their crossover differs.

## Final release, candidate, and native matrix

`ideal-finish-matrix.mjs CONFIG.json OUTPUT_DIRECTORY candidate` replays the
bounded final candidate matrix in Node and Chrome: five photo inputs at five
qualities and efforts 1/7, lossy UI/alpha/scan controls, exact lossless controls,
and explicit three-helper cases. The phone crop is not an independent photo.
The `native` phase matches the retained release and new candidate against
actual cjxl observations. It can reuse an immutable native measurement pool,
then freshly measures the chosen quality-85 matches in serial and, for the
phone/crop helper controls, with four native threads. Both
SSIMULACRA2 and Butteraugli remain separate matches.

The configuration supplies `encoder`, `corpus`, `tools`, `oxide`, `chrome`,
`playwright`, and the prior `releaseNode` dataset directory. Optional
`nativeSerialSeed` and `nativeParallelSeed` directories contain genuine earlier
`results.jsonl` observations of the identical tools, corpus and protocol;
omitting them performs the native measurements from scratch. `warmups` and
`repeats` default to 1 and 3. Paths resolve against the configuration file.
Use an immutable encoder snapshot and hold the shared heavy-job lock around
each phase. Commands, source snapshots, sample hashes and all raw results are
recorded for replay. No encoded or decoded bulk output belongs in Git.

`ideal-native.mjs --dataset DATASET --corpus CORPUS --out RECEIPT.json
--chrome CHROME --playwright PLAYWRIGHT` qualifies saved output through three
native Chrome APIs. It checks dimensions and exact alpha, and compares opaque
RGB to independent djxl reconstruction. It records rather than hides the
RGBA8 canvas limitations for partial alpha, hidden RGB and HDR precision.
This is separate from running the JavaScript encoder in Chrome.

`ideal-finish-report.mjs --summary RECEIPT_DIRECTORY` reads the compact files
listed by `index.json`, rechecks their decode and matching invariants, and
recalculates route changes, source/worker pairs and native quality comparisons.
Add `--check` to verify that the retained `summary.json` equals that calculation.
Bracketed and outside-range targets never acquire a matched-byte ratio.
The report keeps runtime and helper budgets separate; native cjxl is a host
CLI comparator and is never labeled as running inside Chrome.
