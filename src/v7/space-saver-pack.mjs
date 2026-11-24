// SPDX-License-Identifier: MIT
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {COMMAND, importsAs} from './package-name.mjs';
import {cliError as fail} from './cli-error.mjs';

export async function readPackedSpaceSaver(own = 'rapier-jxl', rootDir = null) {
  let dir = rootDir;
  if (!dir) {
    for (const url of [new URL('../examples/emdash/', import.meta.url), new URL('./examples/emdash/', import.meta.url)]) {
      try {
        const candidate = fileURLToPath(url);
        await readFile(join(candidate, 'space-saver.mjs'), 'utf8');
        dir = candidate;
        break;
      } catch {}
    }
    if (!dir) throw fail('JXL_SETUP', 'package: incomplete', `reinstall: ${COMMAND}`);
  }
  const [digestSrc, cacheSrc, saverSrc] = await Promise.all([
    readFile(join(dir, 'digest.mjs'), 'utf8'),
    readFile(join(dir, 'original-cache-workers.mjs'), 'utf8'),
    readFile(join(dir, 'space-saver.mjs'), 'utf8'),
  ]);
  const cleanCache = cacheSrc.replace(/^import \{digest\} from '\.\/digest\.mjs';\r?\n/m, '');
  const cleanSaver = saverSrc
    .replace(/^import \{digest\} from '\.\/digest\.mjs';\r?\n/m, '')
    .replace(/^import \{originalWorkerCache\} from '\.\/original-cache-workers\.mjs';\r?\n/m, '')
    .replace(/^export \{digest, originalWorkerCache\};\r?\n\r?\n?/m, '');
  const saverHeaderEnd = cleanSaver.indexOf('\n\n') + 2;
  const combined = cleanSaver.slice(0, saverHeaderEnd) +
    digestSrc.trim() + '\n\n' +
    cleanCache.trim() + '\n\n' +
    cleanSaver.slice(saverHeaderEnd);
  return importsAs(combined, own);
}
