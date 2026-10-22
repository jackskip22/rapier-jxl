// SPDX-License-Identifier: MIT
// Load original full-size graphics; every source and every RGBA byte sequence is pinned in the manifest.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {resolve, join} from 'node:path';
import {graphicsPixels} from '../test/graphics-cases.mjs';

export async function loadGraphicsCorpus(root) {
  const source = await readFile(new URL('./graphics-corpus-sources.json', import.meta.url));
  const manifest = JSON.parse(source), cases = [];
  for (const entry of manifest) {
    const rgba = entry.generator ? graphicsPixels({...entry, ...entry.generator})
      : entry.pixels ? new Uint8Array(gunzipSync(await readFile(new URL(entry.pixels, import.meta.url))))
      : new Uint8Array(await readFile(join(resolve(root), entry.id + '.rgba')));
    assert.equal(rgba.length, entry.width * entry.height * 4, entry.id + ' full dimensions');
    assert.equal(createHash('sha256').update(rgba).digest('hex'), entry.rgbaSha256, entry.id + ' original RGBA hash');
    cases.push({...entry, rgba});
  }
  return {cases, manifestSha256: createHash('sha256').update(source).digest('hex')};
}
