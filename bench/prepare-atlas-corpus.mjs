// SPDX-License-Identifier: MIT
// Reuse the independent Pillow/Chromium corpus preparer for a real GIF and two browser-rendered screen sources.
// Usage: node prepare-atlas-corpus.mjs <output> [verified-earth.gif]
// Set CHROMIUM_PATH and PLAYWRIGHT_ROOT as required by animation-corpus.mjs.
import {readFile, writeFile, mkdir, mkdtemp, cp, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';

const output = resolve(process.argv[2] || 'atlas-corpus'), supplied = process.argv[3], execute = promisify(execFile);
const sources = JSON.parse(await readFile(new URL('./animation-sources.json', import.meta.url), 'utf8')).sources
  .filter(source => ['gif-earth', 'screen-typing', 'screen-ui'].includes(source.name));
await mkdir(output, {recursive: true});
const cache = join(output, 'downloads'); await mkdir(cache, {recursive: true});
if (supplied) {
  const earth = sources.find(source => source.name === 'gif-earth'), bytes = await readFile(supplied);
  if (createHash('sha256').update(bytes).digest('hex') !== earth.sha256) throw new Error('The supplied Earth GIF does not match the animation corpus pin.');
  await cp(supplied, join(cache, decodeURIComponent(earth.url.split('/').at(-1))));
}
const temporary = await mkdtemp(join(tmpdir(), 'atlas-corpus-preparer-'));
try {
  const source = await readFile(new URL('./animation-corpus.mjs', import.meta.url));
  await writeFile(join(temporary, 'animation-corpus.mjs'), source);
  await writeFile(join(temporary, 'animation-sources.json'), JSON.stringify({sources}));
  const result = await execute(process.execPath, [join(temporary, 'animation-corpus.mjs'), output, '--cache', cache], {timeout: 180000, maxBuffer: 1048576});
  const rows = [];
  for (const entry of sources) {
    const metadata = JSON.parse(await readFile(join(output, entry.name + '.json'), 'utf8'));
    const bytes = await readFile(join(output, entry.name + '.rgba'));
    if (bytes.length !== metadata.width * metadata.height * 4 * metadata.durations.length ||
        createHash('sha256').update(bytes).digest('hex') !== metadata.sha256) throw new Error('Prepared animation does not match its manifest.');
    rows.push({...entry, ...metadata});
  }
  const receipt = {preparerSha256: createHash('sha256').update(source).digest('hex'), rows,
    earthAttribution: {author: 'Marvel', license: 'CC BY-SA 3.0', url: 'https://commons.wikimedia.org/wiki/File:Rotating_earth_(large).gif',
      preparation: 'Pillow full-canvas RGBA composition, no resizing; source image license remains separate from MIT code.'}};
  await writeFile(join(output, 'atlas-corpus.json'), JSON.stringify(receipt, null, 2) + '\n');
  process.stdout.write(result.stdout); process.stdout.write(JSON.stringify({prepared: rows.length, output}) + '\n');
} finally { await rm(temporary, {recursive: true, force: true}); }
