# SnapDOM core check

Runs SnapDOM's own checks and tests at zumerlab/snapdom `13b1f5c` with the patches in `patches/` applied in name
order, in Chromium, Firefox and WebKit. Logs are kept for one day as the run's artifacts.

`later/` holds the plugin patch. Move it into `patches/` once the `jpegxl` version it needs is on npm; the workflow
then refreshes the lockfile with `npm install`, since the patch changes the plugin's peer.
