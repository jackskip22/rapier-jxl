---
name: rapier-jxl
description: Use when a task needs smaller pictures on disk or for the web. Converts PNG, JPEG and GIF files or whole folders to JPEG XL (.jxl) from a shell with npx rapier-jxl, and restores the original JPEG byte for byte. Node 20.16 or later; no other install.
---

# JPEG XL from the command line

Use `npx rapier-jxl` when pictures should take less space: a site's images, a photo folder, screenshots, an archive of
JPEGs. A JPEG is recompressed losslessly by default and can be restored exactly.

## One file

```sh
npx rapier-jxl photo.png --json
```

Writes `photo.jxl` beside it. `--quality 1-100` (default 90), `--lossless`, `--max-bytes 100KB`, `--out <file>`.

## A folder

```sh
npx rapier-jxl photos/ --out photos-jxl/ --jobs 4 --json
```

Every PNG, JPEG and GIF in the folder and its subfolders, in the same layout under `--out`.

- Automatic names never replace a file, and originals are never changed. An explicit `--out <file>` replaces that file.
- Rerun the same command after an interruption: finished files are left as they are, and the rest are written.
- One bad file does not stop the rest. The exit code is 1 when any file failed.

## Reading `--json`

stdout holds one JSON object per line and nothing else: one per file as it finishes, then one summary.

```json
{"type":"file","input":"photos/a.jpg","output":"photos-jxl/a.jxl","inputBytes":204800,"outputBytes":163840,"kept":"jpeg-bytes","quality":null,"effort":7,"ms":120,"skipped":false}
{"type":"file","input":"photos/b.png","output":"photos-jxl/b.jxl","ms":3,"error":{"code":"JXL_INPUT","message":"\"photos/b.png\" does not have a valid PNG signature.","hint":"verify that \"photos/b.png\" is an undamaged PNG file."}}
{"type":"summary","files":2,"written":1,"skipped":0,"failed":1,"inputBytes":204800,"outputBytes":163840,"ms":130}
```

`kept` says what the .jxl keeps:

- `jpeg-bytes`: the original JPEG, byte for byte.
- `pixels`: every pixel exactly (`--lossless` or `--quality 100`).
- `lossy`: a close picture at `quality`.

On failure, `error.hint` is the fix. `skipped: true` means the output was already there with the same bytes, so it was not written.

## Restore a JPEG

```sh
npx rapier-jxl photo.jxl --out photo.jpg
```

Gives back the exact original JPEG when `kept` was `jpeg-bytes`. Other files decode to PNG: `--out photo.png`.
