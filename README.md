# SnapDOM core check

Runs SnapDOM's own checks and tests at zumerlab/snapdom `13b1f5c` with the patches in `patches/` applied in name
order, in Chromium, Firefox and WebKit. Logs are kept for one day as the run's artifacts.
Each engine first runs the whole suite on SnapDOM as released at that commit, then with the patches; the last step
(`scripts/compare.mjs`) lists the failures only the patched run has, and fails if there is one.

`later/` holds the plugin patch. Move it into `patches/` once the `jpegxl` version it needs is on npm; the workflow
then refreshes the lockfile with `npm install`, since the patch changes the plugin's peer.

The `bundlers` job installs `package/jpegxl.tgz` and the `rapier-jxl` pointer `package/rapier-jxl.tgz` together in
one Vite 7 app and one webpack 5 app, and checks that each build ships the encoder once, as a jpegxl-only build does
(`bundlers/both-names.mjs`).

The `flicker` job runs each test in `scripts/flicker-tests.txt` alone, ten times without and ten times with the
patches, in its engine, and prints the pass counts (`logs/flicker-<engine>.txt`).
