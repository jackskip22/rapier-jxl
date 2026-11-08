---
name: rapier-jxl
description: Convert PNG, JPEG and GIF files or folders to JPEG XL with npx rapier-jxl; JPEGs recompress losslessly and restore exactly. Node 20.16 or later.
---

# rapier-jxl CLI

```sh
npx rapier-jxl photo.png --json                       # photo.jxl beside it
npx rapier-jxl photos/ --out out/ --jobs 4 --json     # a folder, recursively, same layout
npx rapier-jxl hero.png --max-bytes 100KB --json      # fit under a byte budget
npx rapier-jxl photo.jxl --out photo.jpg              # the original JPEG
```

Options: `--quality 1-100` (default 90; JPEGs default to lossless recompression), `--effort 1-9` (default 7),
`--lossless`, `--max-bytes`, `--out`, `--jobs 0-16`.

Originals are never changed and automatic names never overwrite. A rerun skips finished files. One failure does not stop
the rest; the exit code is 1 if any file failed.

## `--json`

One JSON object per file, then a summary. Nothing else goes to stdout.

```json
{"type":"file","input":"photos/a.jpg","output":"out/a.jxl","inputBytes":204800,"outputBytes":163840,"kept":"jpeg-bytes","quality":null,"effort":7,"ms":120,"skipped":false}
{"type":"file","input":"photos/b.png","output":"out/b.jxl","ms":3,"error":{"code":"JXL_INPUT","message":"\"photos/b.png\" does not have a valid PNG signature.","hint":"verify that \"photos/b.png\" is an undamaged PNG file."}}
{"type":"summary","files":2,"written":1,"skipped":0,"failed":1,"inputBytes":204800,"outputBytes":163840,"ms":130}
```

`kept`: `jpeg-bytes` (the original JPEG, restorable), `pixels` (lossless), or `lossy` (at `quality`). `error.hint` is the fix.
`skipped: true`: the output already existed unchanged.
