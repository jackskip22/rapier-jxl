# Complete worker comparison inputs

Exact RGBA8 samples used in the complete-worker lossless comparison. `manifest.json` records dimensions and SHA-256 hashes. Unpack before running either encoder:

```sh
gzip -dk test/complete-corpus/*.rgba.gz
```

The UI, drawing, terminal and painting fixtures are Rapier test images, available under the repository MIT license. The Grace Hopper photograph is by James S. Davis, United States Navy, in the public domain; see [the original and license](https://commons.wikimedia.org/wiki/File:Grace_Hopper.jpg). Its decoded RGBA samples are preserved without resizing.

These fixtures are development inputs; the npm package excludes `test/`.
