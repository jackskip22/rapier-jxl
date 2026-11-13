# SnapDOM core check

Runs SnapDOM's own checks and tests at zumerlab/snapdom `13b1f5c` with the patches in `patches/` applied in name
order, in Chromium, Firefox and WebKit. Logs are kept for one day as the run's artifacts.
Each engine first runs the whole suite on SnapDOM as released at that commit, then with the patches; the last step
(`scripts/verdict.mjs`) lists the failures only the patched run has and runs each alone thirty times with the patches
and thirty times without. It calls a test ours only when it fails alone in at least five more of the thirty runs
with the patches, and fails only then; otherwise flaky. Every count is passes: "passes 29/30".
The patches' test file removes every element it adds after each test. Every list, count and table row is also a
`::notice` annotation, readable from the run's checks without a token.

`later/` holds the plugin patch. Move it into `patches/` once the `jpegxl` version it needs is on npm; the workflow
then refreshes the lockfile with `npm install`, since the patch changes the plugin's peer.

The `bundlers` job installs `package/jpegxl.tgz` and the `rapier-jxl` pointer `package/rapier-jxl.tgz` together in
one Vite 7 app and one webpack 5 app, and checks that each build ships the encoder once, as a jpegxl-only build does
(`bundlers/both-names.mjs`).

The `flicker` job runs each test in `scripts/flicker-tests.txt` alone, ten times without and ten times with the
patches, in its engine, and prints the pass counts (`logs/flicker-<engine>.txt`).

The `plugin` job applies `patches/` and `later/`, installs the encoder from `package/`, runs the plugin's tests, then
`plugin/zz-measure.test.js`: seven pages with text over a NASA photograph (`plugin/photos/`, public domain) and one
control page without a photograph, at DPR 1 and 2. Each page is exported by the plugin as released and by the plugin
with the patches, with the same encoder at its default effort. `scripts/measure-summary.mjs` prints one row a page:
bytes before and after, median time of three exports, wrong text samples (text samples the decoded file does not
reproduce exactly), and N, the median size saving on the pages with text over a photograph.

The `order` job runs the whole suite on the unpatched commit, then with the patches but without the test file they
add, and says in one `order <engine>` notice whether both fail the same tests by name. Equal reruns alone do not rule
out an interaction that only the whole suite shows, so the whole-suite comparison stays beside them. The tests cover
mostly canvas exports; they are not a matrix of every exporter.

Every comparison above runs the unpatched suite first. Two controls separate the patches from the run order: `aa`
runs the unpatched suite twice in one clone (any difference is the order), and `swap` runs the patched suite first
and the unpatched second. Each says in one notice whether the two runs fail the same tests by name.
